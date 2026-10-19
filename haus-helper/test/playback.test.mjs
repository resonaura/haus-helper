import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMedia } from "../lib/media.mjs";
import { playbackArguments, inspectCadence } from "../lib/playback.mjs";
test("compatibility output has regular timestamps and bounded keyframes without overwriting the source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-cadence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "source.mp4"),
    output = join(root, "playback.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20",
    "-t",
    "3",
    "-vf",
    "select='not(between(t,1,2))'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    input,
  ]);
  const before = await inspectCadence(input);
  assert.ok(before.largestGap >= 1);
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    input,
    ...playbackArguments(),
    output,
  ]);
  assert.equal((await inspectCadence(output)).largestGap, 0);
  assert.ok((await stat(input)).size > 0);
  assert.ok((await stat(output)).size > 0);
  const frames = await runMedia("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "frame=key_frame,best_effort_timestamp_time",
    "-of",
    "json",
    output,
  ]);
  const times = JSON.parse(frames.stdout)
    .frames.filter((frame) => frame.key_frame)
    .map((frame) => Number(frame.best_effort_timestamp_time));
  assert.ok(times.length >= 2);
  assert.ok(times.slice(1).every((at, i) => at - times[i] <= 2.01));
});
