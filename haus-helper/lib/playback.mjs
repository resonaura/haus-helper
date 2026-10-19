import { runMedia } from "./media.mjs";
export const PLAYBACK_VERSION = 2;
/** Fixed cadence and bounded GOPs avoid multi-second decoder starvation and expensive seeks. */
export function playbackArguments() {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-threads",
    "2",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "fps=20:start_time=0",
    "-fps_mode",
    "cfr",
    "-g",
    "40",
    "-keyint_min",
    "20",
    "-sc_threshold",
    "0",
    "-bf",
    "0",
    "-video_track_timescale",
    "90000",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-af",
    "aresample=async=1000:first_pts=0",
    "-movflags",
    "+faststart",
  ];
}
export async function inspectCadence(path) {
  const { stdout } = await runMedia(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      path,
    ],
    { timeout: 30000, maxOutput: 2000000 },
  );
  const points = stdout
    .split("\n")
    .filter((s) => s.trim())
    .map((s) => Number(s.trim().split(",")[0]))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < points.length; i++)
    if (points[i] - points[i - 1] > 0.5)
      gaps.push({ at: points[i - 1], duration: points[i] - points[i - 1] });
  return {
    sourceGaps: gaps.slice(0, 100),
    largestGap: gaps.reduce((max, gap) => Math.max(max, gap.duration), 0),
  };
}
