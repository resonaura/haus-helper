import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { PlaybackPreparation } from "../lib/playback-preparation.mjs";

test("bounds pending work, promotes a selected event and reclaims completed entries", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const priorities = [];
  const prepare = new PlaybackPreparation(
    {
      preparePlayback: (_event, priority) => {
        priorities.push(priority);
        return pending;
      },
    },
    { limit: 1 },
  );
  const event = { id: "event", playbackVersion: 0 };
  assert.equal(prepare.status(event, 0), "preparing");
  await pause(0);
  assert.equal(prepare.status(event, 20), "preparing");
  assert.deepEqual(priorities, [0, 20]);
  assert.equal(prepare.status({ id: "other" }, 20), "busy");
  finish();
  await pause(0);
  assert.equal(prepare.status(event, 20), "ready");
  assert.equal(
    prepare.status({ id: "other", playbackVersion: 4 }, 20),
    "ready",
  );
  assert.equal(prepare.status({ id: "third" }, 20), "preparing");
  prepare.clear();
  assert.equal(prepare.jobs.size, 0);
});
test("failed work is caught, redacted and held briefly rather than repeatedly restarted", async (t) => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = warn;
  });
  let now = 0,
    calls = 0;
  const prepare = new PlaybackPreparation(
    {
      preparePlayback: async () => {
        calls++;
        throw new Error("rtsp://secret:credential@private-camera/live");
      },
    },
    { now: () => now },
  );
  const event = { id: "event" };
  assert.equal(prepare.status(event, 20), "preparing");
  await pause(0);
  assert.equal(prepare.status(event, 20), "failed");
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(warnings).includes("credential"));
  now = 5000;
  assert.equal(prepare.status(event, 20), "preparing");
  await pause(0);
  assert.equal(calls, 2);
});
