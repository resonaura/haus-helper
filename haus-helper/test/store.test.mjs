import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { parseRange } from "../lib/media.mjs";
import { validateOptions } from "../lib/config.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-store-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "db.sqlite"), media);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return store;
}
test("paginates deterministically across equal timestamps and filters by detection type", async (t) => {
  const store = await fixture(t);
  for (let i = 0; i < 4; i++)
    store.create(
      "camera.entry",
      i % 2 ? "person" : "motion",
      1000,
      3000,
      "binary_sensor.entry",
    );
  const first = store.list({ limit: 2 });
  assert.equal(first.events.length, 2);
  const second = store.list({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.events.length, 2);
  assert.equal(
    new Set([...first.events, ...second.events].map((e) => e.id)).size,
    4,
  );
  assert.equal(second.nextCursor, null);
  assert.equal(store.list({ kind: "person" }).events.length, 2);
  assert.throws(() => store.list({ cursor: "bad" }), /invalid_cursor/);
});
test("combines overlapping activity into one event with multiple object labels", async (t) => {
  const store = await fixture(t);
  const event = store.create("camera.entry", "motion", 1000, 3000);
  const extended = store.extend(
    event.id,
    "pet",
    2000,
    4000,
    "binary_sensor.pet",
  );
  assert.deepEqual(extended.kinds, ["motion", "pet"]);
  assert.equal(extended.endAt, 4000);
  assert.equal(extended.detections.length, 2);
  store.finish(event.id, { duration: 3, bytes: 100 });
  assert.equal(store.get(event.id).videoUrl, `api/events/${event.id}/video`);
  assert.equal(store.totals().bytes, 100);
});
test("playable paging is not buried by recent failed capture attempts", async (t) => {
  const store = await fixture(t);
  const first = store.create("camera.entry", "motion", 1000, 3000);
  store.finish(first.id, { duration: 2, bytes: 10 });
  for (let index = 0; index < 130; index++) {
    const failed = store.create(
      "camera.entry",
      "motion",
      4000 + index,
      5000 + index,
    );
    store.finish(failed.id, { status: "failed" });
  }
  assert.equal(
    store
      .list({ cameraId: "camera.entry", limit: 100 })
      .events.some((event) => event.status === "ready"),
    false,
  );
  assert.deepEqual(
    store
      .list({ cameraId: "camera.entry", status: "ready" })
      .events.map((event) => event.id),
    [first.id],
  );
});
test("retention only removes expired completed events, preserving in-progress recordings", async (t) => {
  const store = await fixture(t);
  const old = store.create("camera.entry", "motion", 0, 1000);
  const active = store.create("camera.entry", "motion", 0, 1000);
  const recent = store.create(
    "camera.entry",
    "motion",
    86400000 * 9,
    86400000 * 9 + 1000,
  );
  for (const event of [old, recent]) {
    await writeFile(store.path(event.id), "test");
    store.finish(event.id, { bytes: 4 });
  }
  await store.prune({ retention_days: 7, max_storage_gb: 1 }, 86400000 * 10);
  assert.equal(store.get(old.id), undefined);
  assert.equal(store.get(active.id).status, "recording");
  assert.equal(store.get(recent.id).status, "ready");
  assert.throws(() => store.path("../../secret"), /invalid_event_id/);
});
test("handles byte range seeks and rejects unsatisfiable or multiple ranges", () => {
  assert.deepEqual(parseRange("bytes=10-19", 100), {
    start: 10,
    end: 19,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=-10", 100), {
    start: 90,
    end: 99,
    partial: true,
  });
  assert.deepEqual(parseRange("bytes=95-", 100), {
    start: 95,
    end: 99,
    partial: true,
  });
  for (const range of [
    "bytes=100-",
    "bytes=20-10",
    "bytes=0-1,5-9",
    "bytes=-0",
  ])
    assert.throws(() => parseRange(range, 100), /invalid_range/);
});
test("enforces storage and recording bounds", () => {
  assert.equal(validateOptions({}).pre_roll_seconds, 8);
  for (const options of [
    { retention_days: 0 },
    { max_event_seconds: 301 },
    { pre_roll_seconds: 31 },
    { recording_enabled: "yes" },
  ])
    assert.throws(() => validateOptions(options), /Invalid/);
});

test("Eufy endpoints reject public hosts disguised as private IPs", () => {
  for (const eufy_ws_url of [
    "ws://192.168.example.com:3000",
    "ws://10.example.com:3000",
    "ws://8.8.8.8:3000",
    "ws://user:secret@localhost:3000",
  ])
    assert.throws(() => validateOptions({ eufy_ws_url }), /Invalid/);
  assert.equal(
    validateOptions({ eufy_ws_url: "ws://192.168.4.44:3000" }).eufy_ws_url,
    "ws://192.168.4.44:3000/",
  );
});

test("availability records actual transitions, clips day boundaries and leaves unobserved restart gaps", async (t) => {
  const store = await fixture(t);
  store.observeAvailability("camera.entry", "online", 1000);
  store.observeAvailability("camera.entry", "online", 11000);
  store.observeAvailability("camera.entry", "offline", 16000);
  store.observeAvailability("camera.entry", "offline", 26000);
  store.observeAvailability("camera.entry", "online", 31000);
  store.observeAvailability("camera.other", "offline", 2000);
  assert.deepEqual(
    store.availability({ cameraId: "camera.entry", from: 5000, to: 30000 }),
    [
      {
        cameraId: "camera.entry",
        startAt: 5000,
        endAt: 16000,
        state: "online",
      },
      {
        cameraId: "camera.entry",
        startAt: 16000,
        endAt: 30000,
        state: "offline",
      },
    ],
  );
  store.observeAvailability("camera.entry", "online", 100000);
  const periods = store.availability({ cameraId: "camera.entry", to: 110000 });
  assert.equal(periods.at(-2).endAt, 31000);
  assert.equal(periods.at(-1).startAt, 100000);
  assert.equal(periods.filter((item) => item.state === "offline").length, 1);
  // A stale HA event cannot move the observation clock backwards.
  store.observeAvailability("camera.entry", "offline", 30000);
  assert.deepEqual(
    store.availability({ cameraId: "camera.entry", to: 110000 }),
    periods,
  );
});

test("pages both ways through equal timestamps without skipping or replaying clips", async (t) => {
  const store = await fixture(t);
  for (let i = 0; i < 7; i++)
    store.create("camera.entry", "motion", 1000 + Math.floor(i / 2), 4000);
  const all = store.list({ cameraId: "camera.entry", limit: 20 }).events;
  const first = store.list({ cameraId: "camera.entry", to: 1001, limit: 2 });
  const newer = store.list({
    cameraId: "camera.entry",
    cursor: first.newestCursor,
    direction: "newer",
    limit: 2,
  });
  const last = store.list({
    cameraId: "camera.entry",
    cursor: newer.nextCursor,
    direction: "newer",
    limit: 2,
  });
  const loaded = [...first.events, ...newer.events, ...last.events];
  assert.equal(new Set(loaded.map((event) => event.id)).size, loaded.length);
  assert.deepEqual(
    loaded.map((event) => event.id).sort(),
    all
      .slice(0, 5)
      .map((event) => event.id)
      .sort(),
  );
  assert.equal(last.nextCursor, null);
});

test("calendar marks only ready footage and respects caller-local daylight-saving boundaries", async (t) => {
  const store = await fixture(t);
  const boundaries = [
    Date.UTC(2026, 2, 7, 8),
    Date.UTC(2026, 2, 8, 8),
    Date.UTC(2026, 2, 9, 7),
    Date.UTC(2026, 2, 10, 7),
  ];
  for (const at of [
    boundaries[0] - 1,
    boundaries[1],
    boundaries[2] - 1,
    boundaries[3],
  ]) {
    const event = store.create("camera.entry", "motion", at, at + 1000);
    store.finish(event.id, { bytes: 1, duration: 1 });
  }
  store.create("camera.entry", "motion", boundaries[2], boundaries[2] + 1000);
  const other = store.create(
    "camera.other",
    "motion",
    boundaries[0],
    boundaries[0] + 1000,
  );
  store.finish(other.id, { bytes: 1 });
  assert.deepEqual(
    store.recordedDays({ cameraId: "camera.entry", boundaries }),
    [boundaries[1]],
  );
});

test("recording policy migration preserves known cameras, explicit opt-outs and future stream-only defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "haus-policy-"));
  const database = join(root, "db.sqlite");
  let store = new Store(database, root);
  try {
    store.observeAvailability("camera.old", "online", 1000);
    store.observeAvailability("camera.opted_out", "online", 1000);
    store.setCamera("camera.old", { sensorIds: [] });
    store.setCamera("camera.opted_out", { enabled: false });
    // Simulate the pre-migration schema while preserving its observations/settings.
    store.db.exec("DELETE FROM migrations");
    store.close();
    store = new Store(database, root);
    assert.deepEqual(store.overrides()["camera.old"], {
      sensorIds: [],
      enabled: true,
    });
    assert.equal(store.overrides()["camera.opted_out"].enabled, false);
    store.observeAvailability("camera.new", "online", 2000);
    store.close();
    store = new Store(database, root);
    assert.equal(store.overrides()["camera.new"], undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
