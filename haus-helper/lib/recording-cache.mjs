import { unlink, stat } from "node:fs/promises";
import {
  archivedVariants,
  archiveNodes,
  verifyArchivedBlob,
  variantExtension,
} from "./recording-archive.mjs";
import { playbackReady } from "./playback.mjs";
import { archiveRecovery } from "./archive-recovery.mjs";

/** Serialized local-only eviction; metadata, thumbnails, NVR originals and pre-roll stay. */
export class RecordingCache {
  constructor(config, store, cluster) {
    Object.assign(this, { config, store, cluster });
  }
  trim() {
    if (this.running) return this.running;
    this.running = this.work().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async work() {
    const policy = this.config.max_storage_gb;
    const limit =
      this.config.max_storage_gb > 0
        ? this.config.max_storage_gb * 1024 ** 3
        : Infinity;
    // Rotation/verification runs asynchronously. Leave bounded space for new
    // captures before the hard admission limit, instead of oscillating just
    // below it and rejecting the next event until the following timer tick.
    const headroom = Number.isFinite(limit)
      ? Math.min(limit * 0.1, 512 * 1024 ** 2)
      : 0;
    const highWater = limit - headroom / 2;
    const target = limit - headroom;
    if (this.store.totals().bytes < highWater) return 0;
    let freed = 0;
    const cursor = this.cursor;
    const after = cursor ? " AND (start_at>? OR (start_at=? AND id>?))" : "";
    const rows = this.store.db
      .prepare(
        `SELECT id,start_at FROM events WHERE status='ready' AND (local_original=1 OR (local_playback=1 AND playback_bytes>0)) ${after} ORDER BY start_at ASC,id ASC LIMIT 64`,
      )
      .all(...(cursor ? [cursor.at, cursor.at, cursor.id] : []));
    if (!rows.length) {
      this.cursor = undefined;
      return 0;
    }
    const recovery = await archiveRecovery(this.cluster);
    if (!recovery) return 0;
    try {
      for (const { id, start_at } of rows) {
        if (this.config.max_storage_gb !== policy) break;
        if (this.cluster.stopped) break;
        this.cursor = { at: start_at, id };
        if (this.store.totals().bytes < target) break;
        const release = this.store.evictMedia(id);
        if (!release) continue;
        const remotePins = [];
        try {
          const event = this.store.get(id);
          if (!event || !playbackReady(event)) continue;
          const descriptors = archivedVariants(this.store, event);
          if (descriptors.some((item) => !item)) continue;
          let verified = false;
          // One healthy storage node must contain every required variant. This
          // avoids leaving an event dependent on disconnected split copies.
          for (const node of archiveNodes(this.cluster).filter((node) =>
            recovery.nodes.has(node.id),
          )) {
            const complete = descriptors.every((item) =>
              this.store.db
                .prepare(
                  "SELECT 1 FROM event_archive_locations WHERE event_id=? AND variant=? AND node_id=? AND digest=? AND version=?",
                )
                .get(id, item.variant, node.id, item.digest, item.version),
            );
            if (!complete) continue;
            const releases = [];
            try {
              for (const item of descriptors) {
                releases.push(await this.cluster.pinBlob(node.id, item.digest));
                await verifyArchivedBlob(this.cluster, node, item);
              }
              // A pause/remove during verification revokes the eviction grant.
              if (
                !archiveNodes(this.cluster).some(
                  (current) => current.id === node.id,
                )
              )
                throw new Error("archive_node_unavailable");
              remotePins.push(...releases);
              verified = true;
              break;
            } catch {
              for (const unpin of releases) unpin();
            }
          }
          if (!verified) continue;
          for (const item of descriptors) {
            if (
              this.config.max_storage_gb !== policy ||
              this.store.archiveGeneration() > recovery.generation
            ) {
              // The current row was deliberately revisited as the next oldest
              // candidate; restarting the keyset scan avoids skipping it after
              // a policy or recovery snapshot changed during verification.
              this.cursor = undefined;
              return freed;
            }
            const local =
              item.variant === "original"
                ? event.localOriginal
                : event.localPlayback;
            if (!local) continue;
            const path = this.store.path(id, variantExtension(item.variant));
            const info = await stat(path).catch(() => null);
            if (info && info.size !== item.bytes)
              throw new Error("local_recording_changed");
            if (
              this.config.max_storage_gb !== policy ||
              this.store.archiveGeneration() > recovery.generation
            ) {
              this.cursor = undefined;
              return freed;
            }
            await unlink(path).catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
            this.store.setLocal(id, item.variant, false);
            this.cluster.backups.markChanged?.();
            freed += item.bytes;
          }
        } finally {
          for (const unpin of remotePins) unpin();
          release();
        }
      }
      if (rows.length < 64) this.cursor = undefined;
      return freed;
    } finally {
      recovery.release();
    }
  }
}
