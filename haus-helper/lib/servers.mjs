import { readFile, readdir, statfs } from "node:fs/promises";
import { HostTelemetry } from "./host-telemetry.mjs";
import { helperStorageUsage } from "./helper-storage-usage.mjs";
export { parseHostCpuModel, parseHostProc } from "./host-telemetry.mjs";

export class Servers {
  constructor({
    config,
    ha,
    store,
    cluster,
    backups,
    fetcher = fetch,
    read = readFile,
    list = readdir,
    filesystem = statfs,
    now = Date.now,
  }) {
    Object.assign(this, {
      config,
      ha,
      store,
      cluster,
      backups,
      fetcher,
      read,
      filesystem,
      now,
    });
    this.telemetry = new HostTelemetry(config, {
      fetcher,
      read,
      list,
      filesystem,
    });
    this.storageUsage = helperStorageUsage(config, backups);
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS service_policy (id TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    const saved = store.db
      .prepare("SELECT value FROM service_policy WHERE id='primary-storage'")
      .get();
    this.policy = saved
      ? JSON.parse(saved.value)
      : {
          storageLimitBytes:
            config.max_storage_gb > 0
              ? config.max_storage_gb * 1024 ** 3
              : null,
          source: config.max_storage_gb > 0 ? "configuration" : "default",
        };
    this.config.max_storage_gb =
      this.policy.storageLimitBytes === null
        ? 0
        : this.policy.storageLimitBytes / 1024 ** 3;
  }
  update(patch) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).length !== 1 ||
      !Object.hasOwn(patch, "storageLimitBytes") ||
      (patch.storageLimitBytes !== null &&
        (!Number.isSafeInteger(patch.storageLimitBytes) ||
          patch.storageLimitBytes < 1024 ** 2))
    )
      throw new Error("invalid_storage_limit");
    this.policy = {
      storageLimitBytes: patch.storageLimitBytes,
      source: "user",
    };
    this.store.db
      .prepare(
        "INSERT INTO service_policy(id,value)VALUES('primary-storage',?) ON CONFLICT(id)DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(this.policy));
    this.config.max_storage_gb =
      patch.storageLimitBytes === null
        ? 0
        : patch.storageLimitBytes / 1024 ** 3;
    this.backups?.markChanged();
    this.cached = undefined;
  }
  async primary() {
    const at = this.now();
    // Coalesce callers without aliasing a one-second UI timer into two-second updates.
    if (this.cached && at - this.cachedAt < 250) return this.cached;
    if (this.loading) return this.loading;
    this.loading = this.collect(at)
      .then((value) => {
        this.cached = value;
        this.cachedAt = at;
        return value;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
  async collect(at) {
    const [host, fs] = await Promise.all([
      this.telemetry.collect(at),
      this.filesystem(this.config.media ?? this.store.media).catch(() => null),
    ]);
    const totals = this.store.totals();
    const usedBytes = totals.bytes,
      freeBytes = fs ? Number(fs.bavail) * Number(fs.bsize) : null;
    const reserveBytes = 256 * 1024 ** 2;
    const availableBytes =
      freeBytes === null
        ? null
        : Math.max(
            0,
            Math.min(
              freeBytes - reserveBytes,
              this.policy.storageLimitBytes === null
                ? Infinity
                : this.policy.storageLimitBytes - usedBytes,
            ),
          );
    return {
      id: "home-assistant",
      kind: "home-assistant",
      name: "Home Assistant",
      online: Boolean(this.ha.connected),
      lastSeen: at,
      enabled: true,
      roles: ["storage", "stream"],
      host,
      settings: { ...this.policy },
      storage: {
        ...(this.storageUsage ? { usage: this.storageUsage.status() } : {}),
        usedBytes,
        localBytes: usedBytes,
        archivedBytes: totals.archivedBytes,
        unavailableBytes: totals.unavailableBytes,
        totalRecordingBytes: totals.totalBytes,
        localEvents: totals.localEvents,
        archivedEvents: totals.archivedEvents,
        cachePolicy: "verified-archive",
        reservedBytes: 0,
        reserveBytes,
        freeBytes,
        totalBytes: fs ? Number(fs.blocks) * Number(fs.bsize) : null,
        availableBytes,
        maxBytes:
          availableBytes === null
            ? this.policy.storageLimitBytes
            : usedBytes + availableBytes,
        storageLimitBytes: this.policy.storageLimitBytes,
        limitSource: this.policy.source,
        retentionDays: this.config.retention_days,
      },
    };
  }
  async status() {
    // A slow/offline peer must not hold HA and other last-known cards hostage.
    // Cluster owns/coalesces the bounded refresh and waits for it on shutdown.
    void this.cluster?.refreshHealth?.().catch(() => {});
    const primary = await this.primary();
    const remotes = (this.cluster?.status().nodes ?? []).map((node) => ({
      id: node.id,
      ...(node.sshServerId ? { sshServerId: node.sshServerId } : {}),
      kind: "nvr",
      name: node.name,
      url: node.url,
      enabled: node.enabled,
      roles: node.roles,
      online: Boolean(node.online),
      lastSeen: node.lastSeen ?? null,
      host: node.remote?.host ?? null,
      storage: node.remote?.storage ?? null,
      settings: node.remote?.settings ?? {
        storageLimitBytes: node.remote?.storage?.storageLimitBytes ?? null,
        source: node.remote?.storage?.limitSource ?? "default",
      },
      streams: node.remote?.streams,
      analysis: node.remote?.analysis,
      playback: node.remote?.playback,
      backupCopies: node.backupCopies,
      error: node.error,
    }));
    return {
      features: { monitoringOnlyServers: true },
      servers: [{ ...primary, online: Boolean(this.ha.connected) }, ...remotes],
      sampledAt: this.now(),
    };
  }
}
