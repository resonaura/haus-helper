import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { nodeJson, nodeRequest } from "./node-client.mjs";
import { once } from "node:events";

async function eachWorker(items, visit) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await visit(items[index]);
      }
    }),
  );
}

/** Sticky assignments, bounded work, expiring capabilities and failure cooldowns. */
export class Motion {
  constructor({
    ha,
    recorder,
    cluster,
    warm,
    config,
    now = () => Date.now(),
    worker,
  }) {
    Object.assign(this, { ha, recorder, cluster, warm, config, now, worker });
    this.jobs = new Map();
    this.cooldowns = new Map();
    this.cameras = [];
    this.localSupported = false;
    this.abort = new AbortController();
  }
  async initialize() {
    try {
      await access(new URL("../vision/model.onnx", import.meta.url));
      this.worker ??= (await import("../vision/worker.mjs")).VisionWorker;
      this.localSupported = true;
    } catch {
      /* Older/development installations simply have no local inference worker. */
    }
  }
  sync(cameras) {
    this.epoch = (this.epoch ?? 0) + 1;
    this.cameras = cameras;
    for (const [id, job] of this.jobs) {
      const camera = cameras.find((camera) => camera.id === id);
      if (
        !camera?.available ||
        !camera.enabled ||
        !camera.motionDetection?.enabled ||
        camera.motionDetection.mode !== job.mode
      )
        void this.release(id).catch(() => {});
    }
  }
  status(id) {
    const job = this.jobs.get(id);
    return {
      state: job
        ? job.local
          ? job.worker.state
          : job.state
        : this.cameras.find((camera) => camera.id === id)?.motionDetection
              ?.enabled
          ? "waiting"
          : "off",
      processor: job?.local ? "Home server" : job?.node?.name,
    };
  }
  async release(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    if (job.lease) this.warm.leases.delete(job.lease);
    if (job.local) await job.worker.stop();
    else
      await nodeRequest(job.node, `/v1/detectors/${job.id}`, {
        method: "DELETE",
        timeout: 3000,
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
  }
  deliver(camera, event, expected) {
    // A compromised/late worker cannot backdate or flood recording triggers.
    if (
      !["motion", "person", "pet", "vehicle"].includes(event.kind) ||
      !Number.isFinite(event.at) ||
      Math.abs(this.now() - event.at) > 30000
    )
      return;
    const job = this.jobs.get(camera.id);
    if (!job || (expected && job !== expected)) return;
    if (this.now() - (job.delivered?.[event.kind] ?? 0) < 3000) return;
    job.delivered ??= {};
    job.delivered[event.kind] = this.now();
    try {
      this.recorder.trigger(
        camera.id,
        event.kind,
        "haus_software_motion",
        event.at,
      );
    } catch {}
  }
  candidates() {
    return this.cluster
      .nodes()
      .filter((node) => {
        const health = this.cluster.health.get(node.id),
          remote = health?.remote;
        const assigned = [...this.jobs.values()].filter(
          (job) => job.node?.id === node.id,
        ).length;
        return (
          node.enabled &&
          node.roles.includes("stream") &&
          health?.online &&
          remote?.detectors?.supported &&
          remote.relayOrigin &&
          !remote.resources?.pressured &&
          (this.cooldowns.get(node.id) ?? 0) <= this.now() &&
          Math.max(assigned, remote.detectors.active ?? 0) <
            remote.detectors.max
        );
      })
      .sort((a, b) => {
        const load = (node) => {
          const remote = this.cluster.health.get(node.id).remote;
          return (
            Math.max(
              remote.detectors.active ?? 0,
              [...this.jobs.values()].filter((job) => job.node?.id === node.id)
                .length,
            ) / Math.max(1, remote.detectors.max)
          );
        };
        return load(a) - load(b);
      });
  }
  async start(camera) {
    if (this.stopped) return;
    const epoch = this.epoch;
    const mode = camera.motionDetection.mode;
    const candidates = this.candidates().slice(0, 3);
    if (
      !candidates.length &&
      (!this.localSupported || [...this.jobs.values()].some((job) => job.local))
    )
      return;
    const sourceDeadline = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(6000),
    ]);
    const source = await Promise.race([
      this.ha.stream(camera.id),
      once(sourceDeadline, "abort").then(() => {
        throw new Error("detector_source_timeout");
      }),
    ]);
    if (this.stopped || this.epoch !== epoch) return;
    for (const node of candidates) {
      const entry = { id: camera.id, source, expires: this.now() + 45000 };
      const lease = randomBytes(24).toString("hex");
      this.warm.leases.set(lease, entry);
      try {
        const origin = this.cluster.health.get(node.id).remote.relayOrigin;
        const url = new URL(
          `/cluster/source/${lease}/${this.warm.resource(entry, source)}`,
          origin,
        ).href;
        const remote = await nodeJson(node, "/v1/detectors", {
          method: "POST",
          data: { source: url, mode },
          timeout: 5000,
          signal: this.abort.signal,
        });
        if (!/^[a-f0-9-]{36}$/.test(remote.id))
          throw new Error("invalid_detector_job");
        const job = {
          id: remote.id,
          node,
          lease,
          entry,
          mode,
          state: "starting",
          sequence: 0,
        };
        this.jobs.set(camera.id, job);
        if (this.stopped || this.epoch !== epoch) await this.release(camera.id);
        return;
      } catch {
        this.warm.leases.delete(lease);
        this.cooldowns.set(node.id, this.now() + 30000);
      }
    }
    // Only one bounded local fallback. Production images include the same worker as the NVR.
    if (
      !this.localSupported ||
      [...this.jobs.values()].some((job) => job.local)
    )
      return;
    if (!this.capacity) {
      const { Capacity } = await import("../vision/capacity.mjs");
      this.capacity = await new Capacity().initialize();
    }
    if (this.stopped || !this.capacity.detectors || this.capacity.pressured)
      return;
    const job = { local: true, mode };
    const worker = new this.worker({
      source,
      mode,
      headers: `Authorization: Bearer ${this.config.token}\r\n`,
      interval: 2500,
      onDetection: (event) => this.deliver(camera, event, job),
    });
    job.worker = worker;
    this.jobs.set(camera.id, job);
    if (this.stopped || this.epoch !== epoch) await this.release(camera.id);
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const enabled = this.cameras.filter(
        (camera) =>
          camera.motionDetection?.enabled &&
          camera.enabled &&
          camera.available &&
          this.config.recording_enabled,
      );
      await eachWorker([...this.jobs], async ([id, job]) => {
        if (this.stopped || this.jobs.get(id) !== job) return;
        const camera = enabled.find((camera) => camera.id === id);
        if (!camera || camera.motionDetection.mode !== job.mode) {
          await this.release(id);
          return;
        }
        try {
          if (job.local) {
            if (job.worker.state === "failed")
              throw new Error("local_detector_failed");
            // Move a local fallback to a recovered NVR without disturbing other cameras.
            if (this.candidates().length) await this.release(id);
          } else {
            const pressured = this.cluster.health.get(job.node.id)?.remote
              ?.resources?.pressured;
            job.overloadedAt = pressured
              ? (job.overloadedAt ?? this.now())
              : undefined;
            if (job.overloadedAt && this.now() - job.overloadedAt > 20000)
              throw new Error("detector_overloaded");
            job.entry.expires = this.now() + 45000;
            const status = await nodeJson(job.node, `/v1/detectors/${job.id}`, {
              timeout: 4000,
              signal: this.abort.signal,
            });
            if (!["starting", "running"].includes(status.state))
              throw new Error("detector_failed");
            job.state = status.state;
            for (const event of (status.events ?? []).slice(-64)) {
              if (
                Number.isSafeInteger(event.sequence) &&
                event.sequence > job.sequence
              ) {
                job.sequence = event.sequence;
                this.deliver(camera, event, job);
              }
            }
          }
        } catch {
          this.cooldowns.set(job.node?.id ?? id, this.now() + 30000);
          await this.release(id);
        }
      });
      for (const camera of enabled
        .filter(
          (camera) =>
            !this.jobs.has(camera.id) &&
            (this.cooldowns.get(camera.id) ?? 0) <= this.now(),
        )
        .slice(0, 3))
        if (
          !this.jobs.has(camera.id) &&
          (this.cooldowns.get(camera.id) ?? 0) <= this.now()
        ) {
          try {
            await this.start(camera);
          } catch {
            this.cooldowns.set(camera.id, this.now() + 30000);
          }
        }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    this.capacity?.stop();
    await Promise.allSettled(
      [...this.jobs.keys()].map((id) => this.release(id)),
    );
  }
}
