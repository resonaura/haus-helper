import { createHash, randomUUID } from "node:crypto";
import { nodeJson } from "./node-client.mjs";
import { nvrCameraSource } from "./nvr-camera-sessions.mjs";

/** Controller-authorized history fences catalog adoption; settings never opt in implicitly. */
export class AutonomousActivity {
  constructor({
    store,
    config,
    cluster,
    sessions,
    now = Date.now,
    json = nodeJson,
  }) {
    Object.assign(this, { store, config, cluster, sessions, now, json });
    this.sent = new Map();
    this.pending = new Map();
    this.revokingNodes = new Set();
    this.observed = new Map();
    this.interruptedCursors = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS nvr_activity_policies(
      policy_id TEXT PRIMARY KEY,camera_id TEXT NOT NULL,node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS nvr_activity_camera ON nvr_activity_policies(camera_id,revoked_at)`);
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS nvr_activity_triggers(request_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,value TEXT NOT NULL,expires_at INTEGER NOT NULL)",
    );
  }
  active(id) {
    return this.store.db
      .prepare(
        "SELECT * FROM nvr_activity_policies WHERE camera_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(id);
  }
  enabled(camera) {
    if (
      !camera?.enabled ||
      !camera.motionDetection?.enabled ||
      !this.config.recording_enabled
    )
      return false;
    const states = new Map(
      (this.sessions.registry().states ?? []).map((row) => [
        row.entity_id,
        row.state,
      ]),
    );
    return ![camera.id, ...(camera.aliases ?? [])].some(
      (id) => states.get(id) === "off",
    );
  }
  capable(node) {
    return (
      node?.enabled &&
      !this.revokingNodes.has(node.id) &&
      node.roles.includes("stream") &&
      this.cluster.health.get(node.id)?.online &&
      this.cluster.health.get(node.id)?.remote?.features
        ?.autonomousCameraActivity === 1
    );
  }
  priorNode(camera) {
    const policy = this.active(camera.id);
    const node = this.cluster
      .nodes()
      .find((node) => node.id === policy?.node_id);
    if (!this.enabled(camera) || !this.capable(node)) return undefined;
    return this.cluster.health
      .get(node.id)
      ?.remote?.cameraActivity?.cameras?.some(
        (plan) =>
          plan.cameraId === camera.id &&
          plan.policyId === policy.policy_id &&
          plan.expiresAt > this.now(),
      )
      ? node
      : undefined;
  }
  async ensure(camera, node) {
    if (this.stopped) throw Error("activity_stopped");
    let policy = this.active(camera.id);
    if (!this.enabled(camera) || !this.capable(node))
      throw Error("activity_assignment_unavailable");
    if (!policy || policy.node_id !== node.id) {
      if (policy)
        this.store.db
          .prepare(
            "UPDATE nvr_activity_policies SET revoked_at=? WHERE policy_id=?",
          )
          .run(this.now(), policy.policy_id);
      const id = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO nvr_activity_policies(policy_id,camera_id,node_id,created_at,expires_at)VALUES(?,?,?,?,?)",
        )
        .run(id, camera.id, node.id, this.now(), this.now() + 86340000);
      policy = this.active(camera.id);
      this.cluster.backups?.markChanged?.();
      this.sent.delete(node.id);
    }
    await this.syncNode(node);
    const status = await this.json(node, "/v1/camera-activity", {
      timeout: 4000,
    });
    const current = status.cameras?.find(
      (plan) =>
        plan.cameraId === camera.id && plan.policyId === policy.policy_id,
    );
    if (!current) throw Error("activity_assignment_unavailable");
    this.observed.set(camera.id, current);
    if (current.admitted === false) throw Error("activity_source_capacity");
    return current;
  }
  syncNode(node, force = false) {
    if (this.pending.has(node.id))
      return force
        ? this.pending.get(node.id).then(() => this.syncNode(node, true))
        : this.pending.get(node.id);
    const task = this.send(node, force).finally(() => {
      if (this.pending.get(node.id) === task) this.pending.delete(node.id);
    });
    this.pending.set(node.id, task);
    return task;
  }
  async send(node, force) {
    if (this.stopped || !this.capable(node)) return;
    const registry = this.sessions.registry(),
      plans = [],
      expiresAt = this.now() + 86340000;
    for (const policy of this.store.db
      .prepare(
        "SELECT * FROM nvr_activity_policies WHERE node_id=? AND revoked_at IS NULL",
      )
      .all(node.id)) {
      const camera = registry.cameras.find(
        (camera) => camera.id === policy.camera_id,
      );
      if (!this.enabled(camera)) {
        this.store.db
          .prepare(
            "UPDATE nvr_activity_policies SET revoked_at=? WHERE policy_id=?",
          )
          .run(this.now(), policy.policy_id);
        this.cluster.backups?.markChanged?.();
        continue;
      }
      plans.push({
        cameraId: camera.id,
        policyId: policy.policy_id,
        mode: camera.motionDetection.mode,
        source: nvrCameraSource(camera, registry),
        advertiseHost: await this.sessions.advertiseHost(node),
        requireAudio: this.config.record_audio !== false,
        recordAudio: this.config.record_audio !== false,
        preRollSeconds: this.config.pre_roll_seconds,
        postRollSeconds: this.config.post_roll_seconds,
        maxEventSeconds: this.config.max_event_seconds,
        expiresAt,
      });
    }
    const fingerprint = createHash("sha256")
        .update(
          JSON.stringify(plans.map((plan) => ({ ...plan, expiresAt: 0 }))),
        )
        .digest("hex"),
      old = this.sent.get(node.id);
    if (
      !force &&
      old?.fingerprint === fingerprint &&
      this.now() - old.at < 30000
    )
      return;
    await this.json(node, "/v1/camera-activity", {
      method: "PUT",
      data: { cameras: plans },
      timeout: 6000,
    });
    for (const plan of plans)
      this.store.db
        .prepare(
          "UPDATE nvr_activity_policies SET expires_at=? WHERE policy_id=?",
        )
        .run(expiresAt, plan.policyId);
    this.sent.set(node.id, { fingerprint, at: this.now() });
  }
  async revoke(id) {
    const policy = this.active(id);
    if (!policy) return;
    this.store.db
      .prepare(
        "UPDATE nvr_activity_policies SET revoked_at=? WHERE policy_id=?",
      )
      .run(this.now(), policy.policy_id);
    this.cluster.backups?.markChanged?.();
    const node = this.cluster
      .nodes()
      .find((node) => node.id === policy.node_id);
    this.sent.delete(policy.node_id);
    if (node) await this.syncNode(node, true);
  }
  async clearNode(id) {
    const node = this.cluster.nodes().find((node) => node.id === id);
    if (
      !node ||
      this.cluster.health.get(id)?.remote?.features
        ?.autonomousCameraActivity !== 1
    )
      return;
    this.revokingNodes.add(id);
    try {
      await this.pending.get(id)?.catch(() => {});
      await this.json(node, "/v1/camera-activity", {
        method: "PUT",
        data: { cameras: [] },
        timeout: 6000,
      });
      this.store.db
        .prepare(
          "UPDATE nvr_activity_policies SET revoked_at=? WHERE node_id=? AND revoked_at IS NULL",
        )
        .run(this.now(), id);
      this.cluster.backups?.markChanged?.();
      this.sent.delete(id);
    } finally {
      this.revokingNodes.delete(id);
    }
  }
  authorizes(node, value) {
    const event = value?.event,
      origin = event?.origin;
    if (
      origin?.kind !== "camera-activity" ||
      !/^[a-f0-9-]{36}$/.test(origin.policyId ?? "")
    )
      return false;
    const policy = this.store.db
      .prepare(
        "SELECT * FROM nvr_activity_policies WHERE policy_id=? AND camera_id=? AND node_id=?",
      )
      .get(origin.policyId, event.cameraId, node.id);
    return Boolean(
      policy &&
      Number.isSafeInteger(event.startAt) &&
      Number.isSafeInteger(event.endAt) &&
      event.startAt >= policy.created_at - 30000 &&
      event.endAt <=
        Math.min(policy.expires_at, policy.revoked_at ?? Infinity) + 300000 &&
      event.endAt > event.startAt &&
      event.endAt - event.startAt <= 300000 &&
      Array.isArray(event.kinds) &&
      event.kinds.length > 0 &&
      event.kinds.length <= 5 &&
      event.kinds.every((kind) =>
        ["motion", "person", "pet", "vehicle", "doorbell"].includes(kind),
      ),
    );
  }
  async sync() {
    for (const node of this.cluster.nodes())
      await this.syncNode(node).catch(() => {});
    await this.flushTriggers();
    await this.recoverInterrupted();
  }
  async recoverInterrupted() {
    for (const node of this.cluster
      .nodes()
      .filter((node) => this.capable(node))) {
      try {
        const cursor = this.interruptedCursors.get(node.id);
        const result = await this.json(
          node,
          "/v1/camera-activity/interrupted" +
            (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
          { timeout: 4000 },
        );
        if (!Array.isArray(result.items)) continue;
        this.interruptedCursors.set(
          node.id,
          /^\d{1,16}$/.test(result.nextCursor ?? "")
            ? result.nextCursor
            : undefined,
        );
        for (const value of result.items.slice(0, 16)) {
          if (
            value.state !== "interrupted" ||
            !/^[a-f0-9-]{36}$/.test(value.event?.id ?? "") ||
            !this.sessions.camera(value.event.cameraId) ||
            !this.authorizes(node, value)
          )
            continue;
          const previous = this.store.get(value.event.id);
          if (previous && previous.cameraId !== value.event.cameraId) continue;
          if (!previous) this.store.adoptActivity(value.event);
          this.store.interruptActivity(value.event.id, value.error);
          this.cluster.backups?.markChanged?.();
          await this.json(
            node,
            `/v1/camera-activity/interrupted/${value.event.id}`,
            { method: "POST", data: {}, timeout: 4000 },
          );
        }
      } catch {
        /* Keep the interrupted journal until the home records its state. */
      }
    }
  }
  triggerNative(id, kind, source, at) {
    if (this.stopped) return false;
    const policy = this.active(id),
      camera = this.sessions.camera(id);
    if (!policy || policy.expires_at <= this.now() || !this.enabled(camera))
      return false;
    const remote = this.cluster.health
      .get(policy.node_id)
      ?.remote?.cameraActivity?.cameras?.find(
        (plan) => plan.cameraId === id && plan.policyId === policy.policy_id,
      );
    const observed = this.observed.get(id) ?? remote;
    if (
      observed?.policyId !== policy.policy_id ||
      observed.admitted !== true ||
      observed.ready !== true
    )
      return false;
    if (
      !Number.isSafeInteger(at) ||
      Math.abs(at - this.now()) > 30000 ||
      !["motion", "person", "pet", "vehicle", "doorbell"].includes(kind)
    )
      return true;
    const token = createHash("sha256")
      .update(JSON.stringify([policy.policy_id, id, kind, source, at]))
      .digest("hex")
      .slice(0, 32);
    const requestId = `${token.slice(0, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}-${token.slice(16, 20)}-${token.slice(20)}`;
    if (
      this.store.db
        .prepare("SELECT count(*) AS n FROM nvr_activity_triggers")
        .get().n >= 128
    )
      return true;
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO nvr_activity_triggers(request_id,node_id,value,expires_at)VALUES(?,?,?,?)",
      )
      .run(
        requestId,
        policy.node_id,
        JSON.stringify({
          requestId,
          cameraId: id,
          policyId: policy.policy_id,
          kind,
          at,
        }),
        at + 30000,
      );
    void this.flushTriggers().catch(() => {});
    return true;
  }
  flushTriggers() {
    if (this.flushing) return this.flushing;
    this.flushing = this.sendTriggers().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }
  async sendTriggers() {
    if (this.stopped) return;
    this.store.db
      .prepare("DELETE FROM nvr_activity_triggers WHERE expires_at<=?")
      .run(this.now());
    for (const row of this.store.db
      .prepare(
        "SELECT * FROM nvr_activity_triggers ORDER BY expires_at LIMIT 16",
      )
      .all()) {
      const value = JSON.parse(row.value),
        policy = this.active(value.cameraId),
        node = this.cluster.nodes().find((node) => node.id === row.node_id);
      if (!policy || policy.policy_id !== value.policyId) {
        this.store.db
          .prepare("DELETE FROM nvr_activity_triggers WHERE request_id=?")
          .run(row.request_id);
        continue;
      }
      if (!this.capable(node)) continue;
      try {
        await this.json(node, "/v1/camera-activity/trigger", {
          method: "POST",
          data: value,
          timeout: 4000,
        });
        this.store.db
          .prepare("DELETE FROM nvr_activity_triggers WHERE request_id=?")
          .run(row.request_id);
      } catch {
        /* Retry the same recording intent only; never issue another physical command. */
      }
    }
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled(this.pending.values());
    await this.flushing;
  }
}
