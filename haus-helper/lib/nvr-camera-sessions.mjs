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
import { fileDigest } from "./backups.mjs";

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
      (id) =>
        `sensor.${id.split(".")[1].replace(/_internal$/, "")}_stream_provider`,
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
    log = (event, fields) =>
      console.log(
        JSON.stringify({ component: "camera-capture", event, ...fields }),
      ),
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
      log,
    });
    this.buffers = new Map();
    this.entries = new Map();
    this.revisions = new Map();
    this.pending = new Map();
    this.cameraPending = new Map();
    this.nodeReservations = new Map();
    this.failedNodes = new Map();
    this.viewers = new Map();
    this.closedViewers = new Map();
    this.events = new Map();
    this.eventPending = new Map();
    this.finalizations = new Map();
    this.recoveryCursors = new Map();
    this.recordingDiagnostics = new Map();
    this.abort = new AbortController();
    this.recordingOwner = `recording-${randomUUID()}`;
    this.continuityAssignments = new Map();
    this.continuitySent = new Map();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS nvr_camera_assignments(camera_id TEXT PRIMARY KEY,node_id TEXT NOT NULL)",
    );
    for (const row of store.db
      .prepare("SELECT camera_id,node_id FROM nvr_camera_assignments")
      .all())
      this.continuityAssignments.set(row.camera_id, row.node_id);
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
  rememberAssignment(entry) {
    if (
      entry.owner !== this.recordingOwner ||
      this.continuityAssignments.get(entry.cameraId) === entry.node.id
    )
      return;
    this.continuityAssignments.set(entry.cameraId, entry.node.id);
    this.store.db
      .prepare(
        "INSERT INTO nvr_camera_assignments(camera_id,node_id)VALUES(?,?) ON CONFLICT(camera_id)DO UPDATE SET node_id=excluded.node_id",
      )
      .run(entry.cameraId, entry.node.id);
    this.continuitySent.clear();
  }
  async syncContinuity(force = false) {
    if (this.continuityBusy || this.stopped || !this.registry().states?.length)
      return;
    this.continuityBusy = true;
    try {
      const registry = this.registry(),
        states = new Map(
          registry.states.map((state) => [state.entity_id, state.state]),
        );
      await Promise.allSettled(
        this.cluster
          .nodes()
          .filter(
            (node) =>
              this.cluster.health.get(node.id)?.online &&
              this.cluster.health.get(node.id)?.remote?.features
                ?.cameraContinuity === 1,
          )
          .map(async (node) => {
            const cameras = [];
            for (const camera of registry.cameras) {
              if (
                !node.enabled ||
                !node.roles.includes("stream") ||
                !camera.enabled ||
                !this.config.recording_enabled ||
                this.continuityAssignments.get(camera.id) !== node.id ||
                [camera.id, ...(camera.aliases ?? [])].some(
                  (id) => states.get(id) === "off",
                )
              )
                continue;
              try {
                cameras.push({
                  cameraId: camera.id,
                  source: nvrCameraSource(camera, registry),
                  advertiseHost: await this.advertiseHost(node),
                  preRollSeconds: this.config.pre_roll_seconds,
                  requireAudio: this.config.record_audio !== false,
                  recordAudio: this.config.record_audio !== false,
                });
              } catch {}
            }
            const fingerprint = createHash("sha256")
              .update(JSON.stringify(cameras))
              .digest("hex");
            const previous = this.continuitySent.get(node.id);
            if (
              !force &&
              previous?.fingerprint === fingerprint &&
              this.now() - previous.at < 30000
            )
              return;
            const expiresAt = this.now() + 24 * 3600000;
            await this.json(node, "/v1/camera-continuity", {
              method: "PUT",
              data: {
                cameras: cameras.map((camera) => ({ ...camera, expiresAt })),
              },
              signal: this.abort.signal,
              timeout: 5000,
            });
            this.continuitySent.set(node.id, { fingerprint, at: this.now() });
          }),
      );
    } finally {
      this.continuityBusy = false;
    }
  }
  async clearContinuityNode(id) {
    await this.clearActivityNode?.(id);
    const node = this.cluster.nodes().find((node) => node.id === id);
    if (
      node &&
      this.cluster.health.get(id)?.remote?.features?.cameraContinuity === 1
    )
      await this.json(node, "/v1/camera-continuity", {
        method: "PUT",
        data: { cameras: [] },
        signal: this.abort.signal,
        timeout: 5000,
      });
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
  sourceHealth() {
    return (this.cameras ?? []).slice(0, 256).map((camera) => {
      const buffer = this.buffers.get(camera.id);
      const expiresAt =
        buffer?.status === "buffering" &&
        !buffer.stopped &&
        Number.isFinite(buffer.lastAdvance)
          ? buffer.lastAdvance + 15000
          : 0;
      return {
        id: camera.id,
        available: Boolean(camera.available && expiresAt > this.now()),
        expiresAt,
      };
    });
  }
  candidates() {
    return this.cluster
      .nodes()
      .filter((node) => {
        const health = this.cluster.health.get(node.id);
        const { remote, capability, active } = this.nodeLoad(node);
        return (
          node.enabled &&
          (this.failedNodes.get(node.id)?.until ?? 0) <= this.now() &&
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
      (this.failedNodes.get(node.id)?.until ?? 0) <= this.now() &&
      this.cluster
        .nodes()
        .some(
          (current) =>
            current.id === node.id &&
            current.enabled &&
            current.roles.includes("stream"),
        ) &&
      this.cluster.health.get(node.id)?.online
    );
  }
  nodeFailure(node, error) {
    if (this.stopped || this.abort.signal.aborted) return;
    // Source rejection/capacity is not evidence that every camera on a node failed.
    if (
      !["TypeError", "AbortError", "TimeoutError"].includes(error?.name) &&
      ![502, 504].includes(error?.status) &&
      error?.code !== "node_unavailable"
    )
      return;
    const failures = Math.min(
      4,
      (this.failedNodes.get(node.id)?.failures ?? 0) + 1,
    );
    this.failedNodes.set(node.id, {
      failures,
      until: this.now() + Math.min(30000, 3000 * 2 ** (failures - 1)),
    });
    if (this.failedNodes.size > 64)
      this.failedNodes.delete(this.failedNodes.keys().next().value);
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
  async ensure(camera, owner, preview = false, preferredNode, refresh = false) {
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
      return this.ensure(camera, owner, preview, preferredNode, refresh);
    }
    // Serialize acquisition per camera, not just per owner. A recording,
    // dashboard and viewer can arrive together before the first producer is
    // registered; later owners must see that producer before choosing a node.
    const priorCamera = this.cameraPending.get(camera.id);
    const task = (async () => {
      await priorCamera?.catch(() => {});
      if (this.stopped || (this.revisions.get(key) ?? 0) !== revision)
        throw missing("camera_session_cancelled");
      return this.acquire(
        camera,
        owner,
        source,
        key,
        preferredNode,
        revision,
        refresh,
      );
    })();
    this.cameraPending.set(camera.id, task);
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
      if (this.cameraPending.get(camera.id) === task)
        this.cameraPending.delete(camera.id);
    }
  }
  async acquire(
    camera,
    owner,
    source,
    key,
    preferredNode,
    revision,
    refresh = false,
  ) {
    const old = this.entries.get(key);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex");
    if (old && old.fingerprint === fingerprint && this.validNode(old.node)) {
      old.until = this.now() + 60000;
      if (
        !refresh &&
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
            timeout: 3500,
          },
        );
        this.validateSession(value);
        this.failedNodes.delete(old.node.id);
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
        if (old && (old.node.id !== entry.node.id || old.id !== entry.id))
          void this.releaseEntry(old);
        return entry;
      } catch (error) {
        this.nodeFailure(old.node, error);
      }
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
    if (shared) {
      // Attaching another owner to a healthy producer consumes no new source
      // slot. Prefer it even when another node currently looks less loaded.
      // Otherwise previews/viewers duplicate the camera's P2P reader remotely.
      const index = choices.findIndex((node) => node.id === shared.node.id);
      if (index >= 0) choices.splice(index, 1);
      choices.unshift(shared.node);
    }
    const assigned = this.cluster
      .nodes()
      .find(
        (node) =>
          node.id === this.continuityAssignments.get(camera.id) &&
          this.validNode(node) &&
          this.cluster.health
            .get(node.id)
            ?.remote?.cameraContinuity?.cameras?.some(
              (plan) =>
                plan.cameraId === camera.id && plan.expiresAt > this.now(),
            ),
      );
    if (
      !shared &&
      assigned &&
      (!preferredNode || assigned.id === preferredNode.id)
    ) {
      const index = choices.findIndex((node) => node.id === assigned.id);
      if (index >= 0) choices.splice(index, 1);
      choices.unshift(assigned);
    }
    const activityNode = this.activityAssignedNode?.(camera);
    if (
      !shared &&
      !assigned &&
      activityNode &&
      this.validNode(activityNode) &&
      (!preferredNode || preferredNode.id === activityNode.id)
    ) {
      const index = choices.findIndex((node) => node.id === activityNode.id);
      if (index >= 0) choices.splice(index, 1);
      choices.unshift(activityNode);
    }
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
        this.failedNodes.delete(node.id);
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
        if (old && (old.node.id !== entry.node.id || old.id !== entry.id))
          void this.releaseEntry(old);
        return entry;
      } catch (error) {
        this.nodeFailure(node, error);
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
    this.rememberAssignment(entry);
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
      // A node can restart while the short warm-lease cache is still fresh.
      // Confirm its producer exists before sending a browser offer, allowing
      // ensure() to reopen/fail over rather than fail the first camera open.
      const entry = await this.ensure(camera, owner, false, undefined, true);
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
    } catch (error) {
      this.reportRecordingFailure(event, "submit", error);
      throw error;
    } finally {
      if (this.eventPending.get(event.id) === task)
        this.eventPending.delete(event.id);
    }
  }
  reportRecordingFailure(event, phase, error) {
    if (this.stopped) return;
    const reason = error.code ?? error.message;
    const known = new Set([
      "camera_session_not_found",
      "camera_recording_not_found",
      "camera_recording_not_ready",
      "camera_ring_not_ready",
      "camera_session_busy",
      "camera_recording_busy",
      "camera_recording_failed",
      "camera_session_unavailable",
      "camera_engine_unavailable",
      "camera_engine_timeout",
      "camera_media_failed",
      "invalid_camera_recording",
      "camera_recording_node_unavailable",
      "camera_recording_audio_missing",
      "camera_recording_digest_mismatch",
      "camera_nvr_required",
      "storage_full",
      "node_unavailable",
      "invalid_node_key_or_clock",
    ]);
    const code = known.has(reason) ? reason : "recording_operation_failed";
    const key = `${event.id}:${phase}:${code}`;
    if (this.now() - (this.recordingDiagnostics.get(key) ?? -Infinity) < 30000)
      return;
    this.recordingDiagnostics.set(key, this.now());
    if (this.recordingDiagnostics.size > 256)
      this.recordingDiagnostics.delete(
        this.recordingDiagnostics.keys().next().value,
      );
    try {
      this.log("recording_operation_failed", {
        eventId: event.id,
        cameraId: event.cameraId,
        phase,
        reason: code,
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      });
    } catch {
      // Diagnostic failures cannot change capture or cleanup behavior.
    }
  }
  async submitRecord(event) {
    let job = this.events.get(event.id);
    if (job && job.startAt <= event.startAt && job.endAt >= event.endAt)
      return job;
    if (!job) {
      const receipt = await this.durableRecording(event);
      if (receipt) {
        job = {
          nodeId: receipt.node.id,
          receipt: receipt.value,
          cameraId: event.cameraId,
          startAt: event.startAt,
          endAt: event.endAt,
        };
        this.events.set(event.id, job);
        this.store.db
          .prepare(
            "INSERT OR REPLACE INTO nvr_camera_events(event_id,value)VALUES(?,?)",
          )
          .run(event.id, JSON.stringify(job));
        return job;
      }
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
        event: {
          id: event.id,
          cameraId: event.cameraId,
          startAt: event.startAt,
          endAt: event.endAt,
          kinds: event.kinds,
        },
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
    if (this.finalizations.has(event.id))
      return this.finalizations.get(event.id);
    const task = this.finalizeRecording(event);
    this.finalizations.set(event.id, task);
    try {
      return await task;
    } catch (error) {
      this.reportRecordingFailure(event, "finalize", error);
      throw error;
    } finally {
      if (this.finalizations.get(event.id) === task)
        this.finalizations.delete(event.id);
    }
  }
  validateReceipt(value, event) {
    return (
      value?.state === "ready" &&
      value.event?.id === event.id &&
      value.event.cameraId === event.cameraId &&
      Number.isSafeInteger(value.event.startAt) &&
      Number.isSafeInteger(value.event.endAt) &&
      value.event.startAt <= event.startAt &&
      value.event.endAt >= event.endAt &&
      value.event.endAt - value.event.startAt <= 300000 &&
      /^[a-f0-9]{64}$/.test(value.sha256 ?? "") &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= 1024 ** 3 &&
      Number.isFinite(value.duration) &&
      value.duration > 0 &&
      Number.isFinite(value.mediaStartAt) &&
      value.mediaStartAt >= 0 &&
      value.mediaStartAt <= value.event.endAt &&
      typeof value.audio === "boolean"
    );
  }
  async durableRecording(event, preferredNode) {
    for (const node of this.cluster
      .nodes()
      .filter(
        (node) =>
          node.enabled &&
          (!preferredNode || node.id === preferredNode) &&
          this.cluster.health.get(node.id)?.online &&
          this.cluster.health.get(node.id)?.remote?.features
            ?.cameraRecordingRecovery === 1,
      )) {
      try {
        const value = await this.json(
          node,
          `/v1/camera-recordings/${event.id}`,
          {
            timeout: 4000,
            signal: this.abort.signal,
          },
        );
        if (this.validateReceipt(value, event)) return { node, value };
      } catch {}
    }
    return undefined;
  }
  async acknowledgeRecording(node, value) {
    return this.json(node, `/v1/camera-recordings/${value.event.id}`, {
      method: "POST",
      data: { sha256: value.sha256 },
      timeout: 4000,
      signal: this.abort.signal,
    });
  }
  recoverRecordings() {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.recoverReadyRecordings().finally(() => {
      this.recoveryPromise = undefined;
    });
    return this.recoveryPromise;
  }
  async recoverReadyRecordings() {
    if (
      this.recovering ||
      this.stopped ||
      this.now() - (this.lastRecovery ?? -Infinity) < 10000
    )
      return;
    this.recovering = true;
    this.lastRecovery = this.now();
    try {
      for (const node of this.cluster
        .nodes()
        .filter(
          (node) =>
            node.enabled &&
            this.cluster.health.get(node.id)?.online &&
            this.cluster.health.get(node.id)?.remote?.features
              ?.cameraRecordingRecovery === 1,
        )) {
        try {
          const cursor = this.recoveryCursors.get(node.id);
          const result = await this.json(
            node,
            "/v1/camera-recordings" +
              (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
            {
              timeout: 4000,
              signal: this.abort.signal,
            },
          );
          if (!Array.isArray(result.items)) continue;
          this.recoveryCursors.set(
            node.id,
            /^\d{1,16}$/.test(result.nextCursor ?? "")
              ? result.nextCursor
              : undefined,
          );
          for (const value of (result.items ?? []).slice(0, 16)) {
            if (this.stopped || !uuid(value.event?.id)) continue;
            let event = this.store.get(value.event.id);
            if (
              !event &&
              this.camera(value.event.cameraId) &&
              this.authorizeActivityRecording?.(node, value) &&
              this.validateReceipt(value, value.event)
            )
              event = this.store.adoptActivity(value.event);
            // Unknown camera/events are not inferred from filenames or adopted
            // into another home's catalog. Autonomous triggers will use the
            // same explicit authorized metadata path.
            if (
              !event ||
              !this.camera(event.cameraId) ||
              !this.validateReceipt(value, event)
            )
              continue;
            const release = await this.store.pinMedia(event.id);
            try {
              event = this.store.get(event.id);
              if (!event || !this.validateReceipt(value, event)) continue;
              if (event.status === "ready") {
                const descriptor = this.store.db
                  .prepare(
                    "SELECT digest FROM event_archive WHERE event_id=? AND variant='original'",
                  )
                  .get(event.id);
                const digest =
                  descriptor?.digest ??
                  (event.localOriginal
                    ? await fileDigest(this.store.path(event.id)).catch(
                        () => null,
                      )
                    : null);
                if (digest === value.sha256)
                  await this.acknowledgeRecording(node, value);
              } else if (
                ["recording", "interrupted", "failed"].includes(event.status)
              ) {
                await this.finalize(event);
              }
            } finally {
              release();
            }
          }
        } catch {}
      }
    } finally {
      this.recovering = false;
    }
  }
  async finalizeRecording(event) {
    const job = await this.record(event),
      node = this.cluster.nodes().find((node) => node.id === job.nodeId);
    if (!node?.enabled) throw missing("camera_recording_node_unavailable");
    const base = `/v1/cameras/sessions/${job.id}/recordings/${event.id}`;
    let result;
    let durable = await this.durableRecording(event, node.id);
    const deadline = this.now() + 90000;
    do {
      if (durable) result = durable.value;
      else {
        try {
          result = await this.json(node, `${base}/status`, {
            method: "POST",
            data: { owner: job.owner },
            signal: this.abort.signal,
            timeout: 15000,
          });
        } catch (error) {
          durable = await this.durableRecording(event, node.id);
          if (!durable) throw error;
          result = durable.value;
        }
      }
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
      const response = await this.request(
        node,
        durable ? `/v1/blobs/${result.sha256}` : `${base}/media`,
        {
          method: durable ? "GET" : "POST",
          ...(durable ? {} : { data: { owner: job.owner } }),
          signal: this.abort.signal,
          timeout: 120000,
        },
      );
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
      if (durable)
        await this.acknowledgeRecording(node, result).catch(() => {});
      if (job.id && job.owner)
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
      void this.syncContinuity().catch(() => {});
      void this.recoverRecordings().catch(() => {});
    } finally {
      this.ticking = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled(this.eventPending.values());
    await this.recoveryPromise?.catch(() => {});
    await Promise.allSettled(this.finalizations.values());
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.releaseEntry(entry)),
    );
    this.entries.clear();
  }
}
