import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  readFile,
  writeFile,
  copyFile,
  statfs,
  appendFile,
  mkdir,
  rename,
  unlink,
  stat,
  open,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { runMedia } from "./media.mjs";
export async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function seal(
  source,
  output,
  key,
  metadata,
  { maxBytes = 20 * 1024 ** 3 } = {},
) {
  const iv = randomBytes(12);
  const header = Buffer.from(
    JSON.stringify({ version: 1, ...metadata, iv: iv.toString("hex") }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const temporary = output + ".partial-" + randomUUID();
  let size = 0;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  try {
    const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    stream.write(Buffer.concat([length, header]));
    await pipeline(
      source,
      new Transform({
        transform(chunk, encoding, cb) {
          size += chunk.length;
          cb(size > maxBytes ? new Error("backup_too_large") : null, chunk);
        },
      }),
      cipher,
      stream,
    );
    await appendFile(temporary, cipher.getAuthTag());
    const fd = await open(temporary, "r+");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, output);
    return {
      digest: await fileDigest(output),
      size: (await stat(output)).size,
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export async function unseal(input, output, key) {
  const handle = await open(input, "r");
  let header, tag, offset, size;
  try {
    size = (await handle.stat()).size;
    const prefix = Buffer.alloc(4);
    await handle.read(prefix, 0, 4, 0);
    const count = prefix.readUInt32BE();
    if (count < 1 || count > 16384 || size < count + 20)
      throw new Error("invalid_backup");
    header = Buffer.alloc(count);
    await handle.read(header, 0, count, 4);
    offset = count + 4;
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  const info = JSON.parse(header);
  if (info.version !== 1 || !/^[a-f0-9]{24}$/.test(info.iv))
    throw new Error("invalid_backup");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(info.iv, "hex"),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const temporary = output + ".partial-" + randomUUID();
  try {
    await pipeline(
      createReadStream(input, { start: offset, end: size - 17 }),
      decipher,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    await rename(temporary, output);
    return info;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export class Backups {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.root = join(config.data, "backups");
    this.busy = false;
    this.missing = new Set();
    this.abort = new AbortController();
    this.error = undefined;
    this.lastConfigVersion = 0;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS haus_backups(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at INTEGER NOT NULL,bytes INTEGER NOT NULL,ha_slug TEXT); CREATE TABLE IF NOT EXISTS haus_backup_retries(kind TEXT PRIMARY KEY,next_at INTEGER NOT NULL,failures INTEGER NOT NULL)",
    );
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.config.data, "backup.key");
    try {
      this.key = Buffer.from((await readFile(path, "utf8")).trim(), "hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.key = randomBytes(32);
      await writeFile(path, this.key.toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    }
    if (this.key.length !== 32) throw new Error("invalid_backup_key");
    for (const item of this.list())
      if (!(await stat(this.path(item.digest)).catch(() => null)))
        this.missing.add(item.digest);
  }
  list() {
    return this.store.db
      .prepare(
        "SELECT digest,kind,created_at AS createdAt,bytes,ha_slug AS haSlug FROM haus_backups ORDER BY created_at DESC",
      )
      .all()
      .map((item) => ({ ...item, available: !this.missing.has(item.digest) }));
  }
  path(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_backup");
    return join(this.root, digest + ".enc");
  }
  recoveryKit() {
    return {
      version: 1,
      key: this.key.toString("hex"),
      instructions:
        "Keep this key offline. Use haus-nvr recover with a .enc backup. It is never sent to worker nodes.",
    };
  }
  snapshot(kind = "haus") {
    if (this.running) return Promise.reject(new Error("backup_busy"));
    this.running = this.createSnapshot(kind).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async createSnapshot(kind = "haus") {
    if (this.busy) throw new Error("backup_busy");
    if (!["haus", "ha"].includes(kind)) throw new Error("invalid_backup_kind");
    this.busy = true;
    let directory;
    const createdAt = Date.now();
    const dirtyAt = this.dirtyAt;
    let haSlug;
    try {
      directory = await mkdtemp(join(this.root, ".work-"));
      let source;
      if (kind === "haus") {
        this.store.db
          .prepare("VACUUM INTO ?")
          .run(join(directory, "haus.sqlite"));
        const options = await readFile(
          join(this.config.data, "options.json"),
          "utf8",
        ).catch(() => "{}");
        await writeFile(join(directory, "options.json"), options, {
          mode: 0o600,
        });
        await copyFile(
          join(this.config.data, "backup.key"),
          join(directory, "backup.key"),
        );
        const archive = join(directory, "haus.tar.gz");
        await runMedia("tar", [
          "-czf",
          archive,
          "-C",
          directory,
          "haus.sqlite",
          "options.json",
          "backup.key",
        ]);
        source = createReadStream(archive);
      } else {
        if (this.config.standalone)
          throw new Error("supervisor_backups_unavailable");
        const response = await this.supervisor("/backups/new/partial", {
          method: "POST",
          body: JSON.stringify({
            name: `Haus ${new Date(createdAt).toISOString()} ${randomUUID()}`,
            background: false,
            compressed: true,
            homeassistant: true,
            addons: "ALL",
            folders: ["ssl", "share", "addons/local"],
          }),
        });
        const result = await response.json();
        if (result.result !== "ok" || !result.data?.slug)
          throw new Error("supervisor_backup_failed");
        haSlug = result.data.slug;
        if (!/^[a-zA-Z0-9_-]+$/.test(haSlug))
          throw new Error("invalid_backup_slug");
        const download = await this.supervisor(`/backups/${haSlug}/download`);
        source = Readable.fromWeb(download.body);
      }
      const free = await statfs(this.root);
      const budget = Math.min(
        20 * 1024 ** 3,
        free.bavail * free.bsize - 512 * 1024 ** 2,
      );
      if (budget < 1) throw new Error("backup_storage_full");
      const temporary = join(directory, "sealed.enc");
      const result = await seal(
        source,
        temporary,
        this.key,
        { kind, createdAt },
        { maxBytes: budget },
      );
      await rename(temporary, this.path(result.digest));
      this.store.db
        .prepare(
          "INSERT INTO haus_backups(digest,kind,created_at,bytes,ha_slug)VALUES(?,?,?,?,?)",
        )
        .run(result.digest, kind, createdAt, result.size, haSlug ?? null);
      this.store.db
        .prepare("DELETE FROM haus_backup_retries WHERE kind=?")
        .run(kind);
      this.error = undefined;
      if (kind === "haus" && this.dirtyAt === dirtyAt) this.dirtyAt = undefined;
      await this.prune();
      return this.list().find((item) => item.digest === result.digest);
    } catch (error) {
      if (!this.abort.signal.aborted) {
        const previous = this.store.db
          .prepare("SELECT failures FROM haus_backup_retries WHERE kind=?")
          .get(kind);
        const failures = Math.min(20, (previous?.failures ?? 0) + 1);
        const nextAt =
          Date.now() +
          Math.min(3600000, 300000 * 2 ** Math.min(failures - 1, 4));
        this.store.db
          .prepare(
            "INSERT INTO haus_backup_retries(kind,next_at,failures)VALUES(?,?,?) ON CONFLICT(kind)DO UPDATE SET next_at=excluded.next_at,failures=excluded.failures",
          )
          .run(kind, nextAt, failures);
      }
      this.error =
        kind === "ha"
          ? "Home Assistant backup could not complete"
          : "Configuration backup could not complete";
      throw error;
    } finally {
      this.busy = false;
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async supervisor(path, init = {}) {
    const response = await fetch(`http://supervisor${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(1800000),
        this.abort.signal,
      ]),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("supervisor_backup_failed");
    }
    return response;
  }
  async prune() {
    const counts = { haus: 0, ha: 0 };
    for (const item of this.list()) {
      const limit = item.kind === "ha" ? 7 : 24;
      if (++counts[item.kind] <= limit) continue;
      await unlink(this.path(item.digest)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      this.store.db
        .prepare("DELETE FROM haus_backups WHERE digest=?")
        .run(item.digest);
      if (item.haSlug && !this.config.standalone)
        await this.supervisor(`/backups/${item.haSlug}`, { method: "DELETE" })
          .then((response) => response.body?.cancel())
          .catch(() => {});
    }
  }
  async stop() {
    this.abort.abort();
    await this.running?.catch(() => {});
  }
  markChanged() {
    this.dirtyAt = Date.now();
  }
  async tick() {
    if (this.busy || this.abort.signal.aborted) return;
    const list = this.list();
    const now = Date.now();
    const last = (kind) =>
      list.find((item) => item.kind === kind)?.createdAt ?? 0;
    const ready = (kind) =>
      now >=
      (this.store.db
        .prepare("SELECT next_at FROM haus_backup_retries WHERE kind=?")
        .get(kind)?.next_at ?? 0);
    if (
      ready("haus") &&
      (now - last("haus") > 3600000 ||
        (this.dirtyAt && now - this.dirtyAt >= 10000))
    )
      await this.snapshot("haus");
    else if (
      !this.config.standalone &&
      this.config.ha_backups_enabled &&
      ready("ha") &&
      now - last("ha") > 86400000
    )
      await this.snapshot("ha");
  }
}
