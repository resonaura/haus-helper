import { MediaQueue } from "./media-queue.mjs";
import {
  PLAYBACK_VERSION,
  playbackArguments,
  inspectCadence,
} from "./playback.mjs";
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
import { createHash, randomUUID } from "node:crypto";
import { runMedia, probe, sourceHasAudio } from "./media.mjs";
import { inspectAudioAlignment } from "./playback-audio.mjs";
export class Recorder {
  constructor(config, ha, store, onChange = () => {}, { prepareRemote } = {}) {
    this.config = config;
    this.ha = ha;
    this.store = store;
    this.onChange = onChange;
    this.prepareRemote = prepareRemote;
    this.remotePreparing = new Map();
    this.buffers = new Map();
    this.active = new Map();
    this.finalizing = new Set();
    this.playbackJobs = new Map();
    this.encoding = new MediaQueue();
    this.playbackPriorities = new Map();
    this.playbackAbort = new AbortController();
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
        const parts = await this.segments({
          dir: this.bufferDirectory(event.cameraId),
        });
        if (
          parts.some(
            (part) =>
              part.end >= event.startAt - this.config.pre_roll_seconds * 1000 &&
              part.start <= event.endAt,
          )
        ) {
          // Ring segments survive upgrades; recovery must not delay fresh capture.
          this.finalizing.add(event.id);
          void this.finish(event)
            .finally(() => this.finalizing.delete(event.id))
            .catch(() => {});
        } else
          this.store.finish(event.id, {
            status: "interrupted",
            error: "Recording interrupted by a restart",
          });
      }
    }
    this.timer = setInterval(() => void this.tick(), 2000);
  }
  bufferDirectory(id) {
    return join(
      this.config.data,
      "buffer",
      createHash("sha256").update(id).digest("hex").slice(0, 20),
    );
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
        buffer.probeAbort?.abort();
        this.terminateBuffer(buffer);
        clearTimeout(buffer.retry);
        this.buffers.delete(id);
      }
    }
    for (const id of enabled)
      if (!this.buffers.has(id)) {
        const buffer = {
          id,
          dir: this.bufferDirectory(id),
          status: "starting",
          stopped: false,
        };
        this.buffers.set(id, buffer);
        void this.startBuffer(buffer);
      }
  }
  terminateBuffer(buffer) {
    const child = buffer.process;
    if (!child || buffer.killTimer) return;
    child.kill("SIGTERM");
    buffer.killTimer = setTimeout(() => {
      if (buffer.process === child) child.kill("SIGKILL");
    }, 3000);
    buffer.killTimer.unref();
    child.once("close", () => {
      clearTimeout(buffer.killTimer);
      buffer.killTimer = undefined;
    });
  }
  async startBuffer(buffer) {
    if (this.stopped || buffer.stopped) return;
    try {
      const available = await statfs(this.config.media);
      if (available.bavail * available.bsize < 256 * 1024 ** 2)
        throw new Error("insufficient_storage");
      await mkdir(buffer.dir, { recursive: true, mode: 0o700 });
      const camera = this.cameras?.find((item) => item.id === buffer.id) ?? {
        id: buffer.id,
      };
      const allowDirect =
        (buffer.directFailures ?? 0) < 3 ||
        Date.now() - (buffer.directAttempt ?? 0) > 300000;
      const input = this.ha.recordingInput
        ? await this.ha.recordingInput(camera, allowDirect)
        : {
            url: await this.ha.stream(buffer.id),
            kind: "ha",
            token: this.config.token,
            inputArguments: ["-live_start_index", "-1", "-re"],
          };
      if (input.kind === "rtsp") buffer.directAttempt = Date.now();
      buffer.inputKind = input.kind;
      if (this.stopped || buffer.stopped) return;
      if (this.config.record_audio) {
        const abort = new AbortController();
        buffer.probeAbort = abort;
        buffer.expectedAudio = await sourceHasAudio(
          input.url,
          input.token,
          AbortSignal.any([abort.signal, this.playbackAbort.signal]),
          input.inputArguments,
        ).catch(() => undefined);
        if (buffer.probeAbort === abort) buffer.probeAbort = undefined;
      }
      if (this.stopped || buffer.stopped) return;
      const prefix = `b${Date.now()}-${randomUUID().slice(0, 8)}`;
      buffer.listName = `${prefix}.csv`;
      const child = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-progress",
          "pipe:1",
          "-stats_period",
          "1",
          /^rtsps?:/.test(input.url) ? "-timeout" : "-rw_timeout",
          "15000000",
          "-analyzeduration",
          "8000000",
          "-probesize",
          "8000000",
          ...input.inputArguments,
          ...(input.token
            ? ["-headers", `Authorization: Bearer ${input.token}\r\n`]
            : []),
          "-i",
          input.url,
          "-map",
          "0:v:0",
          ...(this.config.record_audio
            ? [
                "-map",
                buffer.expectedAudio ? "0:a:0" : "0:a?",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
              ]
            : ["-an"]),
          "-c:v",
          "copy",
          "-f",
          "segment",
          "-segment_time",
          "2",
          "-reset_timestamps",
          "1",
          "-segment_list",
          join(buffer.dir, buffer.listName),
          "-segment_list_type",
          "csv",
          "-segment_list_size",
          "512",
          join(buffer.dir, `${prefix}-%09d.mp4`),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TZ: "UTC" },
        },
      );
      buffer.process = child;
      buffer.status = "starting";
      buffer.lastAdvance = Date.now();
      buffer.segmentStartedAt = Date.now();
      buffer.lastSegmentAt = undefined;
      buffer.lastFrame = -1;
      buffer.lastError = undefined;
      let progress = "";
      child.stdout.on("data", (chunk) => {
        progress = (progress + chunk.toString()).slice(-8192);
        const lines = progress.split("\n");
        progress = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^frame=(\d+)/.exec(line);
          if (match && Number(match[1]) > buffer.lastFrame) {
            buffer.lastFrame = Number(match[1]);
            buffer.lastAdvance = Date.now();
            if (buffer.lastFrame > 0) {
              buffer.status = "buffering";
              buffer.failures = 0;
              if (buffer.lastFrame >= 120 && input.kind === "rtsp")
                buffer.directFailures = 0;
            }
          }
        }
      });
      child.stderr.on("data", () => {});
      const exited = () => {
        if (buffer.process !== child) return;
        clearTimeout(buffer.killTimer);
        buffer.process = undefined;
        if (input.kind === "rtsp")
          buffer.directFailures = (buffer.directFailures ?? 0) + 1;
        buffer.status = "reconnecting";
        if (!buffer.stopped && !this.stopped)
          buffer.retry = setTimeout(
            () => void this.startBuffer(buffer),
            Math.min(
              30000,
              2000 *
                2 **
                  Math.min((buffer.failures = (buffer.failures ?? 0) + 1), 4),
            ),
          );
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
    const names = (await readdir(buffer.dir).catch(() => [])).filter(
      (name) => name === "index.csv" || /^b\d{13}-[a-f0-9]{8}\.csv$/.test(name),
    );
    const parts = await Promise.all(
      names.map(async (name) => {
        const csv = await readFile(join(buffer.dir, name), "utf8").catch(
          () => "",
        );
        // A camera's RTP clock can jump or drift independently of wall time.
        // Completed file mtimes track local receipt times, including
        // reconnects; never project hours of source timestamp drift onto events.
        return (
          await Promise.all(
            parseSegments(csv, buffer.dir).map(async (part) => {
              const info = await stat(part.path).catch(() => null);
              if (!info?.size) return undefined;
              const duration = part.end - part.start;
              return {
                ...part,
                start: info.mtimeMs - duration,
                end: info.mtimeMs,
              };
            }),
          )
        ).filter(Boolean);
      }),
    );
    // Old versions could list the same overwritten wall-clock file more than once.
    // Never concatenate one physical segment twice, including across reconnects.
    return [
      ...new Map(parts.flat().map((part) => [part.path, part])).values(),
    ].sort((a, b) => a.start - b.start || a.path.localeCompare(b.path));
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
        const csv = buffer.listName
          ? await readFile(join(buffer.dir, buffer.listName), "utf8").catch(
              () => "",
            )
          : "";
        const completed = parseSegments(csv, buffer.dir).at(-1);
        if (completed) {
          const info = await stat(completed.path).catch(() => null);
          if (info?.size) buffer.lastSegmentAt = info.mtimeMs;
        }
        if (
          buffer.process &&
          !buffer.killTimer &&
          (now - (buffer.lastAdvance ?? now) > 30000 ||
            now - (buffer.lastSegmentAt ?? buffer.segmentStartedAt ?? now) >
              30000)
        ) {
          buffer.status = "reconnecting";
          buffer.lastError = "Camera media stopped advancing; reconnecting";
          this.terminateBuffer(buffer);
        }
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
          const isList =
            name === "index.csv" || /^b\d{13}-[a-f0-9]{8}\.csv$/.test(name);
          if (isList) {
            if (name !== buffer.listName) {
              const list = join(buffer.dir, name);
              if ((await stat(list).catch(() => null))?.mtimeMs < cutoff)
                await unlink(list).catch(() => {});
            }
            continue;
          }
          if (!/^(?:\d{8}T\d{6}|b\d{13}-[a-f0-9]{8}-\d{9,})\.mp4$/.test(name))
            continue;
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
          this.terminateBuffer(buffer);
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
      const output = this.store.path(event.id);
      const temporary = output.replace(".mp4", ".partial.mp4");
      let packetCopy = false;
      await writeFile(
        manifest,
        ready
          .map(
            (part) =>
              `file '${part.path.replaceAll("'", "'\\''")}'\nduration ${((part.end - part.start) / 1000).toFixed(6)}`,
          )
          .join("\n"),
        { mode: 0o600 },
      );
      try {
        await this.encoding.run(async () => {
          // One FFmpeg process keeps a fixed output codec. Check each ring
          // generation, including reconnects, before copying its H264 packets.
          const sources = new Map(
            ready.map((part) => [
              part.path.replace(/-\d{9,}\.mp4$/, ""),
              part.path,
            ]),
          );
          let copyVideo = true;
          for (const source of sources.values()) {
            if ((await probe(source)).codec !== "h264") {
              copyVideo = false;
              break;
            }
          }
          packetCopy = copyVideo;
          return runMedia(
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
              ...(this.config.record_audio
                ? ["-c:a", "aac", "-b:a", "96k"]
                : ["-an"]),
              ...playbackArguments({ copyVideo }),
              temporary,
            ],
            {
              timeout: Math.max(120000, this.config.max_event_seconds * 1500),
              signal: this.playbackAbort.signal,
            },
          );
        }, 10);
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
          { timeout: 20000, signal: this.playbackAbort.signal },
        ).catch(() => {});
        const file = await stat(output);
        this.store.finish(event.id, {
          duration: info.duration,
          bytes: file.size,
          playbackVersion: packetCopy ? 0 : PLAYBACK_VERSION,
          // The event starts at detection; the file starts in the pre-event ring.
          // Persist the actual boundary, including a keyframe-aligned extra segment.
          mediaStartAt: Math.round(ready[0].start),
          error:
            ready.at(-1).end < event.endAt - 8000
              ? "Partial recording: the camera stream stopped"
              : null,
        });
        this.store.setPlayback(event.id, 0, packetCopy ? 0 : PLAYBACK_VERSION, {
          audio: info.audio,
          sourceAudioMissing: this.config.record_audio && !info.audio,
        });
      } finally {
        await unlink(manifest).catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    } catch (error) {
      if (this.stopped) return;
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
      audioExpected: buffer.expectedAudio,
      inputKind: buffer.inputKind,
      lastSegmentAt: buffer.lastSegmentAt,
    }));
  }
  processingStatus() {
    const remoteAt = Math.min(...this.remotePreparing.values());
    return {
      active: this.encoding.active || this.remotePreparing.size > 0,
      activeKind: this.encoding.activeWork
        ? this.encoding.activeWork.priority >= 20
          ? "playback"
          : this.encoding.activeWork.priority >= 10
            ? "capture"
            : "prefetch"
        : this.remotePreparing.size
          ? "nvr-playback"
          : undefined,
      elapsedMs: this.encoding.activeWork
        ? Math.max(0, Date.now() - this.encoding.activeWork.startedAt)
        : this.remotePreparing.size
          ? Math.max(0, Date.now() - remoteAt)
          : 0,
      remote: this.remotePreparing.size,
      queued: this.encoding.pending.length,
      preparing: this.playbackJobs.size,
    };
  }
  async preparePlayback(event, priority = 20) {
    if (event.playbackVersion === PLAYBACK_VERSION)
      return this.store.path(
        event.id,
        event.playbackBytes ? "playback.mp4" : "mp4",
      );
    if (this.playbackJobs.has(event.id)) {
      const existing = this.playbackPriorities.get(event.id);
      if (existing) existing.value = Math.max(existing.value, priority);
      this.encoding.promote(event.id, priority);
      return this.playbackJobs.get(event.id);
    }
    if (this.playbackJobs.size >= 4) throw new Error("playback_queue_busy");
    const urgency = { value: priority };
    this.playbackPriorities.set(event.id, urgency);
    const job = (async () => {
      const output = this.store.path(event.id, "playback.mp4");
      const temporary = output.replace(".mp4", ".partial.mp4");
      try {
        const diagnostics = await inspectCadence(this.store.path(event.id));
        const alignment = await inspectAudioAlignment(
          this.store.path(event.id),
          (event.endAt - (event.mediaStartAt ?? event.startAt)) / 1000,
        );
        let remote = false;
        if (event.playbackVersion !== 2 && this.prepareRemote) {
          this.remotePreparing.set(event.id, Date.now());
          try {
            remote = await this.prepareRemote(event, {
              output: temporary,
              audioTrimSeconds: alignment.audioTrimSeconds,
              signal: this.playbackAbort.signal,
            });
          } catch (error) {
            if (this.playbackAbort.signal.aborted) throw error;
          } finally {
            this.remotePreparing.delete(event.id);
          }
        }
        if (!remote)
          await this.encoding.run(
            () =>
              runMedia(
                "ffmpeg",
                [
                  "-hide_banner",
                  "-loglevel",
                  "error",
                  "-nostdin",
                  "-y",
                  "-i",
                  this.store.path(event.id),
                  ...playbackArguments({
                    // Version 3 also described unnormalized packet copies.
                    // Only version 2 guarantees the earlier normalized video.
                    copyVideo: event.playbackVersion === 2,
                    audioTrimSeconds: alignment.audioTrimSeconds,
                  }),
                  temporary,
                ],
                {
                  timeout: Math.max(120000, event.duration * 2000),
                  signal: this.playbackAbort.signal,
                },
              ),
            urgency.value,
            event.id,
          );
        const info = await probe(temporary);
        if (info.duration < 0.1) throw new Error("empty_video");
        await rename(temporary, output);
        this.store.setPlayback(
          event.id,
          (await stat(output)).size,
          PLAYBACK_VERSION,
          {
            ...event.playbackInfo,
            ...diagnostics,
            ...alignment,
            duration: info.duration,
            audio: info.audio,
            sourceAudioMissing: this.config.record_audio && !info.audio,
          },
        );
        return output;
      } finally {
        await unlink(temporary).catch(() => {});
        this.playbackJobs.delete(event.id);
        this.playbackPriorities.delete(event.id);
      }
    })();
    this.playbackJobs.set(event.id, job);
    return job;
  }
  async stop() {
    this.stopped = true;
    this.playbackAbort.abort();
    this.encoding.stop();
    await Promise.allSettled([...this.playbackJobs.values()]);
    clearInterval(this.timer);
    for (const buffer of this.buffers.values()) {
      buffer.stopped = true;
      buffer.probeAbort?.abort();
      clearTimeout(buffer.retry);
      this.terminateBuffer(buffer);
    }
    const deadline = Date.now() + 5000;
    while (
      (this.finalizing.size ||
        [...this.buffers.values()].some(
          (buffer) => buffer.process && buffer.process.exitCode === null,
        )) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function parseSegments(csv, directory) {
  const segments = new Map();
  for (const line of csv.trim().split("\n")) {
    const row = /^"?([^",]+\.mp4)"?,([\d.]+),([\d.]+)$/.exec(line);
    if (!row) continue;
    const name = row[1].split("/").at(-1);
    const sequential = /^b(\d{13})-[a-f0-9]{8}-\d{9,}\.mp4$/.exec(name);
    const legacy = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.mp4$/.exec(
      name,
    );
    const from = Number(row[2]),
      to = Number(row[3]);
    if (
      (!sequential && !legacy) ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to <= from
    )
      continue;
    const start = sequential
      ? Number(sequential[1]) + from * 1000
      : Date.UTC(
          ...legacy
            .slice(1)
            .map((value, index) =>
              index === 1 ? Number(value) - 1 : Number(value),
            ),
        );
    const path = join(directory, name);
    if (Number.isFinite(start))
      segments.set(path, { path, start, end: start + (to - from) * 1000 });
  }
  return [...segments.values()];
}
