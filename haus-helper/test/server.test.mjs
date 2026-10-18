import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { createApi } from "../lib/server.mjs";
async function fixture(t) {
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
    recorder: { status: () => [], trigger: () => ({ id: "pending" }) },
    getRegistry: () => ({ cameras: [camera], states: [] }),
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
