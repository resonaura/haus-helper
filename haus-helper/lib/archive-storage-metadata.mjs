import { createHash } from "node:crypto";
import { recordingMetadata } from "./recording-metadata.mjs";
import { nodeJson } from "./node-client.mjs";

/** Classification follows the authoritative archive descriptors, never filenames
 * or playback-version heuristics. It does not transfer or alter media bytes. */
export function archiveStorageMetadata(store, event, digest) {
  const rows = store.db
    .prepare("SELECT variant,digest FROM event_archive WHERE event_id=?")
    .all(event.id);
  const original = rows.find((row) => row.variant === "original");
  const material = rows.find((row) => row.digest === digest);
  return {
    event: recordingMetadata(event),
    ...(original ? { originalDigest: original.digest } : {}),
    ...(material ? { variant: material.variant } : {}),
  };
}

/** Repair older node catalogs in small resumable batches without reuploading
 * originals or changing the preferred prepared copy. Unknown remains unknown. */
export async function refreshArchiveStorageMetadata(cluster) {
  const rows = cluster.store.db
    .prepare(
      `SELECT l.rowid AS cursor,l.event_id,l.node_id,l.digest
    FROM event_archive_locations l JOIN events e ON e.id=l.event_id
    WHERE l.rowid>? AND l.variant=CASE WHEN e.playback_bytes>0 THEN 'prepared' ELSE 'original' END
      AND (l.variant='original' OR l.version=e.playback_version)
    ORDER BY l.rowid LIMIT 32`,
    )
    .all(cluster.storageMetadataCursor ?? 0);
  if (!rows.length) {
    cluster.storageMetadataCursor = 0;
    return;
  }
  let sent = 0;
  for (const row of rows) {
    if (cluster.stopped || sent >= 8) break;
    cluster.storageMetadataCursor = row.cursor;
    const node = cluster
      .nodes()
      .find((item) => item.id === row.node_id && item.enabled);
    if (
      !node ||
      cluster.health.get(node.id)?.remote?.storage?.usage?.version !== 1
    )
      continue;
    const event = cluster.store.get(row.event_id);
    if (!event || event.status !== "ready") continue;
    const metadata = archiveStorageMetadata(cluster.store, event, row.digest);
    const hash = createHash("sha256")
      .update(JSON.stringify(metadata))
      .digest("hex");
    const previous = cluster.store.db
      .prepare(
        "SELECT metadata_hash FROM cluster_locations WHERE digest=? AND node_id=?",
      )
      .get(row.digest, node.id);
    if (previous?.metadata_hash === hash) continue;
    sent++;
    try {
      await nodeJson(node, "/v1/recordings", {
        method: "POST",
        data: { digest: row.digest, ...metadata },
        signal: cluster.abort.signal,
        timeout: 3000,
      });
      cluster.store.db
        .prepare(
          "INSERT INTO cluster_locations(digest,node_id,kind,metadata_hash)VALUES(?,?,'archive',?) ON CONFLICT(digest,node_id)DO UPDATE SET metadata_hash=excluded.metadata_hash",
        )
        .run(row.digest, node.id, hash);
    } catch {
      /* Catalog-only retry on the next pass; preserved media stays authoritative. */
    }
  }
}
