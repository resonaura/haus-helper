import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordingProgress } from "../lib/recording-progress.mjs";

test("FFmpeg stream-copy timestamps prove progress even without a frame counter", () => {
  const progress = new RecordingProgress();
  assert.equal(
    progress.push("bitrate=N/A\nout_time_us=2600000\nprogress=continue\n"),
    true,
  );
  assert.equal(progress.frames, 0);
  assert.equal(progress.timeUs, 2600000);
  assert.equal(progress.sustained, false);
  assert.equal(progress.push("out_time_us=6800000\nprogress=continue\n"), true);
  assert.equal(progress.sustained, true);
});

test("split frame counters work while repeated, backwards or invalid output cannot hide a stall", () => {
  const progress = new RecordingProgress();
  assert.equal(progress.push("fra"), false);
  assert.equal(progress.push("me=  120\nout_time_us=6000000\n"), true);
  assert.equal(progress.frames, 120);
  assert.equal(progress.sustained, true);
  assert.equal(progress.push("frame=120\nout_time_us=6000000\n"), false);
  assert.equal(progress.push("frame=2\nout_time_us=1000000\n"), false);
  assert.equal(
    progress.push("frame=N/A\nout_time_us=-1\nframe=9007199254740999\n"),
    false,
  );
  assert.equal(progress.push("frame=121\n"), true);
});

test("startup zeroes do not prove media and a new process gets fresh bounded progress", () => {
  const progress = new RecordingProgress();
  assert.equal(
    progress.push("frame=0\nout_time_us=0\nprogress=continue\n"),
    false,
  );
  assert.equal(progress.push("x".repeat(20000)), false);
  assert.ok(progress.partial.length <= 8192);
  assert.equal(progress.push("\nout_time_us=1\n"), true);
  assert.equal(new RecordingProgress().timeUs, 0);
});
