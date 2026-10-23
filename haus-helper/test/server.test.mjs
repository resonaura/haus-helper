import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { createApi } from "../lib/server.mjs";
async function fixture(t, recorderOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "haus-api-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "db.sqlite"), media);
  const camera = {
    id: "camera.test",
    enabled: true,
    available: true,
    sensors: [],
  };
  const server = createApi({
    config: {
      standalone: true,
      apiToken: "test-token",
      recording_enabled: true,
      max_storage_gb: 10,
      retention_days: 7,
    },
    ha: { connected: true },
    store,
    recorder: {
      status: () => [],
      trigger: () => ({ id: "pending" }),
      ...recorderOverrides,
    },
    getRegistry: () => ({
      cameras: [
        { ...camera, talkback: store.overrides()[camera.id]?.talkback },
      ],
      states: [],
    }),
    refresh: async () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { base, store, headers: { Authorization: "Bearer test-token" } };
}
test("requires authentication and never returns internal credentials in status", async (t) => {
  const { base, headers } = await fixture(t);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const status = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes("test-token"));
  assert.equal(
    (await fetch(`${base}/api/events?camera_id=../../secret`, { headers }))
      .status,
    400,
  );
});
test("async preparation polls respond before encoding ends and coalesce repeated requests", async (t) => {
  let complete;
  const work = new Promise((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const { base, store, headers } = await fixture(t, {
    preparePlayback: async (event) => {
      calls++;
      await work;
      store.setPlayback(event.id, 100, 4, { duration: 2 });
    },
  });
  t.after(() => complete());
  const event = store.create("camera.test", "motion", 1000, 3000);
  store.finish(event.id, { bytes: 10, duration: 2 });
  const url = `${base}/api/events/${event.id}/prepare`;
  const poll = () =>
    fetch(url, {
      headers: { ...headers, "X-Haus-Async-Prepare": "1" },
      signal: AbortSignal.timeout(3000),
    });
  for (let i = 0; i < 3; i++) {
    const response = await poll();
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      status: "preparing",
      retryAfterMs: 1000,
    });
  }
  assert.equal(calls, 1);
  complete();
  await work;
  const response = await poll();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).playbackVersion, 4);
  assert.equal(calls, 1);
});
test("legacy preparation waits for completion without requiring the polling header", async (t) => {
  let complete;
  const work = new Promise((resolve) => {
    complete = resolve;
  });
  const { base, store, headers } = await fixture(t, {
    preparePlayback: () => work,
  });
  t.after(() => complete());
  const event = store.create("camera.test", "motion", 1000, 3000);
  store.finish(event.id, { bytes: 10, duration: 2 });
  const pending = fetch(`${base}/api/events/${event.id}/prepare`, { headers });
  complete();
  assert.equal((await pending).status, 200);
});
test("streams authenticated seekable ranges with precise content lengths", async (t) => {
  const { base, store, headers } = await fixture(t);
  const event = store.create("camera.test", "motion", 1000, 3000);
  await writeFile(store.path(event.id), "0123456789");
  store.finish(event.id, { bytes: 10, duration: 2 });
  const response = await fetch(`${base}/api/events/${event.id}/video`, {
    headers: { ...headers, Range: "bytes=3-6" },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 3-6/10");
  assert.equal(await response.text(), "3456");
  assert.equal(
    (
      await fetch(`${base}/api/events/${event.id}/video`, {
        headers: { ...headers, Range: "bytes=30-" },
      })
    ).status,
    416,
  );
});
test("rejects cross-site form writes and validates detector overrides", async (t) => {
  const { base, headers } = await fixture(t);
  const bad = await fetch(`${base}/api/cameras/camera.test/record`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(bad.status, 400);
  const invalid = await fetch(`${base}/api/cameras/camera.test`, {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Haus-Client": "1",
    },
    body: JSON.stringify({ sensorIds: ["binary_sensor.unrelated"] }),
  });
  assert.equal(invalid.status, 400);
});

test("returns camera availability even on a day with no motion clips", async (t) => {
  const { base, store, headers } = await fixture(t);
  store.observeAvailability("camera.test", "offline", 1000);
  store.observeAvailability("camera.test", "online", 5000);
  const page = await (
    await fetch(`${base}/api/events?camera_id=camera.test&from=2000&to=4000`, {
      headers,
    })
  ).json();
  assert.deepEqual(page.events, []);
  assert.deepEqual(page.availability, [
    { cameraId: "camera.test", startAt: 2000, endAt: 4000, state: "offline" },
  ]);
});

test("calendar validates bounded local-day ranges and paged direction", async (t) => {
  const { base, store, headers } = await fixture(t);
  const event = store.create("camera.test", "motion", 2000, 3000);
  store.finish(event.id, { duration: 1, bytes: 1 });
  const response = await fetch(
    `${base}/api/events/calendar?camera_id=camera.test&boundaries=1000,2000,4000`,
    { headers },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { days: [2000] });
  for (const path of [
    "/api/events/calendar?camera_id=camera.test&boundaries=3000,2000",
    "/api/events/calendar?camera_id=../../secret&boundaries=1000,2000",
    "/api/events?direction=arbitrary",
  ]) {
    assert.equal((await fetch(base + path, { headers })).status, 400);
  }
});

test("original recording reads stay authenticated and bypass compatibility encoding", async (t) => {
  let prepared = 0;
  const { base, store, headers } = await fixture(t, {
    preparePlayback: async () => {
      prepared++;
      throw new Error("should_not_encode");
    },
  });
  const event = store.create("camera.test", "motion", 1000, 3000);
  await writeFile(store.path(event.id), "original-camera-media");
  store.finish(event.id, { bytes: 21, duration: 2 });
  const url = `${base}/api/events/${event.id}/original`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, {
    headers: { ...headers, Range: "bytes=0-7" },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "original");
  assert.equal(prepared, 0);
  assert.equal(store.get(event.id).playbackVersion, 0);
});

test("custom microphone credentials never enter public camera responses", async (t) => {
  const { base, headers, store } = await fixture(t);
  const talkback = {
    url: "rtmp://fixture:private-camera-password@192.168.1.20/custom/talk",
  };
  const response = await fetch(base + "/api/cameras/camera.test", {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Haus-Client": "1",
    },
    body: JSON.stringify({ talkback }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(store.overrides()["camera.test"].talkback, talkback);
  assert.equal(
    JSON.stringify(await response.json()).includes("private-camera-password"),
    false,
  );
  const cameras = await (
    await fetch(base + "/api/cameras", { headers })
  ).json();
  assert.equal(
    JSON.stringify(cameras).includes("private-camera-password"),
    false,
  );
});

test("explicit recording repair is authenticated, coalesced across POST polls and returns a preserved-copy marker", async (t) => {
  let complete,
    calls = 0,
    passedOptions;
  const pending = new Promise((resolve) => {
    complete = resolve;
  });
  const { base, store, headers } = await fixture(t, {
    preparePlayback: async (event, _priority, options) => {
      calls++;
      passedOptions = options;
      await pending;
      store.setPlayback(event.id, 100, 4, {
        compatibilityRepaired: true,
        originalCompatible: false,
      });
    },
  });
  t.after(() => complete());
  const event = store.create("camera.test", "motion", 1000, 3000);
  store.finish(event.id, { bytes: 20, duration: 2, playbackVersion: 4 });
  store.setPlayback(event.id, 0, 4, { originalCompatible: true });
  const url = `${base}/api/events/${event.id}/repair`;
  assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 401);
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: "{}" })).status,
    400,
  );
  const options = {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Haus-Client": "1",
    },
    body: "{}",
  };
  for (let i = 0; i < 3; i++) {
    const response = await fetch(url, options);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      status: "preparing",
      retryAfterMs: 1000,
    });
  }
  assert.equal(calls, 1);
  assert.equal(passedOptions.forceCompatibility, true);
  complete();
  await pending;
  const ready = await fetch(url, options);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).playbackInfo.compatibilityRepaired, true);
  assert.equal((await fetch(url, options)).status, 200);
  assert.equal(calls, 1);
  assert.equal(
    (await fetch(url, { ...options, body: '{"path":"private"}' })).status,
    400,
  );
  const status = await (await fetch(`${base}/api/status`, { headers })).json();
  assert.equal(status.features.recordingRepair, true);
});
