import { createHash, createHmac } from "node:crypto";
import { nvrCameraSource } from "./nvr-camera-sessions.mjs";
import { nodeJson } from "./node-client.mjs";

export const cameraAccessKey = (key, id, camera, expiresAt) =>
  createHmac("sha256", key)
    .update(["camera-access-v1", id, camera, expiresAt].join("\n"))
    .digest("hex");

/** Provision camera-only capabilities over the existing paired node channel. Root keys never leave Helper. */
export class CameraAccessBootstrap {
  constructor({ sessions, cluster, config, json = nodeJson, now = Date.now }) {
    Object.assign(this, { sessions, cluster, config, json, now });
    this.pending = new Map();
    this.reconciling = undefined;
  }
  nodes() {
    return this.cluster
      .nodes()
      .filter((node) => {
        const health = this.cluster.health.get(node.id);
        return (
          node.enabled &&
          node.roles.includes("stream") &&
          health?.online &&
          health.remote?.features?.directCameraAccess === true &&
          health.remote?.features?.cameraAccessPolicy === 1
        );
      })
      .slice(0, 8);
  }
  reconcile() {
    if (this.reconciling) return this.reconciling;
    const registry = this.sessions.registry();
    // Startup has no authoritative inventory yet. HA disconnect retains its last registry.
    if (!registry.states?.length) return Promise.resolve();
    const states = new Map(
      registry.states.map((state) => [state.entity_id, state.state]),
    );
    const cameras = registry.cameras
      .filter((camera) => {
        if (
          [camera.id, ...(camera.aliases ?? [])].some(
            (id) => states.get(id) === "off",
          )
        )
          return false;
        try {
          nvrCameraSource(camera, registry);
          return true;
        } catch {
          return false;
        }
      })
      .map((camera) => camera.id)
      .slice(0, 256);
    const task = Promise.allSettled(
      this.nodes().map((node) =>
        this.json(node, "/v1/camera-access/reconcile", {
          method: "POST",
          timeout: 3000,
          data: { cameras },
        }),
      ),
    ).finally(() => {
      if (this.reconciling === task) this.reconciling = undefined;
    });
    this.reconciling = task;
    return task;
  }
  bootstrap(cameraId, clientId) {
    if (
      !/^camera\.[a-z0-9_]+$/.test(cameraId) ||
      !/^[a-f0-9-]{36}$/.test(clientId)
    )
      throw Error("invalid_camera_access");
    const key = `${cameraId}:${clientId}`;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= 32) throw Error("camera_access_busy");
    const task = this.issue(cameraId, clientId).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, task);
    return task;
  }
  async issue(cameraId, clientId) {
    const camera = this.sessions.camera(cameraId);
    if (!camera?.available) throw Error("camera_unavailable");
    const source = nvrCameraSource(camera, this.sessions.registry());
    // Stable windows allow simultaneous instances on the same installation
    // to coexist without rotating each other's still-valid key.
    const expiresAt = (Math.floor(this.now() / 43200000) + 2) * 43200000;
    const id = createHash("sha256")
      .update([clientId, camera.id, expiresAt].join("\n"))
      .digest("hex")
      .slice(0, 32);
    const nodes = this.nodes();
    const issued = await Promise.allSettled(
      nodes.map(async (node) => {
        const result = await this.json(node, "/v1/camera-access", {
          method: "POST",
          timeout: 10000,
          data: {
            id,
            cameraId: camera.id,
            expiresAt,
            source,
            advertiseHost: await this.sessions.advertiseHost(node),
            preRollSeconds: this.config.pre_roll_seconds,
            requireAudio: this.config.record_audio !== false,
            recordAudio: this.config.record_audio !== false,
            batteryPowered: Boolean(camera.batteryPowered),
          },
        });
        if (
          result.id !== id ||
          result.cameraId !== camera.id ||
          result.expiresAt !== expiresAt
        )
          throw Error("invalid_camera_access_response");
        return {
          nodeId: node.id,
          url: node.url,
          allowHttp: Boolean(node.allowHttp),
          id,
          cameraId: camera.id,
          expiresAt,
          key: cameraAccessKey(node.key, id, camera.id, expiresAt),
        };
      }),
    );
    if (!this.sessions.camera(cameraId)?.available) {
      await this.reconcile();
      throw Error("camera_unavailable");
    }
    return {
      cameraId: camera.id,
      requestedId: cameraId,
      expiresAt,
      nodes: issued.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    };
  }
}
