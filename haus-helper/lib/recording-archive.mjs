import { stat } from "node:fs/promises";
import { fileDigest } from "./backups.mjs";
import { nodeJson, nodeRequest } from "./node-client.mjs";
import { recordingMetadata } from "./recording-metadata.mjs";
import { playbackReady, PLAYBACK_VERSION } from "./playback.mjs";
import { ORIGINAL_POLICY_VERSION } from "./playback-compatible.mjs";

export const variantExtension = (variant) =>
  variant === "prepared" ? "playback.mp4" : "mp4";
export function archiveNodes(cluster, now = Date.now()) {
  return cluster.nodes().filter((node) => {
    const health = cluster.health.get(node.id);
    return (
      node.enabled &&
      node.roles.includes("storage") &&
      health?.online &&
      now - health.lastSeen < 60000 &&
      health.remote?.storage?.verification?.supported === true
    );
  });
}
/** A catalog row alone is never evidence that a worker still has intact media. */
export async function verifyArchivedBlob(cluster, node, descriptor) {
  const result = await nodeJson(node, `/v1/blobs/${descriptor.digest}/verify`, {
    method: "POST",
    signal: cluster.abort.signal,
    timeout: 65000,
  });
  if (
    result.verified !== true ||
    result.digest !== descriptor.digest ||
    result.bytes !== descriptor.bytes
  )
    throw new Error("archive_verification_failed");
  const health = cluster.health.get(node.id);
  if (health)
    cluster.health.set(node.id, {
      ...health,
      online: true,
      lastSeen: Date.now(),
    });
}
export async function archiveEvent(cluster, id) {
  const nodes = archiveNodes(cluster);
  if (!nodes.length) return false;
  const release = await cluster.store.pinMedia(id);
  try {
    const event = cluster.store.get(id);
    if (!event || event.status !== "ready" || !playbackReady(event))
      return false;
    const variants = [
      "original",
      ...(event.playbackBytes > 0 ? ["prepared"] : []),
    ];
    const materials = [];
    for (const variant of variants) {
      const version = variant === "prepared" ? event.playbackVersion : 0;
      let descriptor = cluster.store.db
        .prepare("SELECT * FROM event_archive WHERE event_id=? AND variant=?")
        .get(id, variant);
      const file = cluster.store.path(id, variantExtension(variant));
      const local =
        variant === "original" ? event.localOriginal : event.localPlayback;
      if (
        local &&
        (!descriptor ||
          descriptor.version !== version ||
          descriptor.bytes !==
            (variant === "original" ? event.bytes : event.playbackBytes))
      ) {
        const info = await stat(file).catch(() => null);
        if (
          !info?.isFile() ||
          info.size !==
            (variant === "original" ? event.bytes : event.playbackBytes)
        )
          return false;
        const digest = await fileDigest(file);
        const after = await stat(file).catch(() => null);
        if (
          !after ||
          after.ino !== info.ino ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          cluster.store.get(id)?.mediaRevision !== event.mediaRevision
        )
          return false;
        descriptor = { digest, bytes: info.size, version };
        cluster.store.db
          .prepare(
            "INSERT OR REPLACE INTO event_archive(event_id,variant,digest,bytes,version)VALUES(?,?,?,?,?)",
          )
          .run(id, variant, digest, info.size, version);
        cluster.store.markArchiveChanged();
      }
      if (!descriptor || descriptor.version !== version) return false;
      materials.push({ variant, version, descriptor, file, local });
    }
    let copies = 0;
    for (const node of nodes) {
      let complete = true;
      for (const { variant, version, descriptor, file, local } of materials) {
        const saved = cluster.store.db
          .prepare(
            "SELECT * FROM event_archive_locations WHERE event_id=? AND variant=? AND node_id=? AND digest=? AND version=?",
          )
          .get(id, variant, node.id, descriptor.digest, version);
        if (saved) continue;
        const unpin = await cluster.pinBlob(node.id, descriptor.digest);
        try {
          const head = await nodeRequest(
            node,
            `/v1/blobs/${descriptor.digest}`,
            { method: "HEAD", signal: cluster.abort.signal, timeout: 5000 },
          );
          const exists =
            head.ok &&
            Number(head.headers.get("content-length")) === descriptor.bytes;
          await head.body?.cancel();
          if (!exists) {
            if (!local) {
              complete = false;
              break;
            }
            const uploaded = await nodeRequest(
              node,
              `/v1/blobs/${descriptor.digest}`,
              {
                method: "PUT",
                file,
                digest: descriptor.digest,
                length: descriptor.bytes,
                signal: cluster.abort.signal,
                timeout: 600000,
              },
            );
            await uploaded.body?.cancel();
            if (!uploaded.ok) throw new Error("archive_upload_failed");
          }
          await verifyArchivedBlob(cluster, node, descriptor);
          // A worker has one preferred catalog row per event. The original is
          // independently retained in the helper's backed-up archive map; it
          // must never overwrite an already-published prepared catalog entry.
          if (variant === "prepared" || !event.playbackBytes)
            await nodeJson(node, "/v1/recordings", {
              method: "POST",
              data: {
                digest: descriptor.digest,
                event: recordingMetadata(event),
              },
              signal: cluster.abort.signal,
            });
          if (cluster.store.get(id)?.mediaRevision !== event.mediaRevision)
            return false;
          cluster.store.db
            .prepare(
              "INSERT OR REPLACE INTO event_archive_locations(event_id,variant,node_id,digest,bytes,version,verified_at)VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              id,
              variant,
              node.id,
              descriptor.digest,
              descriptor.bytes,
              version,
              Date.now(),
            );
          cluster.store.db
            .prepare(
              "INSERT INTO cluster_locations(digest,node_id,kind)VALUES(?,?,'archive')ON CONFLICT(digest,node_id)DO UPDATE SET kind=CASE WHEN cluster_locations.kind='preparation' THEN 'archive' ELSE cluster_locations.kind END",
            )
            .run(descriptor.digest, node.id);
          cluster.store.markArchiveChanged();
          cluster.backups.markChanged?.();
          cluster.errors.delete(node.id);
        } catch {
          cluster.errors.set(node.id, "Archive pending · local recording kept");
          complete = false;
          break;
        } finally {
          unpin();
        }
      }
      if (complete && ++copies >= 2) break;
    }
    return copies > 0;
  } finally {
    release();
  }
}
export async function archivePending(cluster) {
  const nodes = archiveNodes(cluster),
    count = Math.min(2, nodes.length);
  if (!count) return;
  const ids = nodes.map((node) => node.id);
  const slots = ids.map(() => "?").join(",");
  const cursor = cluster.archiveCursor;
  const after = cursor
    ? " AND (e.start_at>? OR (e.start_at=? AND e.id>?))"
    : "";
  const events = cluster.store.db
    .prepare(
      `SELECT e.id,e.start_at FROM events e WHERE e.status='ready'
    AND e.playback_version=${PLAYBACK_VERSION} AND (e.playback_bytes>0 OR coalesce(json_extract(e.playback_info,'$.originalCompatible'),0)!=1 OR coalesce(json_extract(e.playback_info,'$.originalPolicyVersion'),0)=${ORIGINAL_POLICY_VERSION}) AND
    ((e.local_original=1 AND (SELECT count(*) FROM event_archive_locations a WHERE a.event_id=e.id AND a.variant='original' AND a.node_id IN(${slots}))<?)
    OR (e.playback_bytes>0 AND e.local_playback=1 AND (SELECT count(*) FROM event_archive_locations a WHERE a.event_id=e.id AND a.variant='prepared' AND a.version=e.playback_version AND a.node_id IN(${slots}))<?))
    ${after} ORDER BY e.start_at ASC,e.id ASC LIMIT 8`,
    )
    .all(
      ...ids,
      count,
      ...ids,
      count,
      ...(cursor ? [cursor.at, cursor.at, cursor.id] : []),
    );
  if (!events.length) {
    cluster.archiveCursor = undefined;
    return;
  }
  for (const { id, start_at } of events) {
    cluster.archiveCursor = { at: start_at, id };
    if (cluster.stopped) break;
    await archiveEvent(cluster, id).catch(() => {});
  }
  if (events.length < 8) cluster.archiveCursor = undefined;
}
export function archivedVariants(store, event) {
  const variants = [
    "original",
    ...(event.playbackBytes > 0 ? ["prepared"] : []),
  ];
  return variants.map((variant) =>
    store.db
      .prepare(
        "SELECT * FROM event_archive WHERE event_id=? AND variant=? AND version=?",
      )
      .get(
        event.id,
        variant,
        variant === "prepared" ? event.playbackVersion : 0,
      ),
  );
}
export async function archivedMedia(
  cluster,
  event,
  variant,
  range,
  signal,
  method = "GET",
) {
  const descriptor = cluster.store.db
    .prepare(
      "SELECT * FROM event_archive WHERE event_id=? AND variant=? AND version=?",
    )
    .get(event.id, variant, variant === "prepared" ? event.playbackVersion : 0);
  if (!descriptor) return null;
  const locations = new Set(
    cluster.store.db
      .prepare(
        "SELECT node_id FROM event_archive_locations WHERE event_id=? AND variant=? AND digest=? AND version=?",
      )
      .all(event.id, variant, descriptor.digest, descriptor.version)
      .map((row) => row.node_id),
  );
  for (const node of archiveNodes(cluster).filter((node) =>
    locations.has(node.id),
  )) {
    const release = await cluster.pinBlob(node.id, descriptor.digest);
    try {
      const response = await nodeRequest(
        node,
        `/v1/blobs/${descriptor.digest}`,
        {
          method,
          signal,
          timeout: 600000,
          headerTimeout: 3000,
          headers: range ? { Range: range } : {},
        },
      );
      const total = response.headers
        .get("content-range")
        ?.match(/\/(\d+)$/)?.[1];
      if (
        (response.status === 200 &&
          Number(response.headers.get("content-length")) ===
            descriptor.bytes) ||
        (response.status === 206 && Number(total) === descriptor.bytes)
      ) {
        // Server holds the event pin through the pipeline; cluster retention can
        // never delete this digest while its event still exists and is pinned.
        return { response, release };
      }
      await response.body?.cancel();
    } catch {}
    release();
  }
  return null;
}
