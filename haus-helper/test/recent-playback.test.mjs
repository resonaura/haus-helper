import { test } from "node:test";
import assert from "node:assert/strict";
import { RecentPlayback } from "../lib/recent-playback.mjs";
import { Store } from "../lib/store.mjs";
function fixture(t) {
  let at = 100000;
  const events = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    cameraId: i < 3 ? "camera.a" : "camera.b",
    playbackVersion: 0,
  }));
  const calls = [];
  const store = new Store(":memory:", "/unused-media");
  t.after(() => store.close());
  for (const [i, event] of events.entries())
    store.db
      .prepare(
        "INSERT INTO events(id,camera_id,start_at,end_at,status,kinds,detections,playback_version)VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        event.id,
        event.cameraId,
        1000 - i,
        3000 - i,
        "ready",
        "[]",
        "[]",
        0,
      );
  const recorder = {
    playbackJobs: new Map(),
    encoding: { pending: [] },
    cameras: ["camera.a", "camera.b"].map((id) => ({
      id,
      enabled: true,
      available: true,
    })),
    preparePlayback: async (event, priority, options) => {
      calls.push({ id: event.id, priority, options });
      store.db
        .prepare("UPDATE events SET playback_version=4 WHERE id=?")
        .run(event.id);
    },
  };
  const cluster = { canPreparePlayback: () => true };
  const recent = new RecentPlayback(store, recorder, cluster, () => at);
  return {
    events,
    store,
    calls,
    recorder,
    cluster,
    recent,
    advance: (ms) => (at += ms),
  };
}
test("recent preparation drains the bounded pending page beyond the last two clips per camera", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) await f.recent.tick();
  assert.deepEqual(
    f.calls.map((x) => x.id),
    ["0", "1", "2", "3", "4", "5"],
  );
  assert.ok(f.calls.every((x) => x.priority < 0 && x.options.remoteOnly));
});
test("background admission yields to foreground work and never runs on unavailable or unreplicated workers", async (t) => {
  const f = fixture(t);
  f.cluster.canPreparePlayback = () => false;
  await f.recent.tick();
  assert.equal(f.calls.length, 0);
  f.cluster.canPreparePlayback = () => true;
  for (const reason of ["foreground", "finalizing", "disabled", "stopped"]) {
    f.recorder.playbackJobs.clear();
    f.recorder.encoding.activeWork = null;
    f.recorder.stopped = false;
    f.recorder.cameras.forEach((c) => {
      c.available = true;
      c.enabled = true;
    });
    if (reason === "foreground") f.recorder.playbackJobs.set("selected", {});
    if (reason === "finalizing") f.recorder.encoding.activeWork = {};
    if (reason === "offline")
      f.recorder.cameras.forEach((c) => (c.available = false));
    if (reason === "disabled")
      f.recorder.cameras.forEach((c) => (c.enabled = false));
    if (reason === "stopped") f.recorder.stopped = true;
    await f.recent.tick();
    assert.equal(f.calls.length, 0, reason);
  }
});
test("a slow or failed worker creates one task at a time with a bounded retry interval", async (t) => {
  const f = fixture(t);
  let finish;
  f.recorder.preparePlayback = async (event) => {
    f.calls.push(event.id);
    await new Promise((resolve) => (finish = resolve));
    throw Error("worker_unavailable");
  };
  const first = f.recent.tick();
  await f.recent.tick();
  assert.deepEqual(f.calls, ["0"]);
  finish();
  await first;
  const second = f.recent.tick();
  assert.deepEqual(f.calls, ["0", "1"]);
  finish();
  await second;
  f.recorder.preparePlayback = async (event) => {
    f.calls.push(event.id);
    throw Error("worker_unavailable");
  };
  await f.recent.tick();
  await f.recent.tick();
  await f.recent.tick();
  await f.recent.tick();
  await f.recent.tick();
  assert.deepEqual(f.calls, ["0", "1", "2", "3", "4", "5"]);
  f.advance(60000);
  await f.recent.tick();
  assert.equal(f.calls.at(-1), "0");
});

test("prepared recent rows do not bury old pending media or unsafe original markers", async (t) => {
  const { Store } = await import("../lib/store.mjs");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(), "haus-pending-page-"));
  await mkdir(join(root, "media"));
  const store = new Store(join(root, "db.sqlite"), join(root, "media"));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 70; i++) {
    const event = store.create("camera.a", "motion", 1000 + i, 3000 + i);
    store.finish(event.id, { duration: 2, bytes: 1, playbackVersion: 4 });
  }
  const unsafe = store.create("camera.a", "motion", 100, 200);
  store.finish(unsafe.id, { duration: 1, bytes: 1, playbackVersion: 4 });
  store.setPlayback(unsafe.id, 0, 4, { originalCompatible: true });
  const calls = [];
  const recorder = {
    stopped: false,
    playbackJobs: new Map(),
    encoding: { pending: [] },
    cameras: [{ id: "camera.a", enabled: true, available: true }],
    preparePlayback: async (event) => {
      calls.push(event.id);
    },
  };
  const recent = new RecentPlayback(store, recorder, {
    canPreparePlayback: () => true,
  });
  await recent.tick();
  assert.deepEqual(calls, [unsafe.id]);
});

test("an offline camera's retained local footage can prepare without waking its source; disabled cameras and archived originals stay untouched", async (t) => {
  const f = fixture(t);
  f.recorder.cameras.forEach((camera) => {
    camera.available = false;
  });
  await f.recent.tick();
  assert.equal(f.calls.length, 1);
  const disabled = fixture(t);
  disabled.recorder.cameras.forEach((camera) => {
    camera.enabled = false;
  });
  await disabled.recent.tick();
  assert.equal(disabled.calls.length, 0);
  const archived = fixture(t);
  archived.store.db.exec("UPDATE events SET local_original=0");
  await archived.recent.tick();
  assert.equal(archived.calls.length, 0);
});

test("64 unadmitted recent clips cannot hide older playable local footage", async (t) => {
  const store = new Store(":memory:", "/unused-media");
  t.after(() => store.close());
  for (let i = 0; i < 64; i++) {
    const e = store.create("camera.disabled", "motion", 2000 + i, 3000 + i);
    store.finish(e.id, { duration: 1, bytes: 1 });
  }
  const old = store.create("camera.enabled", "motion", 1000, 2000);
  store.finish(old.id, { duration: 1, bytes: 1 });
  const calls = [];
  const recorder = {
    playbackJobs: new Map(),
    encoding: { pending: [] },
    cameras: [
      { id: "camera.disabled", enabled: false },
      { id: "camera.enabled", enabled: true },
    ],
    preparePlayback: async (e) => {
      calls.push(e.id);
      store.finish(e.id, { duration: 1, bytes: 1, playbackVersion: 4 });
    },
  };
  const recent = new RecentPlayback(
    store,
    recorder,
    { canPreparePlayback: () => true },
    () => 100000,
  );
  await recent.tick();
  await recent.tick();
  assert.deepEqual(calls, [old.id]);
});

test("slow repeated failures yield to unattempted old clips", async (t) => {
  const store = new Store(":memory:", "/unused-media");
  t.after(() => store.close());
  let at = 100000;
  for (let i = 0; i < 64; i++) {
    const e = store.create("camera.bad", "motion", 2000 + i, 3000 + i);
    store.finish(e.id, { duration: 1, bytes: 1 });
  }
  const old = store.create("camera.good", "motion", 1000, 2000);
  store.finish(old.id, { duration: 1, bytes: 1 });
  const calls = [];
  const recorder = {
    playbackJobs: new Map(),
    encoding: { pending: [] },
    cameras: [
      { id: "camera.bad", enabled: true },
      { id: "camera.good", enabled: true },
    ],
    preparePlayback: async (e) => {
      calls.push(e.id);
      if (e.cameraId === "camera.bad") {
        at += 61000;
        throw Error("worker_unavailable");
      }
      store.finish(e.id, { duration: 1, bytes: 1, playbackVersion: 4 });
    },
  };
  const recent = new RecentPlayback(
    store,
    recorder,
    { canPreparePlayback: () => true },
    () => at,
  );
  for (let i = 0; i < 65; i++) await recent.tick();
  assert.equal(calls.at(-1), old.id);
  assert.equal(new Set(calls).size, 65);
});

test("background retry cooldown survives a controller restart while new footage stays first", async (t) => {
  const f = fixture(t);
  f.recorder.preparePlayback = async (event) => {
    f.calls.push(event.id);
    throw Error("worker_unavailable");
  };
  await f.recent.tick();
  assert.deepEqual(f.calls, ["0"]);
  const restarted = new RecentPlayback(
    f.store,
    f.recorder,
    f.cluster,
    () => 100000,
  );
  await restarted.tick();
  assert.deepEqual(f.calls, ["0", "1"]);
  const added = f.store.create("camera.a", "motion", 2000, 3000);
  f.store.finish(added.id, { duration: 1, bytes: 1 });
  await restarted.tick();
  assert.equal(f.calls.at(-1), added.id);
  assert.equal(f.calls.filter((id) => id === "0").length, 1);
});

test("retry bookkeeping drops prepared, archived and expired rows without changing footage metadata", async (t) => {
  const f = fixture(t);
  f.cluster.canPreparePlayback = () => false;
  await f.recent.tick();
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM background_preparation_attempts")
      .get().n,
    6,
  );
  f.store.db.exec(
    "UPDATE events SET playback_version=4 WHERE id='0'; UPDATE events SET local_original=0 WHERE id='1'; DELETE FROM events WHERE id='2'",
  );
  const before = f.store.db.prepare("SELECT * FROM events ORDER BY id").all();
  await f.recent.tick();
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM background_preparation_attempts")
      .get().n,
    3,
  );
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM events ORDER BY id").all(),
    before,
  );
});
