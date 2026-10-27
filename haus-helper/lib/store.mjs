import { DatabaseSync } from "node:sqlite";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export class Store {
  constructor(database, media) {
    this.db = new DatabaseSync(database);
    this.media = media;
    this.mediaPins = new Map();
    this.mediaEvictions = new Map();
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, status TEXT NOT NULL, kinds TEXT NOT NULL, detections TEXT NOT NULL, duration REAL DEFAULT 0, bytes INTEGER DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS events_camera_time ON events(camera_id,start_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS events_camera_status_time ON events(camera_id,status,start_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS camera_availability (camera_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(camera_id,start_at));
    CREATE INDEX IF NOT EXISTS camera_availability_time ON camera_availability(camera_id,end_at);
    PRAGMA user_version=2;`);
    const columns = this.db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((row) => row.name);
    if (!columns.includes("playback_version"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN playback_version INTEGER DEFAULT 0",
      );
    if (!columns.includes("playback_bytes"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN playback_bytes INTEGER DEFAULT 0",
      );
    if (!columns.includes("playback_info"))
      this.db.exec("ALTER TABLE events ADD COLUMN playback_info TEXT");
    if (!columns.includes("media_start_at"))
      this.db.exec("ALTER TABLE events ADD COLUMN media_start_at INTEGER");
    if (!columns.includes("media_revision"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN media_revision INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.includes("local_original"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN local_original INTEGER NOT NULL DEFAULT 1",
      );
    if (!columns.includes("local_playback"))
      this.db.exec(
        "ALTER TABLE events ADD COLUMN local_playback INTEGER NOT NULL DEFAULT 1",
      );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS event_archive(event_id TEXT NOT NULL,variant TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(event_id,variant));
      CREATE TABLE IF NOT EXISTS event_archive_locations(event_id TEXT NOT NULL,variant TEXT NOT NULL,node_id TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL,version INTEGER NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(event_id,variant,node_id));
      CREATE TABLE IF NOT EXISTS event_archive_state(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO event_archive_state VALUES(1,0);
      PRAGMA user_version=6`);
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)");
    if (
      !this.db
        .prepare("SELECT id FROM migrations WHERE id=?")
        .get("explicit-recording-policy")
    ) {
      // Preserve recording choices for cameras known before the opt-in default.
      // An empty/new installation has no historical cameras and enables none.
      const known = this.db
        .prepare(
          "SELECT DISTINCT camera_id FROM camera_availability UNION SELECT DISTINCT camera_id FROM events",
        )
        .all();
      const overrides = this.overrides();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const { camera_id: id } of known) {
          const previous = overrides[id] ?? {};
          if (previous.enabled === undefined)
            this.setCamera(id, { ...previous, enabled: true });
        }
        this.db
          .prepare("INSERT INTO migrations(id) VALUES(?)")
          .run("explicit-recording-policy");
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  overrides() {
    return Object.fromEntries(
      this.db
        .prepare("SELECT id,value FROM settings")
        .all()
        .map((row) => [row.id, JSON.parse(row.value)]),
    );
  }
  setCamera(id, value) {
    this.db
      .prepare(
        "INSERT INTO settings(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(value));
  }
  observeAvailability(cameraId, state, at = Date.now()) {
    if (!["online", "offline", "unknown"].includes(state))
      throw new Error("invalid_availability");
    const previous = this.db
      .prepare(
        "SELECT * FROM camera_availability WHERE camera_id=? ORDER BY start_at DESC LIMIT 1",
      )
      .get(cameraId);
    if (previous && at < previous.end_at) return;
    // Heartbeats stop at the last observation. A process outage is never labelled camera-offline.
    if (previous && at - previous.end_at <= 45000) {
      this.db
        .prepare(
          "UPDATE camera_availability SET end_at=? WHERE camera_id=? AND start_at=?",
        )
        .run(at, cameraId, previous.start_at);
      if (previous.state === state) return;
    }
    this.db
      .prepare(
        "INSERT INTO camera_availability(camera_id,start_at,end_at,state) VALUES(?,?,?,?) ON CONFLICT(camera_id,start_at) DO UPDATE SET state=excluded.state,end_at=excluded.end_at",
      )
      .run(cameraId, at, at, state);
  }
  availability({ cameraId, from = 0, to = Date.now() } = {}) {
    const args = [from, to];
    const where = cameraId ? " AND camera_id=?" : "";
    if (cameraId) args.push(cameraId);
    return this.db
      .prepare(
        `SELECT * FROM camera_availability WHERE end_at>=? AND start_at<=?${where} ORDER BY start_at DESC LIMIT 5000`,
      )
      .all(...args)
      .reverse()
      .map((row) => ({
        cameraId: row.camera_id,
        startAt: Math.max(from, row.start_at),
        endAt: Math.min(to, row.end_at),
        state: row.state,
      }));
  }
  create(cameraId, kind, at, endAt, sensorId) {
    const id = randomUUID();
    const detections = [{ kind, at, sensorId }];
    this.db
      .prepare(
        "INSERT INTO events(id,camera_id,start_at,end_at,status,kinds,detections) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        cameraId,
        at,
        endAt,
        "recording",
        JSON.stringify([kind]),
        JSON.stringify(detections),
      );
    return this.get(id);
  }
  adoptActivity(event) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO events(id,camera_id,start_at,end_at,status,kinds,detections,local_original,local_playback)VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        event.id,
        event.cameraId,
        event.startAt,
        event.endAt,
        "recording",
        JSON.stringify(event.kinds),
        JSON.stringify([
          {
            kind: event.kinds[0],
            at: event.startAt,
            sensorId: "haus_activity_assist",
          },
        ]),
        0,
        0,
      );
    return this.get(event.id);
  }
  extend(id, kind, at, endAt, sensorId, maxEndAt = Infinity) {
    const old = this.get(id);
    if (!old || old.status !== "recording") return;
    const detections = [...old.detections, { kind, at, sensorId }].slice(-500);
    const kinds = [...new Set([...old.kinds, kind])];
    this.db
      .prepare(
        "UPDATE events SET start_at=?,end_at=?,kinds=?,detections=? WHERE id=?",
      )
      .run(
        Math.min(old.startAt, at),
        Math.min(maxEndAt, Math.max(old.endAt, endAt)),
        JSON.stringify(kinds),
        JSON.stringify(detections),
        id,
      );
    return this.get(id);
  }
  extendTail(id, endAt) {
    this.db
      .prepare(
        "UPDATE events SET end_at=max(end_at,?) WHERE id=? AND status='recording'",
      )
      .run(endAt, id);
    return this.get(id);
  }
  finish(
    id,
    {
      status = "ready",
      duration = 0,
      bytes = 0,
      error = null,
      playbackVersion = 0,
      mediaStartAt = null,
    } = {},
  ) {
    this.clearArchive(id);
    this.db
      .prepare(
        "UPDATE events SET status=?,duration=?,bytes=?,error=?,playback_version=?,media_start_at=coalesce(?,media_start_at),local_original=1,media_revision=media_revision+1 WHERE id=?",
      )
      .run(status, duration, bytes, error, playbackVersion, mediaStartAt, id);
    return this.get(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    return row && this.present(row);
  }
  setPlayback(id, bytes, version = 1, diagnostics = {}) {
    this.clearArchive(id, "prepared");
    this.db
      .prepare(
        "UPDATE events SET playback_version=?,playback_bytes=?,playback_info=?,local_playback=1,media_revision=media_revision+1 WHERE id=?",
      )
      .run(version, bytes, JSON.stringify(diagnostics), id);
  }
  clearArchive(id, variant) {
    const where = variant ? " AND variant=?" : "";
    const args = variant ? [id, variant] : [id];
    const descriptors = this.db
      .prepare(`DELETE FROM event_archive WHERE event_id=?${where}`)
      .run(...args);
    const locations = this.db
      .prepare(`DELETE FROM event_archive_locations WHERE event_id=?${where}`)
      .run(...args);
    if (descriptors.changes || locations.changes) this.markArchiveChanged();
    // A compatibility repair can replace prepared bytes without changing their
    // policy version. Never issue a direct node grant for the previous digest.
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cluster_media'",
        )
        .get()
    )
      this.db.prepare("DELETE FROM cluster_media WHERE event_id=?").run(id);
  }
  archiveGeneration() {
    return this.db
      .prepare("SELECT generation FROM event_archive_state WHERE id=1")
      .get().generation;
  }
  markArchiveChanged() {
    this.db.exec(
      "UPDATE event_archive_state SET generation=generation+1 WHERE id=1",
    );
  }
  present(row) {
    const playbackInfo = row.playback_info
      ? JSON.parse(row.playback_info)
      : undefined;
    const duration =
      Number.isFinite(playbackInfo?.duration) && playbackInfo.duration > 0
        ? playbackInfo.duration
        : row.duration;
    return {
      id: row.id,
      cameraId: row.camera_id,
      startAt: row.start_at,
      ...(row.media_start_at !== null
        ? { mediaStartAt: row.media_start_at }
        : {}),
      endAt: row.end_at,
      status: row.status,
      kinds: JSON.parse(row.kinds),
      detections: JSON.parse(row.detections),
      duration,
      ...(duration !== row.duration ? { originalDuration: row.duration } : {}),
      bytes: row.bytes,
      error: row.error,
      playbackVersion: row.playback_version,
      playbackBytes: row.playback_bytes,
      playbackInfo,
      mediaRevision: row.media_revision,
      localOriginal: Boolean(row.local_original),
      localPlayback: Boolean(row.local_playback),
      videoUrl:
        row.status === "ready" ? `api/events/${row.id}/video` : undefined,
      thumbnailUrl:
        row.status === "ready" ? `api/events/${row.id}/thumbnail` : undefined,
    };
  }
  list({
    cameraId,
    from = 0,
    to = Date.now() + 60000,
    cursor,
    limit = 60,
    kind,
    status,
    direction = "older",
  } = {}) {
    const args = [from, to];
    let where = "start_at >= ? AND start_at <= ?";
    if (cameraId) {
      where += " AND camera_id=?";
      args.push(cameraId);
    }
    if (status) {
      where += " AND status=?";
      args.push(status);
    }
    const order = direction === "newer" ? "ASC" : "DESC";
    if (cursor) {
      const [at, id] = decodeCursor(cursor);
      const operator = direction === "newer" ? ">" : "<";
      where += ` AND (start_at ${operator} ? OR (start_at = ? AND id ${operator} ?))`;
      args.push(at, at, id);
    }
    if (kind) {
      where +=
        " AND EXISTS (SELECT 1 FROM json_each(events.kinds) WHERE value=?)";
      args.push(kind);
    }
    args.push(Math.min(200, Math.max(1, limit)) + 1);
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE ${where} ORDER BY start_at ${order},id ${order} LIMIT ?`,
      )
      .all(...args);
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.present(row));
    const last = events.at(-1);
    const newest = direction === "newer" ? events.at(-1) : events[0];
    return {
      events: direction === "newer" ? events.reverse() : events,
      newestCursor: newest
        ? Buffer.from(JSON.stringify([newest.startAt, newest.id])).toString(
            "base64url",
          )
        : null,
      nextCursor:
        hasMore && last
          ? Buffer.from(JSON.stringify([last.startAt, last.id])).toString(
              "base64url",
            )
          : null,
    };
  }
  recordedDays({ cameraId, boundaries }) {
    const query = this.db.prepare(
      "SELECT 1 FROM events WHERE camera_id=? AND status='ready' AND start_at>=? AND start_at<? LIMIT 1",
    );
    return boundaries
      .slice(0, -1)
      .filter((start, index) =>
        query.get(cameraId, start, boundaries[index + 1]),
      );
  }
  recording() {
    return this.db
      .prepare("SELECT * FROM events WHERE status='recording'")
      .all()
      .map((row) => this.present(row));
  }
  totals() {
    const row = this.db
      .prepare(
        `WITH media AS (SELECT e.*,
        EXISTS(SELECT 1 FROM event_archive a JOIN event_archive_locations l USING(event_id,variant,digest,version) WHERE a.event_id=e.id AND a.variant='original') AS original_archived,
        EXISTS(SELECT 1 FROM event_archive a JOIN event_archive_locations l USING(event_id,variant,digest,version) WHERE a.event_id=e.id AND a.variant='prepared' AND a.version=e.playback_version) AS playback_archived
        FROM events e WHERE status='ready')
        SELECT count(*) AS count,coalesce(sum(bytes*local_original+playback_bytes*local_playback),0) AS bytes,
        coalesce(sum(bytes+playback_bytes),0) AS totalBytes,
        coalesce(sum(CASE WHEN local_original=0 AND original_archived THEN bytes ELSE 0 END +
        CASE WHEN local_playback=0 AND playback_archived THEN playback_bytes ELSE 0 END),0) AS archivedBytes,
        coalesce(sum(CASE WHEN local_original=1 OR (local_playback=1 AND playback_bytes>0) THEN 1 ELSE 0 END),0) AS localEvents,
        coalesce(sum(CASE WHEN local_original=0 AND original_archived AND (playback_bytes=0 OR (local_playback=0 AND playback_archived)) THEN 1 ELSE 0 END),0) AS archivedEvents
        FROM media`,
      )
      .get();
    return {
      ...row,
      unavailableBytes: Math.max(
        0,
        row.totalBytes - row.bytes - row.archivedBytes,
      ),
    };
  }
  async reconcileLocalMedia(probe = stat) {
    // A crash after unlink, or a restored catalog without media, must not count
    // absent files as local or prevent access to a verified remote archive.
    let cursor = "";
    while (true) {
      const rows = this.db
        .prepare(
          "SELECT id,local_original,local_playback,playback_bytes FROM events WHERE status='ready' AND id>? AND (local_original=1 OR (local_playback=1 AND playback_bytes>0)) ORDER BY id LIMIT 128",
        )
        .all(cursor);
      if (!rows.length) break;
      cursor = rows.at(-1).id;
      const probes = rows.flatMap((row) => [
        ...(row.local_original
          ? [{ id: row.id, variant: "original", extension: "mp4" }]
          : []),
        ...(row.local_playback && row.playback_bytes > 0
          ? [{ id: row.id, variant: "prepared", extension: "playback.mp4" }]
          : []),
      ]);
      let index = 0;
      const missing = [];
      await Promise.all(
        Array.from({ length: Math.min(4, probes.length) }, async () => {
          while (index < probes.length) {
            const item = probes[index++];
            try {
              await probe(this.path(item.id, item.extension));
            } catch (error) {
              if (error.code === "ENOENT") missing.push(item);
            }
          }
        }),
      );
      if (missing.length) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const item of missing)
            this.setLocal(item.id, item.variant, false);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  }
  /** Readers/writers pin a whole event; eviction and age retention take exclusivity. */
  async pinMedia(id, signal) {
    while (this.mediaEvictions.has(id)) {
      signal?.throwIfAborted();
      let onAbort;
      try {
        const done = this.mediaEvictions.get(id).done;
        await (signal
          ? Promise.race([
              done,
              new Promise((_, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener("abort", onAbort, { once: true });
              }),
            ])
          : done);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }
    signal?.throwIfAborted();
    this.mediaPins.set(id, (this.mediaPins.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.mediaPins.get(id) ?? 1) - 1;
      if (count) this.mediaPins.set(id, count);
      else this.mediaPins.delete(id);
    };
  }
  evictMedia(id) {
    if (this.mediaPins.has(id) || this.mediaEvictions.has(id)) return null;
    let resolve;
    const done = new Promise((complete) => {
      resolve = complete;
    });
    this.mediaEvictions.set(id, { done });
    return () => {
      this.mediaEvictions.delete(id);
      resolve();
    };
  }
  setLocal(id, variant, present) {
    if (!["original", "prepared"].includes(variant))
      throw new Error("invalid_archive_variant");
    this.db
      .prepare(
        `UPDATE events SET ${variant === "original" ? "local_original" : "local_playback"}=? WHERE id=?`,
      )
      .run(Number(present), id);
  }
  path(id, extension = "mp4") {
    if (
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ||
      !["mp4", "jpg", "playback.mp4"].includes(extension)
    )
      throw new Error("invalid_event_id");
    return join(this.media, `${id}.${extension}`);
  }
  async prune(options, now = Date.now()) {
    const cutoff = now - options.retention_days * 86400000;
    this.db
      .prepare("DELETE FROM camera_availability WHERE end_at<?")
      .run(cutoff);
    let removed = 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE status!='recording' ORDER BY start_at ASC,id ASC",
      )
      .all();
    for (const row of rows) {
      if (row.start_at >= cutoff) continue;
      const release = this.evictMedia(row.id);
      if (!release) continue;
      try {
        for (const ext of ["mp4", "jpg", "playback.mp4"])
          await unlink(this.path(row.id, ext)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        this.clearArchive(row.id);
        this.db.prepare("DELETE FROM events WHERE id=?").run(row.id);
        removed++;
      } catch {
        /* Keep metadata and retry later if storage is temporarily unavailable. */
      } finally {
        release();
      }
    }
    return removed;
  }
  close() {
    this.db.close();
  }
}
export function decodeCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      !Number.isFinite(parsed[0]) ||
      typeof parsed[1] !== "string" ||
      !/^[-a-f0-9]{36}$/.test(parsed[1])
    )
      throw new Error();
    return parsed;
  } catch {
    throw new Error("invalid_cursor");
  }
}
export async function prepareDirectories(config) {
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  await mkdir(config.media, { recursive: true, mode: 0o750 });
}
