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
