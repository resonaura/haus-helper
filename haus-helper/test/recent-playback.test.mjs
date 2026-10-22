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
test("recent preparation is bounded to two latest clips per camera, including already prepared clips", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) await f.recent.tick();
  assert.deepEqual(
    f.calls.map((x) => x.id),
    ["0", "1", "3", "4"],
  );
  assert.ok(f.calls.every((x) => x.priority < 0 && x.options.remoteOnly));
});
test("background admission yields to foreground work and never runs on unavailable or unreplicated workers", async () => {
  const f = fixture();
  f.cluster.canPreparePlayback = () => false;
  await f.recent.tick();
  assert.equal(f.calls.length, 0);
  f.cluster.canPreparePlayback = () => true;
  for (const reason of [
    "foreground",
    "finalizing",
    "offline",
    "disabled",
    "stopped",
  ]) {
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
  assert.deepEqual(f.calls, ["0", "1", "3", "4"]);
  f.advance(60000);
  await f.recent.tick();
  assert.equal(f.calls.at(-1), "0");
});
