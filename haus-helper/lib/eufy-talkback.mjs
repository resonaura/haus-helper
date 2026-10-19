import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { EufySession, eufySerial } from "./eufy-session.mjs";
import { eufyEndpoint } from "./eufy-endpoint.mjs";
export function createEufyTalkback(
  config,
  { sessionFactory = (url) => new EufySession(url), spawnProcess = spawn } = {},
) {
  const endpoint = eufyEndpoint(config);
  const active = new Map(),
    capabilities = new Map();
  const available = async (camera, registry) => {
    const serial = eufySerial(camera, registry);
    if (!serial) return false;
    const url = await endpoint();
    if (!url) return false;
    const key = `${url}:${serial}`;
    const cached = capabilities.get(key);
    if (cached && cached.until > Date.now()) return cached.supported;
    const session = sessionFactory(url);
    try {
      await session.connect();
      const result = await session.command("device.has_command", {
        serialNumber: serial,
        commandName: "deviceStartTalkback",
      });
      capabilities.set(key, {
        supported: result.exists === true,
        until: Date.now() + 60000,
      });
      return result.exists === true;
    } catch {
      return false;
    } finally {
      session.close();
    }
  };
  const stream = async (camera, registry, req, res) => {
    if (!(await available(camera, registry)))
      throw new Error("talkback_unavailable");
    if (active.has(camera.id)) throw new Error("talkback_busy");
    const serial = eufySerial(camera, registry),
      session = sessionFactory(await endpoint());
    let child,
      closed = false,
      ownsLive = false,
      ownsTalk = false;
    const waits = [];
    const stop = () => {
      closed = true;
      child?.stdin.destroy();
      child?.kill("SIGTERM");
    };
    const timer = setTimeout(stop, 60000);
    timer.unref();
    active.set(camera.id, stop);
    req.once("aborted", stop);
    res.once("close", stop);
    const check = () => {
      if (closed || req.aborted) throw new Error("talkback_cancelled");
    };
    const start = async (command, event) => {
      const wait = session.wait(serial, event);
      waits.push(wait);
      await session.command(command, { serialNumber: serial });
      if (command === "device.start_livestream") ownsLive = true;
      else ownsTalk = true;
      await wait.promise;
      check();
    };
    try {
      await session.connect();
      check();
      const inUse = await session.command("device.is_talkback_ongoing", {
        serialNumber: serial,
      });
      check();
      if (inUse.talkbackOngoing) throw new Error("talkback_busy");
      const live = await session.command("device.is_livestreaming", {
        serialNumber: serial,
      });
      check();
      if (!live.livestreaming)
        await start("device.start_livestream", "livestream started");
      await start("device.start_talkback", "talkback started");
      child = spawnProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "webm",
          "-i",
          "pipe:0",
          "-vn",
          "-c:a",
          "aac",
          "-ar",
          "16000",
          "-ac",
          "1",
          "-b:a",
          "16k",
          "-f",
          "adts",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stderr.on("data", () => {});
      child.once("error", () => {
        stop();
        res.destroy();
      });
      session.once("disconnected", stop);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 4000000) {
          stop();
          req.destroy();
        }
      });
      const audio = (async () => {
        for await (const chunk of child.stdout) {
          check();
          if (session.socket?.bufferedAmount > 256000)
            throw new Error("talkback_backpressure");
          await session.command("device.talkback_audio_data", {
            serialNumber: serial,
            buffer: { type: "Buffer", data: Array.from(chunk) },
          });
        }
      })();
      await Promise.all([pipeline(req, child.stdin), audio]);
    } finally {
      stop();
      clearTimeout(timer);
      for (const wait of waits) wait.cancel();
      if (ownsTalk)
        await session
          .command("device.stop_talkback", { serialNumber: serial })
          .catch(() => {});
      if (ownsLive)
        await session
          .command("device.stop_livestream", { serialNumber: serial })
          .catch(() => {});
      session.close();
      active.delete(camera.id);
      req.off("aborted", stop);
      res.off("close", stop);
      if (!res.destroyed) res.end();
    }
  };
  return {
    available,
    stream,
    stopAll: () => {
      for (const stop of active.values()) stop();
    },
  };
}
