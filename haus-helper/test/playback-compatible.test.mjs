import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMedia } from "../lib/media.mjs";
import {
  compatiblePackets,
  hasFrontIndex,
  inspectOriginalPlayback,
  trustedOriginalParameters,
} from "../lib/playback-compatible.mjs";
const encoder = { kind: "haus-encoder", profile: 1 };

const good = () => ({
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      pix_fmt: "yuv420p",
      profile: "High",
      start_time: "0",
      duration: "2",
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "aac",
      start_time: "0",
      duration: "2",
    },
  ],
  packets: Array.from({ length: 40 }, (_, i) => ({
    stream_index: 0,
    pts_time: String(i / 20),
    dts_time: String(i / 20),
    flags: i % 20 === 0 ? "K_" : "__",
  })),
});

test("only admits compatible indexed packets with short GOPs, continuous timestamps and aligned real audio", () => {
  assert.equal(compatiblePackets(good(), {}, encoder), true);
  for (const mutate of [
    (x) => (x.streams[0].codec_name = "hevc"),
    (x) => (x.streams[0].pix_fmt = "yuv420p10le"),
    (x) => (x.streams[0].profile = "High 4:4:4 Predictive"),
    (x) => (x.streams[1].codec_name = "pcm_alaw"),
    (x) => (x.streams[1].start_time = "1"),
    (x) => (x.streams[1].duration = "20"),
    (x) => (x.packets[0].flags = "__"),
    (x) => (x.packets[12].dts_time = "0"),
    (x) => x.packets.splice(10, 25),
    (x) => (x.streams[0].duration = "8"),
  ]) {
    const input = good();
    mutate(input);
    assert.equal(compatiblePackets(input, {}, encoder), false);
  }
  assert.equal(
    compatiblePackets(good(), { audioTrimSeconds: 1 }, encoder),
    false,
  );
  assert.equal(
    compatiblePackets(good(), { audioTailSeconds: 5 }, encoder),
    false,
  );
});

test("real H264/AAC faststart original needs no compatibility encode, while tail-indexed originals keep fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-original-playback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "fast.mp4"),
    tail = join(root, "tail.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "20",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    file,
  ]);
  const original = await readFile(file);
  assert.equal(await inspectOriginalPlayback(file, {}, encoder), true);
  assert.deepEqual(await readFile(file), original);
  await runMedia("ffmpeg", ["-v", "error", "-i", file, "-c", "copy", tail]);
  assert.equal(await hasFrontIndex(tail), false);
  assert.equal(await inspectOriginalPlayback(tail, {}, encoder), false);
});

test("packet timing cannot confer trust on an unknown or unproven Aqara bitstream", () => {
  assert.equal(compatiblePackets(good()), false);
  for (const provenance of [
    undefined,
    {
      kind: "camera",
      platform: "mqtt",
      manufacturer: "Aqara",
      model: "Camera E1",
    },
    {
      kind: "camera",
      platform: "mqtt",
      manufacturer: "Aqara",
      model: "Camera Hub G5 Pro (Wi-Fi)",
    },
  ]) {
    const info = good();
    Object.assign(info.streams[0], {
      profile: "Main",
      level: 50,
      width: 2688,
      height: 1520,
      has_b_frames: 0,
    });
    assert.equal(compatiblePackets(info, {}, provenance), false);
  }
  const provenEufy = {
    kind: "camera",
    platform: "eufy_security",
    manufacturer: "Eufy Security",
    model: "T8410C",
  };
  const info = good();
  Object.assign(info.streams[0], {
    profile: "High",
    level: 42,
    width: 1920,
    height: 1080,
    has_b_frames: 0,
  });
  assert.equal(compatiblePackets(info, {}, provenEufy), true);
  for (const change of [
    { profile: "Main" },
    { level: 50 },
    { width: 2688 },
    { has_b_frames: 2 },
  ])
    assert.equal(
      trustedOriginalParameters({ ...info.streams[0], ...change }, provenEufy),
      false,
    );
  assert.equal(
    compatiblePackets(info, {}, { ...provenEufy, model: "Unknown" }),
    false,
  );
  assert.equal(
    compatiblePackets(info, {}, { ...provenEufy, platform: "generic" }),
    false,
  );
});
