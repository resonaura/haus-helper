import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMedia } from "../lib/media.mjs";
import { inspectAudioAlignment } from "../lib/playback-audio.mjs";
import { playbackArguments } from "../lib/playback.mjs";

test("repairs a proven silent audio lead and caps playback at the actual video", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-audio-alignment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, "original.mp4"),
    output = join(root, "playback.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=500:sample_rate=16000:duration=2",
    "-af",
    "adelay=6000",
    "-c:v",
    "libx264",
    "-bf",
    "0",
    "-c:a",
    "aac",
    input,
  ]);
  const original = await readFile(input);
  const alignment = await inspectAudioAlignment(input, 2);
  assert.ok(Math.abs(alignment.audioTrimSeconds - 6) < 0.15);
  assert.equal(
    (await inspectAudioAlignment(input, 30)).audioTrimSeconds,
    undefined,
  );
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    input,
    ...playbackArguments({
      copyVideo: true,
      audioTrimSeconds: alignment.audioTrimSeconds,
      videoDuration: alignment.videoDuration,
    }),
    output,
  ]);
  const probe = await runMedia("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,duration",
    "-of",
    "json",
    output,
  ]);
  const data = JSON.parse(probe.stdout);
  assert.ok(Number(data.format.duration) < 2.2);
  assert.ok(data.streams.some((stream) => stream.codec_type === "audio"));
  const sound = await runMedia("ffmpeg", [
    "-hide_banner",
    "-i",
    output,
    "-map",
    "0:a:0",
    "-t",
    "1",
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const volume = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(sound.stderr)?.[1]);
  assert.ok(
    volume > -30,
    "actual event audio starts with the video, without the silent prefix",
  );
  assert.deepEqual(await readFile(input), original);

  const ambiguous = join(root, "real-audio.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20:duration=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=500:sample_rate=16000:duration=8",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    ambiguous,
  ]);
  assert.equal(
    (await inspectAudioAlignment(ambiguous, 2)).audioTrimSeconds,
    undefined,
    "real audio before the proposed boundary must never be silently shifted",
  );
  const unchanged = await readFile(ambiguous);
  const unshifted = await inspectAudioAlignment(ambiguous, 2);
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    ambiguous,
    ...playbackArguments({ videoDuration: unshifted.videoDuration }),
    output,
  ]);
  const bounded = await runMedia("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,duration",
    "-of",
    "json",
    output,
  ]);
  const boundedInfo = JSON.parse(bounded.stdout);
  assert.ok(Number(boundedInfo.format.duration) < 2.2);
  assert.ok(
    Number(boundedInfo.streams.find((s) => s.codec_type === "audio").duration) <
      2.2,
  );
  assert.deepEqual(await readFile(ambiguous), unchanged);
});
test("a short audio track cannot truncate the remaining camera video", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-short-audio-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "playback.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20:duration=4",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=500:sample_rate=16000:duration=1",
    ...playbackArguments(),
    output,
  ]);
  const probe = await runMedia("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    output,
  ]);
  const duration = Number(JSON.parse(probe.stdout).format.duration);
  assert.ok(duration >= 3.95 && duration < 4.2);
});
