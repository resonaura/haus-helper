import { archivePending, archivedMedia } from "./recording-archive.mjs";
import { RecordingCache } from "./recording-cache.mjs";
import { randomUUID, createHash } from "node:crypto";
import { recordingMetadata } from "./recording-metadata.mjs";
import { stat } from "node:fs/promises";
import { nodeAddress, nodeRequest, nodeJson } from "./node-client.mjs";
import { fileDigest } from "./backups.mjs";
import {
  prepareClusterPlayback,
  playbackCandidates,
} from "./cluster-playback.mjs";
export class Cluster {
  constructor(store, backups, { now = Date.now } = {}) {
    this.store = store;
    this.backups = backups;
    this.now = now;
    this.health = new Map();
    this.busy = false;
    this.stopped = false;
    this.abort = new AbortController();
    this.errors = new Map();
    this.playbackNodes = new Set();
    this.blobPins = new Map();
    this.blobDeletes = new Map();
    this.healthRevision = 0;
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS cluster_nodes(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cluster_locations(digest TEXT NOT NULL,node_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(digest,node_id));
 CREATE TABLE IF NOT EXISTS cluster_media(event_id TEXT PRIMARY KEY,digest TEXT NOT NULL,bytes INTEGER NOT NULL,version INTEGER NOT NULL);`);
    // Existing blob copies remain valid; their catalog may predate newly
    // supported repair fields. Reconcile metadata without uploading the blob.
    const columns = new Set(
      store.db
        .prepare("PRAGMA table_info(cluster_locations)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("catalog_version"))
      store.db.exec(
        "ALTER TABLE cluster_locations ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.has("metadata_hash"))
      store.db.exec(
        "ALTER TABLE cluster_locations ADD COLUMN metadata_hash TEXT",
      );
  }
  nodes() {
    return this.store.db
      .prepare("SELECT id,value FROM cluster_nodes")
      .all()
      .map((row) => ({ id: row.id, ...JSON.parse(row.value) }));
  }
  /** Pins synchronize replica adoption and temporary playback against pruning. */
  async pinBlob(nodeId, digest) {
    const key = `${nodeId}:${digest}`;
    while (this.blobDeletes.has(key)) await this.blobDeletes.get(key);
    this.abort.signal.throwIfAborted();
    this.blobPins.set(key, (this.blobPins.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.blobPins.get(key) ?? 1) - 1;
      if (remaining) this.blobPins.set(key, remaining);
      else this.blobPins.delete(key);
    };
  }
  notePlaybackUpload(nodeId, digest) {
    this.store.db
      .prepare(
        "INSERT INTO cluster_locations(digest,node_id,kind)VALUES(?,?,'preparation') ON CONFLICT(digest,node_id)DO NOTHING",
      )
      .run(digest, nodeId);
  }
  canPreparePlayback() {
    return playbackCandidates(this).length > 0;
  }
  preparePlayback(event, options) {
    return prepareClusterPlayback(this, event, options);
  }
  status() {
    const backups = this.backups.list();
    return {
      optional: true,
      nodes: this.nodes().map(({ key, ...node }) => ({
        ...node,
        ...this.health.get(node.id),
        error: this.errors.get(node.id),
        backupCopies: this.store.db
          .prepare(
            "SELECT count(*) AS n FROM cluster_locations WHERE node_id=? AND kind='backup'",
          )
          .get(node.id).n,
      })),
      backups: {
        items: backups,
        busy: this.backups.busy,
        error: this.backups.error,
      },
      sync: { enabled: true, authority: "helper" },
      busy: this.busy,
    };
  }
  async add(input) {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100 ||
      typeof input.key !== "string" ||
      input.key.length < 32 ||
      input.key.length > 256 ||
      typeof input.allowHttp !== "boolean" ||
      !Array.isArray(input.roles) ||
      !input.roles.length ||
      input.roles.some((role) => !["storage", "stream"].includes(role))
    )
      throw new Error("invalid_node");
    const node = {
      id: randomUUID(),
      name: input.name.trim(),
      url: nodeAddress(input.url, input.allowHttp),
      key: input.key,
      roles: [...new Set(input.roles)],
      allowHttp: input.allowHttp,
      enabled: true,
    };
    if (this.nodes().some((item) => item.url === node.url))
      throw new Error("invalid_duplicate_node");
    const status = await nodeJson(node, "/v1/status", {
      signal: this.abort.signal,
      timeout: 10000,
    });
    if (
      status.protocol !== 1 ||
      typeof status.nodeId !== "string" ||
      !status.storage ||
      !status.streams
    )
      throw new Error("invalid_node_protocol");
    node.instanceId = status.instanceId;
    this.store.db
      .prepare("INSERT INTO cluster_nodes(id,value)VALUES(?,?)")
      .run(node.id, JSON.stringify(node));
    this.health.set(node.id, {
      online: true,
      lastSeen: Date.now(),
      remote: status,
    });
    this.invalidateHealth();
    this.backups.markChanged();
    return this.status();
  }
  async update(id, patch) {
    const node = this.nodes().find((node) => node.id === id);
    if (!node) throw new Error("invalid_node");
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      !Object.keys(patch).length ||
      Object.keys(patch).some(
        (key) => !["enabled", "storageLimitBytes"].includes(key),
      ) ||
      (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
      (patch.storageLimitBytes !== undefined &&
        patch.storageLimitBytes !== null &&
        (!Number.isSafeInteger(patch.storageLimitBytes) ||
          patch.storageLimitBytes < 1024 ** 2))
    )
      throw new Error("invalid_node");
    if (Object.hasOwn(patch, "storageLimitBytes")) {
      const settings = await nodeJson(node, "/v1/settings", {
        method: "PATCH",
        data: { storageLimitBytes: patch.storageLimitBytes },
        signal: this.abort.signal,
        timeout: 10000,
      });
      if (settings.storageLimitBytes !== patch.storageLimitBytes)
        throw new Error("invalid_node_settings");
      const health = this.health.get(id);
      if (health?.remote)
        this.health.set(id, {
          ...health,
          remote: {
            ...health.remote,
            settings,
            storage: {
              ...health.remote.storage,
              storageLimitBytes: settings.storageLimitBytes,
            },
          },
        });
    }
    this.store.db.prepare("UPDATE cluster_nodes SET value=? WHERE id=?").run(
      JSON.stringify({
        ...node,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      }),
      id,
    );
    this.invalidateHealth();
    this.backups.markChanged();
    return this.status();
  }
  remove(id) {
    this.store.db.prepare("DELETE FROM cluster_nodes WHERE id=?").run(id);
    this.store.db
      .prepare("DELETE FROM cluster_locations WHERE node_id=?")
      .run(id);
    this.health.delete(id);
    this.invalidateHealth();
    this.backups.markChanged();
    return this.status();
  }
  invalidateHealth() {
    this.healthRevision += 1;
    this.healthSampledAt = undefined;
  }
  /** Dashboard refreshes stay independent of slow archive work, without extra media polling. */
  refreshHealth({ force = false } = {}) {
    if (this.stopped) return Promise.resolve();
    if (this.healthRefresh) {
      if (!force || this.healthRefreshForced) return this.healthRefresh;
      // A pre-copy dashboard request may already have sampled old storage.
      // Queue exactly one fresh pass after it, instead of overlapping polls.
      if (!this.forcedHealthRefresh)
        this.forcedHealthRefresh = this.healthRefresh
          .catch(() => {})
          .then(() => this.refreshHealth({ force: true }))
          .finally(() => {
            this.forcedHealthRefresh = undefined;
          });
      return this.forcedHealthRefresh;
    }
    const at = this.now();
    if (
      !force &&
      this.healthSampledAt !== undefined &&
      at >= this.healthSampledAt &&
      at - this.healthSampledAt < 1000
    )
      return Promise.resolve();
    const revision = this.healthRevision;
    this.healthRefreshForced = force;
    this.healthRefresh = Promise.resolve()
      .then(() => this.poll())
      .finally(() => {
        if (revision === this.healthRevision) this.healthSampledAt = at;
        this.healthRefresh = undefined;
        this.healthRefreshForced = false;
      });
    return this.healthRefresh;
  }
  async poll() {
    const nodes = this.nodes().filter((node) => node.enabled);
    let index = 0;
    const worker = async () => {
      while (index < nodes.length && !this.stopped) {
        const node = nodes[index++];
        try {
          const remote = await nodeJson(node, "/v1/status", {
            signal: this.abort.signal,
            timeout: 5000,
          });
          if (
            this.stopped ||
            !this.nodes().some(
              (current) => current.id === node.id && current.enabled,
            )
          )
            continue;
          if (remote.protocol !== 1 || typeof remote.instanceId !== "string")
            throw new Error();
          if (node.instanceId !== remote.instanceId) {
            this.store.db
              .prepare("DELETE FROM cluster_locations WHERE node_id=?")
              .run(node.id);
            this.store.db
              .prepare("UPDATE cluster_nodes SET value=? WHERE id=?")
              .run(
                JSON.stringify({ ...node, instanceId: remote.instanceId }),
                node.id,
              );
          }
          this.health.set(node.id, {
            online: true,
            lastSeen: this.now(),
            remote,
          });
        } catch {
          if (
            this.stopped ||
            !this.nodes().some(
              (current) => current.id === node.id && current.enabled,
            )
          )
            continue;
          this.health.set(node.id, {
            ...this.health.get(node.id),
            online: false,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, nodes.length) }, worker),
    );
  }
  async replicate(file, digest, kind, nodes) {
    const row =
      kind === "media"
        ? this.store.db
            .prepare("SELECT event_id FROM cluster_media WHERE digest=?")
            .get(digest)
        : null;
    const release = row ? await this.store.pinMedia(row.event_id) : () => {};
    try {
      return await this.replicatePinned(file, digest, kind, nodes);
    } finally {
      release();
    }
  }
  async replicatePinned(file, digest, kind, nodes) {
    const info = await stat(file).catch(() => null);
    if (!info) return;
    const bytes = info.size;
    for (const node of nodes) {
      if (this.stopped) return;
      const release = await this.pinBlob(node.id, digest);
      try {
        let metadata, metadataHash;
        if (kind === "media") {
          const row = this.store.db
            .prepare("SELECT event_id FROM cluster_media WHERE digest=?")
            .get(digest);
          if (!row) continue;
          metadata = recordingMetadata(this.store.get(row.event_id));
          metadataHash = createHash("sha256")
            .update(JSON.stringify(metadata))
            .digest("hex");
        }
        const location = this.store.db
          .prepare(
            "SELECT kind, catalog_version, metadata_hash FROM cluster_locations WHERE digest=? AND node_id=?",
          )
          .get(digest, node.id);
        if (
          location?.kind === kind &&
          (kind !== "media" ||
            (location.catalog_version === 1 &&
              location.metadata_hash === metadataHash))
        )
          continue;
        const status = this.health.get(node.id)?.remote;
        if (
          !location &&
          status?.storage &&
          (status.storage.availableBytes ??
            status.storage.maxBytes -
              status.storage.usedBytes -
              status.storage.reservedBytes) < bytes
        )
          throw new Error("storage_full");
        const head = await nodeRequest(node, `/v1/blobs/${digest}`, {
          method: "HEAD",
          signal: this.abort.signal,
        });
        const exists = head.ok;
        await head.body?.cancel();
        if (!exists) {
          const response = await nodeRequest(node, `/v1/blobs/${digest}`, {
            method: "PUT",
            file,
            digest,
            length: bytes,
            signal: this.abort.signal,
            timeout: 600000,
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("replication_failed");
          }
          await response.body?.cancel();
        }
        if (kind === "backup") {
          const metadata = this.backups
            .list()
            .find((item) => item.digest === digest);
          await nodeJson(node, "/v1/backups", {
            method: "POST",
            data: {
              digest,
              kind: metadata.kind,
              createdAt: metadata.createdAt,
              bytes: metadata.bytes,
            },
            signal: this.abort.signal,
          });
        }
        if (kind === "media") {
          await nodeJson(node, "/v1/recordings", {
            method: "POST",
            data: {
              digest,
              event: metadata,
            },
            signal: this.abort.signal,
          });
        }
        this.store.db
          .prepare(
            "INSERT OR REPLACE INTO cluster_locations(digest,node_id,kind,catalog_version,metadata_hash)VALUES(?,?,?,?,?)",
          )
          .run(
            digest,
            node.id,
            kind,
            kind === "media" ? 1 : 0,
            metadataHash ?? null,
          );
        this.errors.delete(node.id);
      } catch {
        this.errors.set(node.id, "Copy pending · will retry");
      } finally {
        release();
      }
    }
  }
  tick() {
    if (this.busy || this.stopped) return this.running;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async work() {
    this.busy = true;
    try {
      await this.refreshHealth();
      const peers = this.nodes().filter(
        (node) => node.enabled && this.health.get(node.id)?.online,
      );
      const nodes = peers.filter((node) => node.roles.includes("storage"));
      // Configuration/HA recovery copies go to every storage node by default.
      for (const item of this.backups.list())
        await this.replicate(
          this.backups.path(item.digest),
          item.digest,
          "backup",
          peers,
        );
      // Keep the helper authoritative; node failures never discard its original media.
      const nodeIds = nodes.map((node) => node.id);
      const events = nodeIds.length
        ? this.store.db
            .prepare(
              `SELECT e.id FROM events e LEFT JOIN cluster_media m ON m.event_id=e.id WHERE e.status='ready' AND (m.event_id IS NULL OR m.version!=e.playback_version OR (SELECT count(*) FROM cluster_locations l WHERE l.digest=m.digest AND l.catalog_version=1 AND l.node_id IN (${nodeIds.map(() => "?").join(",")}))<?) ORDER BY e.start_at DESC LIMIT 8`,
            )
            .all(...nodeIds, Math.min(2, nodeIds.length))
        : [];
      for (const { id } of events) {
        const release = await this.store.pinMedia(id);
        try {
          const event = this.store.get(id);
          const version = event.playbackVersion;
          let media = this.store.db
            .prepare("SELECT * FROM cluster_media WHERE event_id=?")
            .get(id);
          const file = this.store.path(
            id,
            event.playbackBytes ? "playback.mp4" : "mp4",
          );
          if (!media || media.version !== version) {
            try {
              media = {
                digest: await fileDigest(file),
                bytes: (await stat(file)).size,
                version,
              };
              this.store.db
                .prepare(
                  "INSERT OR REPLACE INTO cluster_media(event_id,digest,bytes,version)VALUES(?,?,?,?)",
                )
                .run(id, media.digest, media.bytes, version);
            } catch {
              continue;
            }
          }
          const ranked = [...nodes].sort(
            (a, b) =>
              this.health.get(a.id)?.remote.storage.usedBytes /
                Math.max(1, this.health.get(a.id)?.remote.storage.maxBytes) -
              this.health.get(b.id)?.remote.storage.usedBytes /
                Math.max(1, this.health.get(b.id)?.remote.storage.maxBytes),
          );
          const existing = new Set(
            this.store.db
              .prepare("SELECT node_id FROM cluster_locations WHERE digest=?")
              .all(media.digest)
              .map((row) => row.node_id),
          );
          ranked.sort(
            (a, b) => Number(existing.has(b.id)) - Number(existing.has(a.id)),
          );
          await this.replicate(file, media.digest, "media", ranked.slice(0, 2));
        } finally {
          release();
        }
      }
      await this.refreshHealth({ force: true });
      await archivePending(this);
      await this.refreshHealth({ force: true });
      await this.recordingCache?.trim();
      await this.prune(peers);
    } finally {
      this.busy = false;
    }
  }
  async prune(nodes) {
    const backups = new Set(this.backups.list().map((item) => item.digest));
    const media = new Set(
      this.store.db
        .prepare(
          "SELECT digest FROM cluster_media WHERE event_id IN(SELECT id FROM events)",
        )
        .all()
        .map((row) => row.digest),
    );
    for (const { digest } of this.store.db
      .prepare(
        "SELECT digest FROM event_archive WHERE event_id IN(SELECT id FROM events)",
      )
      .all())
      media.add(digest);
    for (const node of nodes) {
      const rows = this.store.db
        .prepare("SELECT digest,kind FROM cluster_locations WHERE node_id=?")
        .all(node.id);
      for (const row of rows) {
        if (
          row.kind !== "preparation" &&
          (row.kind === "backup" ? backups : media).has(row.digest)
        )
          continue;
        const key = `${node.id}:${row.digest}`;
        if (this.blobPins.has(key) || this.blobDeletes.has(key)) continue;
        const remove = (async () => {
          try {
            const response = await nodeRequest(
              node,
              `/v1/blobs/${row.digest}`,
              {
                method: "DELETE",
                signal: this.abort.signal,
                timeout: 10000,
              },
            );
            await response.body?.cancel();
            if (response.ok)
              this.store.db
                .prepare(
                  "DELETE FROM cluster_locations WHERE digest=? AND node_id=?",
                )
                .run(row.digest, node.id);
          } catch {
          } finally {
            this.blobDeletes.delete(key);
          }
        })();
        this.blobDeletes.set(key, remove);
        await remove;
      }
    }
    this.store.db.exec(
      "DELETE FROM cluster_media WHERE event_id NOT IN(SELECT id FROM events); DELETE FROM event_archive WHERE event_id NOT IN(SELECT id FROM events); DELETE FROM event_archive_locations WHERE event_id NOT IN(SELECT id FROM events)",
    );
  }
  enableRecordingCache(config) {
    this.recordingCache = new RecordingCache(config, this.store, this);
    return this.recordingCache;
  }
  archiveMedia(event, variant, range, signal, method) {
    return archivedMedia(this, event, variant, range, signal, method);
  }
  async source(event) {
    const media = this.store.db
      .prepare("SELECT * FROM cluster_media WHERE event_id=? AND version=?")
      .get(event.id, event.playbackVersion);
    if (!media) return null;
    const locations = new Set(
      this.store.db
        .prepare("SELECT node_id FROM cluster_locations WHERE digest=?")
        .all(media.digest)
        .map((row) => row.node_id),
    );
    const nodes = this.nodes()
      .filter(
        (node) =>
          node.enabled &&
          node.roles.includes("stream") &&
          locations.has(node.id) &&
          this.health.get(node.id)?.online,
      )
      .sort(
        (a, b) =>
          (this.health.get(a.id)?.remote.streams.active ?? 0) -
          (this.health.get(b.id)?.remote.streams.active ?? 0),
      );
    for (const node of nodes)
      try {
        const grant = await nodeJson(node, "/v1/grants", {
          method: "POST",
          data: { digest: media.digest },
          signal: this.abort.signal,
          timeout: 5000,
        });
        if (
          typeof grant.path !== "string" ||
          !grant.path.startsWith(`/media/${media.digest}?`)
        )
          continue;
        return {
          url: new URL(grant.path, node.url).href,
          expiresAt: grant.expiresAt,
        };
      } catch {}
    return null;
  }
  async media(event, range, signal) {
    const media = this.store.db
      .prepare("SELECT * FROM cluster_media WHERE event_id=? AND version=?")
      .get(event.id, event.playbackVersion);
    if (!media) return null;
    const locations = new Set(
      this.store.db
        .prepare("SELECT node_id FROM cluster_locations WHERE digest=?")
        .all(media.digest)
        .map((row) => row.node_id),
    );
    const candidates = this.nodes()
      .filter(
        (node) =>
          node.enabled &&
          node.roles.includes("stream") &&
          locations.has(node.id) &&
          this.health.get(node.id)?.online,
      )
      .sort(
        (a, b) =>
          (this.health.get(a.id)?.remote.streams.active ?? 0) -
          (this.health.get(b.id)?.remote.streams.active ?? 0),
      );
    for (const node of candidates) {
      try {
        const response = await nodeRequest(node, `/v1/blobs/${media.digest}`, {
          signal,
          timeout: 600000,
          headerTimeout: 3000,
          headers: range ? { Range: range } : {},
        });
        if (response.ok) return response;
        await response.body?.cancel();
      } catch {}
    }
    return null;
  }
  async stop() {
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([
      this.running,
      this.healthRefresh,
      this.forcedHealthRefresh,
      this.recordingCache?.running,
    ]);
  }
}
