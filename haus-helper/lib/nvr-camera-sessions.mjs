import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nodeJson, nodeRequest } from "./node-client.mjs";
import { directRecordingInput } from "./recording-input.mjs";
import { probe, runMedia } from "./media.mjs";
import {
  inspectOriginalPlayback,
  ORIGINAL_POLICY_VERSION,
} from "./playback-compatible.mjs";
import { PLAYBACK_VERSION } from "./playback.mjs";

const ownerId = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const privateIp = (value) =>
  isIP(value) === 4 &&
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const missing = (message) => new Error(message);

function eufyRtspSelected(camera, states, entities) {
  const entries = new Map(entities.map((entry) => [entry.entity_id, entry]));
  const names = new Set(
    [camera.id, ...(camera.aliases ?? [])].map(
      (id) => `sensor.${id.split(".")[1].replace(/_internal$/, "")}_stream_provider`,
    ),
  );
  const devices = new Set(
    [camera.deviceId, ...(camera.deviceIds ?? [])].filter(Boolean),
  );
  const providers = states.filter(
    (state) =>
      /^sensor\..*_stream_provider$/.test(state.entity_id) &&
      !entries.get(state.entity_id)?.disabled_by &&
      (names.has(state.entity_id) ||
        devices.has(entries.get(state.entity_id)?.device_id)),
  );
  const exact = providers.filter((state) => names.has(state.entity_id));
  const selected = exact.length ? exact : providers;
  return selected.length === 1 && selected[0].state === "RTSP";
}

/** Explicit protected restream telemetry only. Never ask HA to manufacture HLS. */
export function nvrCameraSource(camera, registry) {
  const states = registry.states ?? [],
    entities = registry.entities ?? [];
  const url = directRecordingInput(camera, states, entities);
  if (!url) throw missing("camera_rtsp_source_unavailable");
  const p2p = states.some((state) => {
    try {
      return (
        /_p2p_rtsp_stream$/.test(state.entity_id) &&
        new URL(state.state).href === url
      );
    } catch {
      return false;
    }
  });
  const identity = camera.playbackSource;
  const vendor = `${identity?.platform ?? ""} ${identity?.manufacturer ?? ""}`;
  // Aqara's native RTSP endpoint must never replace its protected P2P restream.
  // Eufy's integration can explicitly select RTSP; honor that choice without
  // accepting a stale RTSP URL while its active provider is P2P or unavailable.
  // directRecordingInput still pins any camera with P2P telemetry to that route.
  if (
    !p2p &&
    (/aqara/i.test(vendor) ||
      (/eufy/i.test(vendor) && !eufyRtspSelected(camera, states, entities)))
  )
    throw missing("camera_protected_p2p_source_required");
  const parsed = new URL(url);
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname))
    throw missing("camera_source_not_reachable_by_nvr");
  return { kind: p2p ? "p2p-restream" : "rtsp", url };
}

/** Controller-only credentials and owner leases; one NVR owns camera media. */
export class NvrCameraSessions {
  constructor({
    config,
    store,
    cluster,
    registry,
    now = Date.now,
    json = nodeJson,
    request = nodeRequest,
    inspect = probe,
    resolve = lookup,
  }) {
    Object.assign(this, {
      config,
      store,
      cluster,
      registry,
      now,
      json,
      request,
      inspect,
      resolve,
    });
    this.buffers = new Map();
    this.entries = new Map();
    this.revisions = new Map();
    this.pending = new Map();
    this.nodeReservations = new Map();
    this.viewers = new Map();
    this.closedViewers = new Map();
    this.events = new Map();
    this.eventPending = new Map();
    this.abort = new AbortController();
    this.recordingOwner = `recording-${randomUUID()}`;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS nvr_camera_events(event_id TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    for (const row of store.db
      .prepare("SELECT event_id,value FROM nvr_camera_events")
      .all()) {
      try {
        this.events.set(row.event_id, JSON.parse(row.value));
      } catch {}
    }
  }
  camera(id) {
    return this.registry().cameras.find(
      (camera) => camera.id === id || camera.aliases?.includes(id),
    );
  }
  nodeLoad(node) {
    const remote = this.cluster.health.get(node.id)?.remote;
    const capability = remote?.rtspSessions;
    const managed = new Set(
      [...this.entries.values()]
        .filter((entry) => entry.node.id === node.id)
        .map((entry) => entry.id),
    ).size;
    return {
      remote,
      capability,
      active:
        Math.max(capability?.active ?? 0, managed) +
        (this.nodeReservations.get(node.id) ?? 0),
    };
  }
  candidates() {
    return this.cluster
      .nodes()
      .filter((node) => {
        const health = this.cluster.health.get(node.id);
        const { remote, capability, active } = this.nodeLoad(node);
        return (
          node.enabled &&
          node.roles.includes("stream") &&
          health?.online &&
          capability?.profile === 1 &&
          capability.webrtc === true &&
          capability.recording === true &&
          capability.max > active &&
          !remote.resources?.pressured
        );
      })
      .sort((a, b) => {
        const score = (node) => {
          const { remote, capability, active } = this.nodeLoad(node);
          return (
            active / Math.max(1, capability.max) +
            (remote.host?.cpu?.usage ?? remote.resources?.cpu ?? 0)
          );
        };
        return score(a) - score(b);
      });
  }
  reserveNode(nodeId, delta) {
    const next = (this.nodeReservations.get(nodeId) ?? 0) + delta;
    if (next > 0) this.nodeReservations.set(nodeId, next);
    else this.nodeReservations.delete(nodeId);
  }
  validNode(node) {
    return (
      this.cluster
        .nodes()
        .some(
          (current) =>
            current.id === node.id &&
            current.enabled &&
            current.roles.includes("stream"),
        ) && this.cluster.health.get(node.id)?.online
    );
  }
  async advertiseHost(node) {
    const host = new URL(node.url).hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await this.resolve(host, { all: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) => !privateIp(address))
    )
      throw missing("camera_node_private_address_required");
    return addresses[0].address;
  }
  sync(cameras) {
    this.cameras = cameras;
    const wanted = new Set(
      cameras
        .filter(
          (camera) =>
            camera.enabled && camera.available && this.config.recording_enabled,
        )
        .map((camera) => camera.id),
    );
    for (const [id, buffer] of this.buffers)
      if (!wanted.has(id)) {
        buffer.stopped = true;
        this.buffers.delete(id);
        void this.release(id, this.recordingOwner);
      }
    for (const id of wanted)
      if (!this.buffers.has(id))
        this.buffers.set(id, {
          id,
          status: "starting",
          stopped: false,
          inputKind: "nvr-rtsp",
        });
    for (const entry of this.entries.values())
      if (
        !cameras.some(
          (camera) => camera.id === entry.cameraId && camera.available,
        )
      )
        void this.release(entry.cameraId, entry.owner);
    void this.tick().catch(() => {});
  }
  async ensure(camera, owner, preview = false, preferredNode) {
    if (this.stopped) throw missing("camera_sessions_stopped");
    if (!ownerId(owner)) throw missing("invalid_warm_session");
    if (!camera?.available) throw missing("camera_unavailable");
    if (preview && camera.batteryPowered)
      throw missing("camera_battery_preview_disabled");
    const source = nvrCameraSource(camera, this.registry());
    const key = `${camera.id}:${owner}`;
    const revision = this.revisions.get(key) ?? 0;
    const prior = this.pending.get(key);
    if (prior) {
      await prior.catch(() => {});
      if ((this.revisions.get(key) ?? 0) !== revision)
        throw missing("camera_session_cancelled");
      return this.ensure(camera, owner, preview, preferredNode);
    }
    const task = this.acquire(
      camera,
      owner,
      source,
      key,
      preferredNode,
      revision,
    );
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }
  async acquire(camera, owner, source, key, preferredNode, revision) {
    const old = this.entries.get(key);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex");
    if (old && old.fingerprint === fingerprint && this.validNode(old.node)) {
      old.until = this.now() + 60000;
      if (
        this.now() - old.renewedAt <
        (owner === this.recordingOwner ? 3000 : 15000)
      )
        return old;
      try {
        const value = await this.json(
          old.node,
          `/v1/cameras/sessions/${old.id}/lease`,
          {
            method: "POST",
            data: { owner },
            signal: this.abort.signal,
            timeout: 10000,
          },
        );
        this.validateSession(value);
        const entry = {
          ...old,
          id: value.id,
          state: value.state,
          renewedAt: this.now(),
          until: this.now() + 60000,
          audio: value.audio,
        };
        if (this.stopped || (this.revisions.get(key) ?? 0) !== revision) {
          await this.releaseEntry(entry);
          throw missing("camera_session_cancelled");
        }
        this.entries.set(key, entry);
        this.updateBuffer(entry);
        return entry;
      } catch {}
    }
    const choices = preferredNode
      ? this.candidates().filter((node) => node.id === preferredNode.id)
      : this.candidates();
    const shared = [...this.entries.values()].find(
      (entry) =>
        entry.cameraId === camera.id &&
        entry.fingerprint === fingerprint &&
        this.validNode(entry.node) &&
        (!preferredNode || entry.node.id === preferredNode.id),
    );
    if (shared && !choices.some((node) => node.id === shared.node.id))
      choices.unshift(shared.node);
    if (
      old &&
      this.validNode(old.node) &&
      (!preferredNode || old.node.id === preferredNode.id) &&
      !choices.some((node) => node.id === old.node.id)
    )
      choices.unshift(old.node);
    for (const node of choices.slice(0, 3)) {
      this.reserveNode(node.id, 1);
      try {
        const value = await this.json(node, "/v1/cameras/sessions", {
          method: "POST",
          data: {
            cameraId: camera.id,
            source,
            owner,
            advertiseHost: await this.advertiseHost(node),
            preRollSeconds: this.config.pre_roll_seconds,
            requireAudio: this.config.record_audio !== false,
            recordAudio: this.config.record_audio !== false,
          },
          signal: this.abort.signal,
          timeout: 15000,
        });
        this.validateSession(value);
        const entry = {
          node,
          id: value.id,
          cameraId: camera.id,
          owner,
          fingerprint,
          state: value.state,
          renewedAt: this.now(),
          until: this.now() + 60000,
          audio: value.audio,
        };
        if (this.stopped || (this.revisions.get(key) ?? 0) !== revision) {
          await this.releaseEntry(entry);
          throw missing("camera_session_cancelled");
        }
        this.entries.set(key, entry);
        this.updateBuffer(entry);
        return entry;
      } catch (error) {
        if (this.stopped || (this.revisions.get(key) ?? 0) !== revision)
          throw error;
      } finally {
        this.reserveNode(node.id, -1);
      }
    }
    throw missing(
      choices.length ? "camera_nvr_session_unavailable" : "camera_nvr_required",
    );
  }
  validateSession(value) {
    if (
      !uuid(value?.id) ||
      !["ready", "warming"].includes(value.state) ||
      value.capabilities?.webrtc !== true ||
      value.capabilities?.recording !== true
    )
      throw missing("invalid_camera_node_response");
  }
  updateBuffer(entry) {
    const buffer = this.buffers.get(entry.cameraId);
    if (buffer && entry.owner === this.recordingOwner) {
      buffer.status = entry.state === "ready" ? "buffering" : "starting";
      buffer.lastError = undefined;
      buffer.expectedAudio = this.config.record_audio !== false;
      if (entry.state === "ready") {
        buffer.lastAdvance = this.now();
        buffer.lastSegmentAt = this.now();
      }
    }
  }
  async touch(camera, owner, active, preview = false) {
    if (!ownerId(owner) || typeof active !== "boolean")
      throw missing("invalid_warm_session");
    if (!active) {
      await this.release(camera.id, owner);
      return { warm: false };
    }
    try {
      const entry = await this.ensure(camera, owner, preview);
      return {
        warm: true,
        transport: "nvr-webrtc",
        sessionId: entry.id,
        state: entry.state,
        expiresAt: entry.until,
      };
    } catch (error) {
      return { warm: false, reason: error.message };
    }
  }
  async releaseEntry(entry) {
    await this.request(entry.node, `/v1/cameras/sessions/${entry.id}`, {
      method: "DELETE",
      data: { owner: entry.owner },
      timeout: 5000,
    })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
  async release(cameraId, owner) {
    const key = `${cameraId}:${owner}`,
      entry = this.entries.get(key);
    this.entries.delete(key);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    for (const viewer of this.viewers.values())
      if (viewer.cameraId === cameraId && viewer.owner === owner)
        await this.closeViewer(cameraId, owner, viewer.viewerId);
    if (entry) await this.releaseEntry(entry);
  }
  async viewer(camera, owner, viewerId, offer) {
    if (
      !ownerId(owner) ||
      !uuid(viewerId) ||
      typeof offer !== "string" ||
      offer.length > 64000 ||
      !offer.startsWith("v=0")
    )
      throw missing("invalid_camera_viewer");
    const key = `${owner}:${viewerId}`;
    if (this.closedViewers.has(key)) throw missing("camera_viewer_closed");
    if (this.viewers.has(key)) throw missing("camera_viewer_exists");
    if (this.viewers.size >= 64) throw missing("camera_viewer_busy");
    const task = (async () => {
      const entry = await this.ensure(camera, owner);
      const result = await this.json(
        entry.node,
        `/v1/cameras/sessions/${entry.id}/webrtc`,
        {
          method: "POST",
          data: { owner, offer },
          signal: this.abort.signal,
          timeout: 20000,
        },
      );
      if (
        !uuid(result?.viewerId) ||
        result.answer?.type !== "answer" ||
        typeof result.answer.sdp !== "string" ||
        result.answer.sdp.length > 64000
      )
        throw missing("invalid_camera_viewer_response");
      const viewer = { ...entry, viewerId, remoteId: result.viewerId };
      if (this.stopped || this.closedViewers.has(key)) {
        await this.deleteViewer(viewer);
        throw missing("camera_viewer_closed");
      }
      this.viewers.set(key, viewer);
      return {
        answer: result.answer,
        candidates: Array.isArray(result.candidates)
          ? result.candidates.slice(0, 128)
          : [],
      };
    })();
    this.viewers.set(key, {
      cameraId: camera.id,
      owner,
      viewerId,
      pending: task,
    });
    try {
      return await task;
    } catch (error) {
      if (this.viewers.get(key)?.pending === task) this.viewers.delete(key);
      throw error;
    }
  }
  async deleteViewer(viewer) {
    await this.request(
      viewer.node,
      `/v1/cameras/sessions/${viewer.id}/viewers/${viewer.remoteId}`,
      { method: "DELETE", data: { owner: viewer.owner }, timeout: 5000 },
    )
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
  async closeViewer(cameraId, owner, viewerId) {
    if (!ownerId(owner) || !uuid(viewerId))
      throw missing("invalid_camera_viewer");
    const key = `${owner}:${viewerId}`;
    this.closedViewers.set(key, this.now() + 120000);
    if (this.closedViewers.size > 512)
      this.closedViewers.delete(this.closedViewers.keys().next().value);
    const viewer = this.viewers.get(key);
    if (viewer && viewer.cameraId !== cameraId)
      throw missing("camera_viewer_not_found");
    this.viewers.delete(key);
    if (viewer?.remoteId) await this.deleteViewer(viewer);
    return { closed: true };
  }
  async record(event) {
    const previous = this.eventPending.get(event.id);
    if (previous) {
      await previous.catch(() => {});
      return this.record(event);
    }
    const task = this.submitRecord(event);
    this.eventPending.set(event.id, task);
    try {
      return await task;
    } finally {
      if (this.eventPending.get(event.id) === task)
        this.eventPending.delete(event.id);
    }
  }
  async submitRecord(event) {
    let job = this.events.get(event.id);
    if (job && job.startAt <= event.startAt && job.endAt >= event.endAt)
      return job;
    if (!job) {
      const entry = await this.ensure(
        this.camera(event.cameraId),
        this.recordingOwner,
      );
      job = {
        nodeId: entry.node.id,
        id: entry.id,
        owner: entry.owner,
        cameraId: event.cameraId,
      };
    }
    const node = this.cluster.nodes().find((node) => node.id === job.nodeId);
    if (!node?.enabled) throw missing("camera_recording_node_unavailable");
    await this.json(node, `/v1/cameras/sessions/${job.id}/recordings`, {
      method: "POST",
      data: {
        owner: job.owner,
        eventId: event.id,
        startAt: event.startAt,
        endAt: event.endAt,
      },
      signal: this.abort.signal,
      timeout: 15000,
    });
    job = { ...job, startAt: event.startAt, endAt: event.endAt };
    this.events.set(event.id, job);
    this.store.db
      .prepare(
        "INSERT INTO nvr_camera_events(event_id,value)VALUES(?,?) ON CONFLICT(event_id)DO UPDATE SET value=excluded.value",
      )
      .run(event.id, JSON.stringify(job));
    return job;
  }
  async finalize(event) {
    const job = await this.record(event),
      node = this.cluster.nodes().find((node) => node.id === job.nodeId);
    if (!node?.enabled) throw missing("camera_recording_node_unavailable");
    const base = `/v1/cameras/sessions/${job.id}/recordings/${event.id}`;
    let result;
    const deadline = this.now() + 90000;
    do {
      result = await this.json(node, `${base}/status`, {
        method: "POST",
        data: { owner: job.owner },
        signal: this.abort.signal,
        timeout: 15000,
      });
      if (result.state === "failed") throw missing("camera_recording_failed");
      if (result.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this.abort.signal.throwIfAborted();
    } while (this.now() < deadline);
    if (
      result?.state !== "ready" ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes <= 0 ||
      result.bytes > 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(result.sha256 ?? "") ||
      !Number.isFinite(result.mediaStartAt) ||
      !Number.isFinite(result.duration) ||
      result.duration <= 0 ||
      typeof result.audio !== "boolean"
    )
      throw missing("invalid_camera_recording");
    if (this.config.record_audio !== false && !result.audio)
      throw missing("camera_recording_audio_missing");
    const output = this.store.path(event.id),
      temporary = output.replace(/\.mp4$/, ".nvr.partial.mp4");
    try {
      const response = await this.request(node, `${base}/media`, {
        method: "POST",
        data: { owner: job.owner },
        signal: this.abort.signal,
        timeout: 120000,
      });
      if (
        response.status !== 200 ||
        Number(response.headers.get("content-length")) !== result.bytes
      ) {
        await response.body?.cancel();
        throw missing("invalid_camera_recording");
      }
      let bytes = 0;
      const hash = createHash("sha256"),
        verify = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > result.bytes)
              return callback(missing("invalid_camera_recording"));
            hash.update(chunk);
            callback(null, chunk);
          },
        });
      await pipeline(
        Readable.fromWeb(response.body),
        verify,
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (bytes !== result.bytes || hash.digest("hex") !== result.sha256)
        throw missing("camera_recording_digest_mismatch");
      const info = await this.inspect(temporary);
      if (
        info.audio !== result.audio ||
        Math.abs(info.duration - result.duration) > 0.5 ||
        info.duration <= 0.1
      )
        throw missing("invalid_camera_recording");
      const provenance = this.camera(event.cameraId)?.playbackSource;
      const compatible = await inspectOriginalPlayback(
        temporary,
        {},
        provenance,
      ).catch(() => false);
      await rename(temporary, output);
      this.store.setPlayback(event.id, 0, compatible ? PLAYBACK_VERSION : 0, {
        audio: info.audio,
        originalProvenance: provenance,
        originalCompatible: compatible,
        originalPolicyVersion: compatible ? ORIGINAL_POLICY_VERSION : undefined,
        sourceAudioMissing: false,
      });
      this.store.finish(event.id, {
        duration: info.duration,
        bytes,
        mediaStartAt: Math.round(result.mediaStartAt),
        playbackVersion: compatible ? PLAYBACK_VERSION : 0,
      });
      await runMedia(
        "ffmpeg",
        [
          "-v",
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
        { timeout: 20000, signal: this.abort.signal },
      ).catch(() => {});
      this.events.delete(event.id);
      this.store.db
        .prepare("DELETE FROM nvr_camera_events WHERE event_id=?")
        .run(event.id);
      await this.request(node, base, {
        method: "DELETE",
        data: { owner: job.owner },
        timeout: 5000,
      })
        .then((r) => r.body?.cancel())
        .catch(() => {});
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const [key, until] of this.closedViewers)
        if (until < this.now()) this.closedViewers.delete(key);
      for (const buffer of this.buffers.values())
        try {
          await this.ensure(this.camera(buffer.id), this.recordingOwner);
        } catch (error) {
          buffer.status = "unavailable";
          buffer.lastError =
            error.message === "camera_nvr_required"
              ? "A capable NVR is required"
              : "Camera NVR source unavailable";
        }
      for (const [key, entry] of this.entries) {
        if (
          entry.owner === this.recordingOwner &&
          this.buffers.has(entry.cameraId)
        )
          continue;
        if (entry.until < this.now()) {
          this.entries.delete(key);
          await this.releaseEntry(entry);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled(this.eventPending.values());
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.releaseEntry(entry)),
    );
    this.entries.clear();
  }
}
