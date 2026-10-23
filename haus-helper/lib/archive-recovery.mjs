import { archiveNodes, verifyArchivedBlob } from "./recording-archive.mjs";

/** Keep the original/prepared descriptor map recoverable before local removal. */
export async function archiveRecovery(cluster) {
  const generation = cluster.store.archiveGeneration();
  if (!generation || !archiveNodes(cluster).length || !cluster.backups.snapshot)
    return null;
  let item = cluster.backups
    .list()
    .find(
      (item) =>
        item.kind === "haus" &&
        item.available !== false &&
        item.archiveGeneration >= generation,
    );
  const pins = [];
  let granted = false;
  try {
    if (!item) {
      const retry = cluster.store.db
        .prepare("SELECT next_at FROM haus_backup_retries WHERE kind='haus'")
        .get();
      if (cluster.backups.busy || retry?.next_at > Date.now()) return null;
      item = await cluster.backups.snapshot("haus");
    }
    if (!item || item.archiveGeneration < generation) return null;
    const nodes = new Set();
    for (const node of archiveNodes(cluster)) {
      const release = await cluster.pinBlob(node.id, item.digest);
      try {
        await cluster.replicate(
          cluster.backups.path(item.digest),
          item.digest,
          "backup",
          [node],
        );
        if (
          !cluster.store.db
            .prepare(
              "SELECT 1 FROM cluster_locations WHERE digest=? AND node_id=? AND kind='backup'",
            )
            .get(item.digest, node.id)
        )
          throw new Error("recovery_catalog_pending");
        await verifyArchivedBlob(cluster, node, item);
        nodes.add(node.id);
        pins.push(release);
      } catch {
        release();
      }
    }
    if (!nodes.size) return null;
    granted = true;
    return {
      generation: item.archiveGeneration,
      nodes,
      release: () => {
        for (const release of pins) release();
      },
    };
  } catch {
    return null;
  } finally {
    if (!granted) for (const release of pins) release();
  }
}
