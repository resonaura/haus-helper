import { createEufyTalkback } from "./eufy-talkback.mjs";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { lookup } from "node:dns/promises";

const privateIp = (host) =>
  (isIP(host) === 4 &&
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
  host === "::1" ||
  (isIP(host) === 6 && /^(fc|fd)/i.test(host));
export function talkbackAddress(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "rtmp:" &&
      !url.hash &&
      String(value).length <= 2048 &&
      (privateIp(host) ||
        host === "localhost" ||
        /\.(local|lan|home\.arpa)$/.test(host))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function customTalkback(value, registry) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new Error("invalid_talkback_source");
  if (typeof value.url === "string" && talkbackAddress(value.url))
    return { url: value.url };
  if (
    typeof value.entityId === "string" &&
    /^(sensor|text|input_text)\.[a-z0-9_]+$/.test(value.entityId) &&
    registry.states.some(
      (state) =>
        state.entity_id === value.entityId && talkbackAddress(state.state),
    )
  )
    return { entityId: value.entityId };
  throw new Error("invalid_talkback_source");
}

/** A dedicated HA talkback sensor is authoritative; streaming support alone is not. */
export function talkbackTarget(camera, registry) {
  if (camera.talkback) {
    const value = camera.talkback.entityId
      ? registry.states.find(
          (state) => state.entity_id === camera.talkback.entityId,
        )?.state
      : camera.talkback.url;
    return talkbackAddress(value);
  }
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

export function createTalkback({ spawnProcess = spawn, config = {} } = {}) {
  const eufy = createEufyTalkback(config);
  const active = new Map();
  const stopAll = () => {
    eufy.stopAll();
    for (const stop of active.values()) stop();
  };
  const stream = async (camera, registry, req, res) => {
    const target = talkbackTarget(camera, registry);
    if (camera.talkback && !target) throw new Error("invalid_talkback_source");
    if (!target) {
      if (
        req.headers["x-haus-client"] !== "1" ||
        !String(req.headers["content-type"]).startsWith("audio/webm")
      )
        throw new Error("invalid_audio");
      return eufy.stream(camera, registry, req, res);
    }
    if (active.has(camera.id)) throw new Error("talkback_busy");
    if (req.destroyed || res.destroyed) throw new Error("talkback_cancelled");
    if (
      req.headers["x-haus-client"] !== "1" ||
      !String(req.headers["content-type"]).startsWith("audio/webm")
    )
      throw new Error("invalid_audio");
    const host = new URL(target).hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (!addresses.length || addresses.some((item) => !privateIp(item.address)))
      throw new Error("invalid_private_talkback_address");
    if (active.has(camera.id)) throw new Error("talkback_busy");
    if (req.destroyed || res.destroyed) throw new Error("talkback_cancelled");
    const resolvedTarget = new URL(target);
    resolvedTarget.hostname = addresses[0].address.includes(":")
      ? `[${addresses[0].address}]`
      : addresses[0].address;
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
        resolvedTarget.href,
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
  return {
    stream,
    stopAll,
    available: async (camera, registry) =>
      camera.talkback
        ? Boolean(talkbackTarget(camera, registry))
        : Boolean(talkbackTarget(camera, registry)) ||
          (await eufy.available(camera, registry)),
  };
}
