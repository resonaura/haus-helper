import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldIO } from "node:timers/promises";

/** File accounting only: never reads contents or follows symbolic links.
 * st_blocks is allocated filesystem space, not exclusive physical extents.
 * Hard links are counted once; reflink/compression sharing cannot be inferred.
 */
export class StorageUsage {
  constructor({
    roots,
    classify,
    now = Date.now,
    interval = 30000,
    maxEntries = 100000,
    budgetMs = 3000,
    inspect = lstat,
    list = opendir,
  }) {
    Object.assign(this, {
      roots,
      classify,
      now,
      interval,
      maxEntries,
      budgetMs,
      inspect,
      list,
    });
  }
  status() {
    if (
      !this.stopped &&
      !this.loading &&
      (!this.value || this.now() - this.startedAt >= this.interval)
    ) {
      this.startedAt = this.now();
      this.loading = Promise.resolve()
        .then(() => this.collect())
        .then((value) => {
          this.value = value;
        })
        .catch(() => {
          this.value = {
            version: 1,
            sampledAt: this.now(),
            complete: false,
            logicalBytes: null,
            allocatedBytes: null,
            categories: [],
          };
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    return this.value ?? null;
  }
  async stop() {
    this.stopped = true;
    await this.loading;
  }
  async collect() {
    const start = this.now(),
      started = performance.now();
    const files = new Map(),
      directories = new Set();
    const roots = new Map(this.roots.map((root) => [root.path, root.id]));
    let complete = true,
      visited = 0,
      duplicateFiles = 0,
      skippedLinks = 0;
    // Snapshot metadata once so concurrent recordings cannot change classification
    // half way through this scan. Callers provide a classifier for this generation.
    const classify = this.classify();
    const queue = this.roots.map((root) => ({
      path: root.path,
      root: root.id,
      relative: "",
    }));
    const expired = () =>
      this.stopped ||
      visited >= this.maxEntries ||
      performance.now() - started > this.budgetMs;
    while (queue.length) {
      if (expired()) {
        complete = false;
        break;
      }
      const item = queue.pop();
      if (roots.has(item.path) && roots.get(item.path) !== item.root) continue;
      let info;
      try {
        info = await this.inspect(item.path, { bigint: true });
      } catch {
        complete = false;
        continue;
      }
      visited++;
      if (info.isSymbolicLink()) {
        skippedLinks++;
        continue;
      }
      const identity = info.ino > 0 ? `${info.dev}:${info.ino}` : item.path;
      if (info.isDirectory()) {
        if (directories.has(identity)) continue;
        directories.add(identity);
        try {
          const directory = await this.list(item.path);
          for await (const entry of directory) {
            if (expired()) {
              complete = false;
              break;
            }
            queue.push({
              path: join(item.path, entry.name),
              root: item.root,
              relative: item.relative
                ? `${item.relative}/${entry.name}`
                : entry.name,
            });
            // Bound directory enumeration as well as stat calls.
            if (queue.length + visited >= this.maxEntries) {
              complete = false;
              break;
            }
          }
        } catch {
          complete = false;
        }
      } else if (info.isFile()) {
        const size = Number(info.size),
          blocks = Number(info.blocks);
        if (!Number.isSafeInteger(size) || size < 0) {
          complete = false;
          continue;
        }
        const category = classify(item.root, item.relative) || "other";
        const previous = files.get(identity);
        if (previous) {
          duplicateFiles++;
          if (previous.category !== category) previous.category = "shared";
        } else
          files.set(identity, {
            category,
            logicalBytes: size,
            allocatedBytes:
              info.blocks !== undefined &&
              Number.isSafeInteger(blocks * 512) &&
              blocks >= 0
                ? blocks * 512
                : null,
          });
      }
      if (visited % 64 === 0) await yieldIO();
    }
    const categories = new Map();
    for (const file of files.values()) {
      const row = categories.get(file.category) ?? {
        id: file.category,
        logicalBytes: 0,
        allocatedBytes: 0,
        files: 0,
      };
      row.logicalBytes += file.logicalBytes;
      row.allocatedBytes =
        row.allocatedBytes === null || file.allocatedBytes === null
          ? null
          : row.allocatedBytes + file.allocatedBytes;
      row.files++;
      categories.set(row.id, row);
    }
    const rows = [...categories.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return {
      version: 1,
      sampledAt: start,
      complete,
      files: files.size,
      duplicateFiles,
      skippedLinks,
      logicalBytes: rows.reduce((sum, row) => sum + row.logicalBytes, 0),
      allocatedBytes: rows.some((row) => row.allocatedBytes === null)
        ? null
        : rows.reduce((sum, row) => sum + row.allocatedBytes, 0),
      categories: rows,
    };
  }
}

export function nodeStorageCategory(path, roles = new Map()) {
  if (/^blobs\/[a-f0-9]{64}$/.test(path))
    return roles.get(path.slice(6)) ?? "other-media";
  if (path.startsWith("blobs/.partial-")) return "temporary";
  if (path.startsWith("camera-sessions/"))
    return /\/event-[^/]+\//.test(path) ? "capture" : "prebuffer";
  if (path.startsWith("playback/")) return "preparation";
  if (path.startsWith("streams/")) return "stream-cache";
  if (/\.(sqlite|db)(-(wal|shm))?$/.test(path)) return "databases";
  if (/\.log(?:\.\d+)?$/.test(path)) return "logs";
  if (["catalog.json", "settings.json", "instance-id"].includes(path))
    return "configuration";
  return "other";
}

export function addStorageRole(roles, digest, role) {
  if (!/^[a-f0-9]{64}$/.test(digest ?? "")) return;
  const old = roles.get(digest);
  roles.set(digest, old && old !== role ? "shared" : role);
}
