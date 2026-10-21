import { runMedia } from "./media.mjs";

/** Only realign a proven silent lead; preserve originals and ambiguous audio. */
export async function inspectAudioAlignment(path, expectedSeconds) {
  const result = await runMedia(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,duration",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000 },
  );
  const streams = JSON.parse(result.stdout).streams ?? [];
  const video = Number(streams.find((s) => s.codec_type === "video")?.duration);
  const audio = Number(streams.find((s) => s.codec_type === "audio")?.duration);
  const excess = audio - video;
  if (
    !Number.isFinite(video) ||
    video <= 0 ||
    !Number.isFinite(excess) ||
    excess <= 3
  )
    return {};
  const diagnostics = { videoDuration: video, audioTailSeconds: excess };
  // A short video from a genuinely interrupted event is not evidence that its
  // later audio belongs at the beginning. Require the expected event boundary.
  if (
    !Number.isFinite(expectedSeconds) ||
    expectedSeconds <= 0 ||
    video < expectedSeconds * 0.5 ||
    video > expectedSeconds + 30 ||
    excess > 86400
  )
    return diagnostics;
  const measured = await runMedia(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-t",
      String(Math.max(0, excess - 0.25)),
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { timeout: 30000 },
  );
  const mean = Number(
    /mean_volume:\s*(-?[\d.]+) dB/.exec(measured.stderr)?.[1],
  );
  const peak = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(measured.stderr)?.[1]);
  if (
    Number.isFinite(mean) &&
    Number.isFinite(peak) &&
    mean <= -85 &&
    peak <= -65
  )
    return { ...diagnostics, audioTrimSeconds: excess };
  return diagnostics;
}
