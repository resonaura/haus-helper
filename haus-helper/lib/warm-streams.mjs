import { randomBytes } from "node:crypto";
import { nodeJson, nodeRequest } from "./node-client.mjs";
const cameraPattern = /^camera\.[a-z0-9_]+$/;
export class WarmStreams {
  constructor(
    ha,
    recorder,
    cluster,
    { limit = 2, idleMs = 45000, now = () => Date.now() } = {},
  ) {
    this.ha = ha;
    this.recorder = recorder;
    this.cluster = cluster;
    this.limit = limit;
    this.idleMs = idleMs;
    this.now = now;
    this.entries = new Map();
    this.leases = new Map();
    this.stopped = false;
  }
  sync(cameras) {
    const available = new Set(
      cameras.filter((camera) => camera.available).map((camera) => camera.id),
    );
    for (const entry of this.entries.values())
      if (!available.has(entry.id)) void this.release(entry).catch(() => {});
  }
  async touch(camera, owner, active, preview = false) {
    if (this.stopped) return { warm: false, reason: "stopped" };
    if (active && preview && camera.batteryPowered)
      return { warm: false, reason: "battery" };
    if (active && camera.available === false)
      return { warm: false, reason: "unavailable" };
    if (
      !cameraPattern.test(camera.id) ||
      typeof owner !== "string" ||
      owner.length > 80
    )
      throw new Error("invalid_warm_session");
    if (active && this.recorder.buffers?.get(camera.id)?.status === "buffering")
      return { warm: true, source: "recording" };
    let entry = this.entries.get(camera.id);
    if (!active) {
      if (entry) {
        entry.owners.delete(owner);
        if (camera.batteryPowered && !entry.owners.size) {
          await this.release(entry);
          return { warm: false };
        }
        entry.expires = this.now() + (camera.batteryPowered ? 0 : this.idleMs);
      }
      return { warm: false };
    }
    if (!entry) {
      let retiring;
      if (this.entries.size >= this.limit) {
        const idle = [...this.entries.values()]
          .filter((e) => !e.owners.size)
          .sort((a, b) => a.expires - b.expires)[0];
        if (!idle) return { warm: false, reason: "capacity" };
        // Reserve the replacement before awaiting teardown; concurrent clients
        // must not each claim the same capacity slot.
        retiring = this.release(idle);
      }
      entry = {
        id: camera.id,
        owners: new Map(),
        expires: this.now() + 90000,
        batteryPowered: camera.batteryPowered,
      };
      this.entries.set(camera.id, entry);
      entry.ready = Promise.resolve(retiring)
        .then(() => this.start(entry))
        .catch(() => {
          if (this.entries.get(entry.id) === entry)
            this.entries.delete(entry.id);
          return undefined;
        });
    }
    if (!entry.owners.has(owner) && entry.owners.size >= 32)
      return { warm: false, reason: "capacity" };
    entry.owners.set(owner, this.now() + 60000);
    entry.expires = this.now() + 90000;
    await entry.ready;
    if (this.entries.get(camera.id) !== entry) return { warm: false };
    return {
      warm: true,
      source: entry.job
        ? "node"
        : this.recorder.buffers?.has(camera.id)
          ? "recording"
          : "ha",
      ...(entry.job
        ? { streamPath: `/api/cameras/${camera.id}/live/index.m3u8` }
        : {}),
      expiresAt: entry.expires,
    };
  }
  async start(entry) {
    if (this.stopped || this.entries.get(entry.id) !== entry) return;
    const source = await this.ha.stream(entry.id);
    if (this.stopped || this.entries.get(entry.id) !== entry) return;
    entry.source = source;
    const candidates =
      this.cluster
        ?.nodes()
        .filter(
          (node) =>
            node.enabled &&
            node.roles.includes("stream") &&
            this.cluster.health.get(node.id)?.online &&
            this.cluster.health.get(node.id)?.remote?.relayOrigin &&
            !this.cluster.health.get(node.id)?.remote?.resources?.pressured &&
            (this.cluster.health.get(node.id)?.remote?.streams?.max ?? 0) >
              (this.cluster.health.get(node.id)?.remote?.streams?.active ?? 0),
        )
        .sort(
          (a, b) =>
            (this.cluster.health.get(a.id)?.remote.streams.active ?? 0) /
              Math.max(
                1,
                this.cluster.health.get(a.id)?.remote.streams.max ?? 1,
              ) -
            (this.cluster.health.get(b.id)?.remote.streams.active ?? 0) /
              Math.max(
                1,
                this.cluster.health.get(b.id)?.remote.streams.max ?? 1,
              ),
        ) ?? [];
    for (const node of candidates.slice(0, 2)) {
      const origin = this.cluster.health.get(node.id).remote.relayOrigin;
      const token = randomBytes(24).toString("hex");
      this.leases.set(token, entry);
      entry.lease = token;
      try {
        const gateway = new URL(
          `/cluster/source/${token}/${this.resource(entry, source)}`,
          origin,
        ).href;
        const job = await nodeJson(node, "/v1/streams", {
          method: "POST",
          data: { source: gateway },
          timeout: 15000,
        });
        if (!/^[a-f0-9-]{36}$/.test(job.id))
          throw new Error("invalid_stream_job");
        entry.job = { id: job.id, node };
        if (this.stopped || this.entries.get(entry.id) !== entry) {
          await this.release(entry);
          return;
        }
        return;
      } catch {
        this.leases.delete(token);
        entry.lease = undefined;
      }
    }
  }
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const entry of this.entries.values()) {
        for (const [owner, until] of entry.owners)
          if (until < now) entry.owners.delete(owner);
        if ((!entry.owners.size && entry.expires <= now) || this.stopped) {
          await this.release(entry);
          continue;
        }
        if (entry.job) {
          try {
            const response = await nodeRequest(
              entry.job.node,
              `/v1/streams/${entry.job.id}/index.m3u8`,
              { timeout: 5000 },
            );
            await response.body?.cancel();
            if (!response.ok) throw new Error("node_stream_unavailable");
            entry.failures = 0;
          } catch {
            if ((entry.failures = (entry.failures ?? 0) + 1) >= 3) {
              const old = entry.job;
              entry.job = undefined;
              if (entry.lease) this.leases.delete(entry.lease);
              entry.lease = undefined;
              entry.failures = 0;
              await nodeRequest(old.node, `/v1/streams/${old.id}`, {
                method: "DELETE",
                timeout: 5000,
              })
                .then((res) => res.body?.cancel())
                .catch(() => {});
              try {
                await this.start(entry);
              } catch {}
            }
          }
          continue;
        }
        if (!entry.source || this.recorder.buffers?.has(entry.id)) continue;
        // Fetch only manifests; no background decoder, audio track or microphone is kept alive.
        try {
          const response = await this.ha.media(entry.source);
          await response.body?.cancel();
          if (!response.ok) throw new Error("warm_source_unavailable");
          entry.failures = 0;
        } catch {
          if ((entry.failures = (entry.failures ?? 0) + 1) >= 3) {
            entry.failures = 0;
            try {
              const source = await this.ha.stream(entry.id);
              if (this.entries.get(entry.id) === entry && !this.stopped)
                entry.source = source;
            } catch {
              /* A later tick retries while the lease remains valid. */
            }
          }
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  async release(entry) {
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    if (entry.lease) this.leases.delete(entry.lease);
    if (entry.job)
      await nodeRequest(entry.job.node, `/v1/streams/${entry.job.id}`, {
        method: "DELETE",
        timeout: 5000,
      })
        .then((res) => res.body?.cancel())
        .catch(() => {});
  }
  resource(entry, value) {
    const source = new URL(entry.source),
      url = new URL(value, source),
      prefix = source.pathname.slice(0, source.pathname.lastIndexOf("/") + 1);
    if (
      url.origin !== source.origin ||
      url.username ||
      url.password ||
      url.pathname.includes("%") ||
      !url.pathname.startsWith(prefix)
    )
      throw new Error("invalid_source_path");
    entry.resources ??= new Map();
    entry.byUrl ??= new Map();
    const known = entry.byUrl.get(url.href);
    if (known) return known;
    if (entry.resources.size >= 256) {
      const oldest =
        [...entry.resources].find(
          ([, value]) => !new URL(value).pathname.endsWith(".m3u8"),
        ) ?? entry.resources.entries().next().value;
      if (oldest) {
        entry.resources.delete(oldest[0]);
        entry.byUrl.delete(oldest[1]);
      }
    }
    const id = randomBytes(12).toString("hex");
    entry.resources.set(id, url.href);
    entry.byUrl.set(url.href, id);
    return id;
  }
  async source(token, id) {
    const entry = this.leases.get(token);
    if (!entry || this.stopped || entry.expires < this.now())
      throw new Error("invalid_source_lease");
    const value = entry.resources?.get(id);
    if (!value) throw new Error("invalid_source_resource");
    entry.resources.delete(id);
    entry.resources.set(id, value);
    return { entry, url: new URL(value), response: await this.ha.media(value) };
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled(
      [...this.entries.values()].map((entry) => this.release(entry)),
    );
  }
}
export function rewritePlaylist(text, base, convert) {
  const resolve = (value) => convert(new URL(value, base).href);
  return text
    .split("\n")
    .map((line) =>
      line.startsWith("#")
        ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${resolve(uri)}"`)
        : line.trim()
          ? resolve(line.trim())
          : line,
    )
    .join("\n");
}
