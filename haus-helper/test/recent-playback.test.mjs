import { test } from "node:test";
import assert from "node:assert/strict";
import { RecentPlayback } from "../lib/recent-playback.mjs";
function fixture() {
  let at = 100000;
  const events = Array.from({ length: 6 }, (_, i) => ({
    id: String(i),
    cameraId: i < 3 ? "camera.a" : "camera.b",
    playbackVersion: 0,
  }));
  const calls = [];
  const store = {
    db: { prepare: () => ({ all: () => events.map(({ id }) => ({ id })) }) },
    get: (id) => events.find((e) => e.id === id),
  };
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
      event.playbackVersion = 4;
    },
  };
  const cluster = { canPreparePlayback: () => true };
  const recent = new RecentPlayback(store, recorder, cluster, () => at);
  return {
    events,
    calls,
    recorder,
    cluster,
    recent,
    advance: (ms) => (at += ms),
  };
}
test("recent preparation drains the bounded pending page beyond the last two clips per camera", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await f.recent.tick();
  assert.deepEqual(
    f.calls.map((x) => x.id),
    ["0", "1", "2", "3", "4", "5"],
  );
  assert.ok(f.calls.every((x) => x.priority < 0 && x.options.remoteOnly));
});
test("background admission yields to foreground work and never runs on unavailable or unreplicated workers", async () => {
  const f = fixture();
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
test("a slow or failed worker creates one task at a time with a bounded retry interval", async () => {
  const f = fixture();
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

test("an offline camera's retained local footage can prepare without waking its source; disabled cameras and archived originals stay untouched", async () => {
  const f = fixture();
  f.recorder.cameras.forEach((camera) => {
    camera.available = false;
  });
  await f.recent.tick();
  assert.equal(f.calls.length, 1);
  const disabled = fixture();
  disabled.recorder.cameras.forEach((camera) => {
    camera.enabled = false;
  });
  await disabled.recent.tick();
  assert.equal(disabled.calls.length, 0);
  const archived = fixture();
  archived.events.forEach((event) => {
    event.localOriginal = false;
  });
  await archived.recent.tick();
  assert.equal(archived.calls.length, 0);
});
