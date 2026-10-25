import { StorageUsage } from "./storage-usage.mjs";

export function helperStorageUsage(config, backups) {
  if (!config.data || !config.media) return null;
  return new StorageUsage({
    roots: [
      { id: "data", path: config.data },
      { id: "media", path: config.media },
    ],
    classify: () => {
      const kinds = new Map(
        (backups?.list() ?? []).map((item) => [item.digest, item.kind]),
      );
      return (root, path) => {
        if (root === "media") {
          if (/\.partial\.|\.repair-|\.normalize-/.test(path))
            return "temporary";
          if (/\.playback\.mp4$/.test(path)) return "prepared";
          if (/\.mp4$/.test(path)) return "originals";
          if (/\.(jpg|jpeg|png|webp)$/.test(path)) return "snapshots";
          return "other";
        }
        if (path.startsWith("buffer/")) return "prebuffer";
        if (path.startsWith("backups/")) {
          const digest = /^backups\/([a-f0-9]{64})\.enc$/.exec(path)?.[1];
          if (digest && kinds.has(digest))
            return kinds.get(digest) === "ha" ? "ha-backups" : "config-backups";
          return digest ? "other" : "temporary";
        }
        if (/\.(sqlite|db)(-(wal|shm))?$/.test(path)) return "databases";
        if (/\.log(?:\.\d+)?$/.test(path)) return "logs";
        if (/\.concat$/.test(path)) return "temporary";
        if (["options.json", "backup.key"].includes(path))
          return "configuration";
        return "other";
      };
    },
  });
}
