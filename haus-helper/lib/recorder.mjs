import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
  rename,
  stat,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runMedia, probe } from "./media.mjs";
export class Recorder {
  constructor(config, ha, store, onChange = () => {}) {
    this.config = config;
    this.ha = ha;
    this.store = store;
    this.onChange = onChange;
    this.buffers = new Map();
    this.active = new Map();
    this.finalizing = new Set();
    this.stopped = false;
    this.tickBusy = false;
  }
  async initialize() {
    for (const event of this.store.recording()) {
      try {
        const info = await probe(this.store.path(event.id));
        const file = await stat(this.store.path(event.id));
        this.store.finish(event.id, {
          duration: info.duration,
          bytes: file.size,
        });
      } catch {
        this.store.finish(event.id, {
          status: "interrupted",
          error: "Recording interrupted by a restart",
        });
      }
    }
    this.timer = setInterval(() => void this.tick(), 2000);
  }
  sync(cameras) {
    this.cameras = cameras;
    const enabled = new Set(
      cameras
        .filter(
          (camera) =>
            camera.enabled && camera.available && this.config.recording_enabled,
        )
        .map((camera) => camera.id),
    );
    for (const [id, buffer] of this.buffers) {
      if (!enabled.has(id)) {
        buffer.stopped = true;
        buffer.process?.kill("SIGTERM");
        clearTimeout(buffer.retry);
        this.buffers.delete(id);
      }
    }
    for (const id of enabled)
      if (!this.buffers.has(id)) {
        const buffer = {
          id,
          dir: join(
            this.config.data,
            "buffer",
            createHash("sha256").update(id).digest("hex").slice(0, 20),
          ),
          status: "starting",
          stopped: false,
        };
        this.buffers.set(id, buffer);
        void this.startBuffer(buffer);
      }
  }
  async startBuffer(buffer) {
    if (this.stopped || buffer.stopped) return;
    try {
      const available = await statfs(this.config.media);
      if (available.bavail * available.bsize < 256 * 1024 ** 2)
        throw new Error("insufficient_storage");
      await mkdir(buffer.dir, { recursive: true, mode: 0o700 });
      const url = await this.ha.stream(buffer.id);
      if (this.stopped || buffer.stopped) return;
      const child = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-rw_timeout",
          "15000000",
          "-live_start_index",
          "-3",
          "-headers",
          `Authorization: Bearer ${this.config.token}\r\n`,
          "-i",
          url,
          "-map",
          "0:v:0",
          ...(this.config.record_audio
            ? ["-map", "0:a?", "-c:a", "aac", "-b:a", "96k"]
            : ["-an"]),
          "-c:v",
          "copy",
          "-f",
          "segment",
          "-segment_time",
          "2",
          "-reset_timestamps",
          "1",
          "-strftime",
          "1",
          "-segment_list",
          join(buffer.dir, "index.csv"),
          "-segment_list_type",
          "csv",
          "-segment_list_size",
          "512",
          join(buffer.dir, "%Y%m%dT%H%M%S.mp4"),
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: { ...process.env, TZ: "UTC" },
        },
      );
      buffer.process = child;
      buffer.status = "buffering";
      buffer.lastError = undefined;
      child.stderr.on("data", () => {});
      const exited = () => {
        if (buffer.process !== child) return;
        buffer.process = undefined;
        buffer.status = "reconnecting";
        if (!buffer.stopped && !this.stopped)
          buffer.retry = setTimeout(() => void this.startBuffer(buffer), 15000);
      };
      child.once("error", exited);
      child.once("close", exited);
      this.onChange();
    } catch (error) {
      buffer.status = "unavailable";
      buffer.lastError =
        error.message === "insufficient_storage"
          ? "Storage needs free space"
          : "Camera stream unavailable";
      if (!this.stopped && !buffer.stopped)
        buffer.retry = setTimeout(() => void this.startBuffer(buffer), 20000);
    }
  }
  trigger(cameraId, kind = "manual", sensorId, at = Date.now()) {
    const camera = this.cameras?.find((item) => item.id === cameraId);
    if (!camera?.enabled || !camera.available || !this.config.recording_enabled)
      throw new Error("recording_disabled");
    const endAt = at + this.config.post_roll_seconds * 1000;
    const current = this.active.get(cameraId);
    if (
      current &&
      at - current.startAt < this.config.max_event_seconds * 1000
    ) {
      const event = this.store.extend(
        current.id,
        kind,
        at,
        Math.min(endAt, current.startAt + this.config.max_event_seconds * 1000),
        sensorId,
      );
      this.active.set(cameraId, event);
      this.onChange();
      return event;
    }
    const event = this.store.create(cameraId, kind, at, endAt, sensorId);
    this.active.set(cameraId, event);
    this.onChange();
    return event;
  }
  async segments(buffer) {
    try {
      const csv = await readFile(join(buffer.dir, "index.csv"), "utf8");
      return csv
        .trim()
        .split("\n")
        .flatMap((line) => {
          const match = /^"?([^",]+\.mp4)"?,([\d.]+),([\d.]+)$/.exec(line);
          if (!match) return [];
          const name = match[1].split("/").at(-1);
          if (!/^\d{8}T\d{6}\.mp4$/.test(name)) return [];
          const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(
            name,
          );
          const at = Date.UTC(
            ...time
              .slice(1)
              .map((value, index) =>
                index === 1 ? Number(value) - 1 : Number(value),
              ),
          );
          return [
            {
              path: join(buffer.dir, name),
              start: at,
              end: at + Math.max(0, Number(match[3]) - Number(match[2])) * 1000,
            },
          ];
        });
    } catch {
      return [];
    }
  }
  async tick() {
    if (this.tickBusy || this.stopped) return;
    this.tickBusy = true;
    try {
      const now = Date.now();
      for (const event of this.store.recording()) {
        if (this.finalizing.has(event.id)) continue;
        const camera = this.cameras?.find((item) => item.id === event.cameraId);
        const activeSensors =
          camera?.enabled && camera.available && this.config.recording_enabled
            ? camera.sensors.filter((sensor) => sensor.active)
            : [];
        const held =
          activeSensors.length > 0 &&
          this.active.get(event.cameraId)?.id === event.id;
        if (
          held &&
          now < event.startAt + this.config.max_event_seconds * 1000
        ) {
          this.store.extendTail(
            event.id,
            Math.min(
              now + this.config.post_roll_seconds * 1000,
              event.startAt + this.config.max_event_seconds * 1000,
            ),
          );
          continue;
        }
        if (held)
          for (const sensor of activeSensors)
            this.trigger(event.cameraId, sensor.kind, sensor.id, now);
        if (now >= event.endAt + 8000) {
          this.finalizing.add(event.id);
          if (this.active.get(event.cameraId)?.id === event.id)
            this.active.delete(event.cameraId);
          void this.finish(event).finally(() =>
            this.finalizing.delete(event.id),
          );
        }
      }
      for (const buffer of this.buffers.values()) {
        const pinned = this.store
          .recording()
          .filter((event) => event.cameraId === buffer.id)
          .map((event) => event.startAt - this.config.pre_roll_seconds * 1000);
        const cutoff = Math.min(
          now - (this.config.pre_roll_seconds + 12) * 1000,
          ...pinned,
        );
        let total = 0;
        for (const name of await readdir(buffer.dir).catch(() => [])) {
          if (!/^\d{8}T\d{6}\.mp4$/.test(name)) continue;
          const file = join(buffer.dir, name);
          const info = await stat(file).catch(() => null);
          if (!info) continue;
          total += info.size;
          if (info.mtimeMs < cutoff) await unlink(file).catch(() => {});
        }
        if (
          total >
          (this.config.max_buffer_gb * 1024 ** 3) /
            Math.max(1, this.buffers.size)
        ) {
          buffer.status = "storage-limit";
          buffer.process?.kill("SIGTERM");
          for (const event of this.store
            .recording()
            .filter((item) => item.cameraId === buffer.id))
            this.store.finish(event.id, {
              status: "failed",
              error: "Buffer storage limit reached",
            });
          this.active.delete(buffer.id);
        }
      }
    } catch {
      /* Retry transient disk errors on the next tick. */
    } finally {
      this.tickBusy = false;
    }
  }
  async finish(event) {
    const buffer = this.buffers.get(event.cameraId) ?? {
      dir: join(
        this.config.data,
        "buffer",
        createHash("sha256").update(event.cameraId).digest("hex").slice(0, 20),
      ),
    };
    try {
      const segments = buffer
        ? (await this.segments(buffer)).filter(
            (part) =>
              part.end >= event.startAt - this.config.pre_roll_seconds * 1000 &&
              part.start <= event.endAt,
          )
        : [];
      const ready = [];
      for (const part of segments)
        if (await stat(part.path).catch(() => null)) ready.push(part);
      if (!ready.length) throw new Error("no_video");
      const manifest = join(this.config.data, `${event.id}.concat`);
      await writeFile(
        manifest,
        ready
          .map((part) => `file '${part.path.replaceAll("'", "'\\''")}'`)
          .join("\n"),
        { mode: 0o600 },
      );
      try {
        const codec = (await probe(ready[0].path)).codec;
        const output = this.store.path(event.id);
        const temporary = output.replace(".mp4", ".partial.mp4");
        await runMedia(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            manifest,
            ...(this.config.record_audio ? ["-c:a", "copy"] : ["-an"]),
            "-c:v",
            ...(codec === "h264"
              ? ["copy"]
              : [
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-crf",
                  "23",
                  "-pix_fmt",
                  "yuv420p",
                ]),
            "-movflags",
            "+faststart",
            temporary,
          ],
          { timeout: Math.max(120000, this.config.max_event_seconds * 1500) },
        );
        const info = await probe(temporary);
        if (info.duration < 0.1) throw new Error("empty_video");
        await rename(temporary, output);
        await runMedia(
          "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            String(Math.min(2, info.duration / 2)),
            "-i",
            output,
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2:flags=area",
            this.store.path(event.id, "jpg"),
          ],
          { timeout: 20000 },
        ).catch(() => {});
        const file = await stat(output);
        this.store.finish(event.id, {
          duration: info.duration,
          bytes: file.size,
          error:
            ready.at(-1).end < event.endAt - 8000
              ? "Partial recording: the camera stream stopped"
              : null,
        });
      } finally {
        await unlink(manifest).catch(() => {});
      }
    } catch (error) {
      this.store.finish(event.id, {
        status: "failed",
        error:
          error.message === "no_video"
            ? "No camera video was available for this event"
            : "Video could not be finalized",
      });
    }
    this.onChange();
  }
  status() {
    return [...this.buffers.values()].map((buffer) => ({
      cameraId: buffer.id,
      status: buffer.status,
      error: buffer.lastError,
    }));
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const buffer of this.buffers.values()) {
      buffer.stopped = true;
      clearTimeout(buffer.retry);
      buffer.process?.kill("SIGTERM");
    }
    const deadline = Date.now() + 5000;
    while (this.finalizing.size && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
