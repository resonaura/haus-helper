import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaQueue } from "../lib/media-queue.mjs";
test("one encoder at a time, foreground promotion, bounded backlog and stop rejection", async () => {
  const queue = new MediaQueue(3),
    order = [];
  let release;
  const first = queue.run(
    () =>
      new Promise((resolve) => {
        release = () => {
          order.push("first");
          resolve();
        };
      }),
    0,
    "active",
  );
  const speculative = queue.run(
    async () => {
      order.push("speculative");
    },
    0,
    "next",
  );
  const recorded = queue.run(
    async () => {
      order.push("recorded");
    },
    10,
    "recorded",
  );
  queue.promote("next", 20);
  release();
  await Promise.all([first, speculative, recorded]);
  assert.deepEqual(order, ["first", "speculative", "recorded"]);
  const blocker = queue.run(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = queue.run(async () => {}, 0);
  const stopped = assert.rejects(pending, /media_stopped/);
  queue.stop();
  release();
  await blocker;
  await stopped;
  await assert.rejects(() => queue.run(async () => {}), /media_stopped/);
});
