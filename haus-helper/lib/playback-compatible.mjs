import { open } from "node:fs/promises";
import { runMedia } from "./media.mjs";

/** A seekable MP4 must expose its index before the first media payload. */
export async function hasFrontIndex(path) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    let offset = 0;
    const header = Buffer.alloc(16);
    for (let count = 0; count < 64 && offset + 8 <= size; count++) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      const type = header.toString("ascii", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      let bytes = header.readUInt32BE(0);
      if (bytes === 1) {
        if (bytesRead < 16) return false;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false;
        bytes = Number(large);
      }
      if (bytes < 8 || offset + bytes > size) return false;
      offset += bytes;
    }
    return false;
  } finally {
    await file.close();
  }
}

/** Packet-level admission is conservative: questionable media keeps the repair path. */
export function compatiblePackets(info, alignment = {}) {
  const video = info.streams?.find((s) => s.codec_type === "video");
  const audio = info.streams?.find((s) => s.codec_type === "audio");
  if (
    video?.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    !["Baseline", "Constrained Baseline", "Main", "High"].includes(
      video.profile,
    ) ||
    alignment.audioTrimSeconds > 0 ||
    alignment.audioTailSeconds > 1
  )
    return false;
  const duration = Number(video.duration),
    start = Number(video.start_time);
  if (!(duration > 0) || !Number.isFinite(start) || Math.abs(start) > 0.15)
    return false;
  if (
    audio &&
    (audio.codec_name !== "aac" ||
      !Number.isFinite(Number(audio.start_time)) ||
      Math.abs(Number(audio.start_time) - start) > 0.2 ||
      !Number.isFinite(Number(audio.duration)) ||
      Math.abs(Number(audio.duration) - duration) > 1)
  )
    return false;
  const packets = (info.packets ?? []).filter(
    (p) => p.stream_index === video.index,
  );
  if (packets.length < 2 || !String(packets[0].flags).includes("K"))
    return false;
  let dts = -Infinity;
  const times = [],
    keys = [];
  for (const packet of packets) {
    const pts = Number(packet.pts_time),
      nextDts = Number(packet.dts_time);
    if (
      !Number.isFinite(pts) ||
      !Number.isFinite(nextDts) ||
      nextDts <= dts ||
      pts < -0.15
    )
      return false;
    dts = nextDts;
    times.push(pts);
    if (String(packet.flags).includes("K")) keys.push(pts);
  }
  times.sort((a, b) => a - b);
  keys.sort((a, b) => a - b);
  if (
    times[0] > 0.15 ||
    duration - times.at(-1) > 0.5 ||
    times.some((at, i) => i && (at <= times[i - 1] || at - times[i - 1] > 0.5))
  )
    return false;
  return (
    keys.every((at, i) => !i || at - keys[i - 1] <= 2.5) &&
    duration - keys.at(-1) <= 2.5
  );
}

export async function inspectOriginalPlayback(path, alignment = {}) {
  if (!(await hasFrontIndex(path))) return false;
  const { stdout } = await runMedia(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_name,codec_type,profile,pix_fmt,start_time,duration:packet=stream_index,pts_time,dts_time,flags",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000, maxOutput: 4000000 },
  );
  try {
    return compatiblePackets(JSON.parse(stdout), alignment);
  } catch {
    return false;
  }
}
