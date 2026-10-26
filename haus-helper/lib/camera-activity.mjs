import { createHash } from "node:crypto";

export const activityKey = (id) =>
  `haus_activity_${createHash("sha256").update(id).digest("hex").slice(0, 20)}`;
export const isHausActivity = (state, entry) =>
  (entry?.platform === "mqtt" &&
    /^haus_activity_[a-f0-9]{20}$/.test(entry.unique_id ?? "")) ||
  (state?.attributes?.haus_activity_version === 1 &&
    /^camera\.[a-z0-9_]+$/.test(state.attributes.haus_camera ?? ""));
const nativeCameraSensor = (sensor) =>
  sensor.source === "device" || sensor.cameraNative === true;

/** One authority for recording and HA state. Raw sensors are never rewritten. */
export class CameraActivity {
  constructor({ recorder, motion, now = Date.now }) {
    Object.assign(this, { recorder, motion, now });
    this.entries = new Map();
  }
  sync(cameras) {
    for (const [id] of this.entries)
      if (!cameras.some((camera) => camera.id === id)) this.entries.delete(id);
    for (const camera of cameras) {
      const entry = this.entries.get(camera.id) ?? {
        delivered: new Map(),
        until: 0,
      };
      entry.camera = camera;
      this.entries.set(camera.id, entry);
    }
  }
  status(id) {
    const entry = this.entries.get(id);
    if (!entry) return { available: false, active: false, source: "none" };
    const { camera } = entry;
    const native = (camera.sensors ?? []).filter(
      (sensor) => sensor.available !== false,
    );
    const assist = camera.motionDetection?.enabled === true;
    const analysis = assist ? this.motion.status(id) : { state: "off" };
    const healthy = analysis.state === "running" && analysis.fresh === true;
    if (assist && !healthy) entry.waitingAt ??= this.now();
    else entry.waitingAt = undefined;
    const validating =
      assist && (healthy || this.now() - entry.waitingAt < 12000);
    // Generic native motion becomes a hint while analysis validates the scene.
    // Recognized native objects/doorbell keep their existing semantics.
    const accepted = native.filter(
      (sensor) =>
        !validating || sensor.kind !== "motion" || !nativeCameraSensor(sensor),
    );
    return {
      available: camera.available && (healthy || accepted.length > 0),
      active:
        camera.available &&
        (entry.until > this.now() || accepted.some((sensor) => sensor.active)),
      source: assist
        ? healthy
          ? "assisted"
          : validating
            ? "analysis_unavailable"
            : native.length
              ? "native_fallback"
              : "analysis_unavailable"
        : "native",
      assistState: analysis.state,
      sources: (camera.sensors ?? []).map((sensor) => sensor.id),
      replaces: (camera.sensors ?? [])
        .filter(nativeCameraSensor)
        .map((sensor) => sensor.id),
      lastDetectedAt: entry.lastDetectedAt,
      kind: entry.kind,
    };
  }
  accept(id, kind, source, at = this.now()) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      !entry.camera.available ||
      !Number.isFinite(at) ||
      Math.abs(this.now() - at) > 30000
    )
      return;
    entry.until = Math.max(entry.until, this.now() + 10000);
    entry.lastDetectedAt = at;
    entry.kind = kind;
    if (this.now() - (entry.delivered.get(kind) ?? -Infinity) < 3000) return;
    entry.delivered.set(kind, this.now());
    try {
      this.recorder.trigger(id, kind, source, at);
    } catch {
      /* State remains useful in stream-only mode. */
    }
  }
  native(id, kind, source, at = this.now()) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      (kind === "motion" &&
        entry.camera.sensors?.some(
          (sensor) => sensor.id === source && nativeCameraSensor(sensor),
        ) &&
        entry.camera.motionDetection?.enabled &&
        ["assisted", "analysis_unavailable"].includes(this.status(id).source))
    )
      return;
    this.accept(id, kind, source, at);
  }
  tick() {
    for (const [id, entry] of this.entries) {
      const status = this.status(id);
      const active = new Set();
      for (const sensor of entry.camera.sensors ?? []) {
        if (
          !sensor.active ||
          sensor.available === false ||
          (sensor.kind === "motion" &&
            nativeCameraSensor(sensor) &&
            ["assisted", "analysis_unavailable"].includes(status.source))
        )
          continue;
        active.add(sensor.id);
        if (!entry.nativeActive?.has(sensor.id))
          this.native(id, sensor.kind, sensor.id);
      }
      entry.nativeActive = active;
    }
  }
  software(id, event) {
    if (!["motion", "person", "pet", "vehicle"].includes(event.kind)) return;
    this.accept(id, event.kind, "haus_activity_assist", event.at);
  }
  activeSensors(camera) {
    const state = this.status(camera.id);
    return state.available && state.active
      ? [
          {
            id: activityKey(camera.id),
            kind: state.kind ?? "motion",
            active: true,
          },
        ]
      : [];
  }
}
