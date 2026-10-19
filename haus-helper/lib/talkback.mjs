import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";

/** A dedicated HA talkback sensor is authoritative; streaming support alone is not. */
export function talkbackTarget(camera, registry) {
  const stems = [camera.id, ...(camera.aliases ?? [])].map((id) =>
    id.split(".")[1].replace(/_internal$/, ""),
  );
  const sensor = registry.states.find((state) =>
    stems.some(
      (stem) => state.entity_id === `sensor.${stem}_talkback_rtmp_stream`,
    ),
  );
  if (!sensor) return null;
  try {
    const url = new URL(sensor.state);
    const host = url.hostname;
    const local =
      (isIP(host) === 4 &&
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
      host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".lan");
    return url.protocol === "rtmp:" &&
      local &&
      url.pathname.startsWith("/talk/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function createTalkback({ spawnProcess = spawn } = {}) {
  const active = new Map();
  const stopAll = () => {
    for (const stop of active.values()) stop();
  };
  const stream = async (camera, registry, req, res) => {
    const target = talkbackTarget(camera, registry);
    if (!target) throw new Error("talkback_unavailable");
    if (active.has(camera.id)) throw new Error("talkback_busy");
    if (
      req.headers["x-haus-client"] !== "1" ||
      !String(req.headers["content-type"]).startsWith("audio/webm")
    )
      throw new Error("invalid_audio");
    const child = spawnProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-probesize",
        "32768",
        "-analyzeduration",
        "500000",
        "-f",
        "webm",
        "-i",
        "pipe:0",
        "-vn",
        "-c:a",
        "aac",
        "-b:a",
        "32k",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-flush_packets",
        "1",
        "-f",
        "flv",
        target,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      active.delete(camera.id);
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1500).unref();
    };
    const timer = setTimeout(stop, 60000);
    timer.unref();
    active.set(camera.id, stop);
    child.stderr.on("data", () => {}); // Camera credentials and FFmpeg command lines never enter logs.
    child.on("error", () => {
      stop();
      res.destroy();
    });
    child.on("close", () => {
      stop();
      if (!res.destroyed) res.end();
    });
    req.on("aborted", stop);
    res.on("close", stop);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4_000_000) {
        stop();
        req.destroy();
      }
    });
    try {
      await pipeline(req, child.stdin);
    } catch {
      stop();
    }
  };
  return { stream, stopAll };
}
