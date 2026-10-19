import { spawn } from "node:child_process";
export function runMedia(
  command,
  args,
  { timeout = 120000, signal, maxOutput = 256000 } = {},
) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, timeout);
    process.stdout.on("data", (data) => {
      if (stdout.length < maxOutput) stdout += data;
    });
    process.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-8000);
    });
    process.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`media_process_${code}`));
    });
  });
}
export async function probe(path) {
  const result = await runMedia(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000 },
  );
  const info = JSON.parse(result.stdout);
  return {
    duration: Number(info.format?.duration) || 0,
    codec: info.streams?.[0]?.codec_name,
  };
}
export function parseRange(value, size) {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("invalid_range");
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end = match[1]
    ? match[2]
      ? Math.min(size - 1, Number(match[2]))
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  )
    throw new Error("invalid_range");
  return { start, end, partial: true };
}
