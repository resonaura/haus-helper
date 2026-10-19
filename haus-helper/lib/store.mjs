import { DatabaseSync } from "node:sqlite";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export class Store {
  constructor(database, media) {
    this.db = new DatabaseSync(database);
    this.media = media;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, status TEXT NOT NULL, kinds TEXT NOT NULL, detections TEXT NOT NULL, duration REAL DEFAULT 0, bytes INTEGER DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS events_camera_time ON events(camera_id,start_at DESC,id DESC);
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
    this.db.exec("PRAGMA user_version=4");
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
  extend(id, kind, at, endAt, sensorId) {
    const old = this.get(id);
    if (!old || old.status !== "recording") return;
    const detections = [...old.detections, { kind, at, sensorId }].slice(-500);
    const kinds = [...new Set([...old.kinds, kind])];
    this.db
      .prepare("UPDATE events SET end_at=?,kinds=?,detections=? WHERE id=?")
      .run(
        Math.max(old.endAt, endAt),
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
    } = {},
  ) {
    this.db
      .prepare(
        "UPDATE events SET status=?,duration=?,bytes=?,error=?,playback_version=? WHERE id=?",
      )
      .run(status, duration, bytes, error, playbackVersion, id);
    return this.get(id);
  }
  get(id) {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    return row && this.present(row);
  }
  setPlayback(id, bytes, version = 1, diagnostics = {}) {
    this.db
      .prepare(
        "UPDATE events SET playback_version=?,playback_bytes=?,playback_info=? WHERE id=?",
      )
      .run(version, bytes, JSON.stringify(diagnostics), id);
  }
  present(row) {
    return {
      id: row.id,
      cameraId: row.camera_id,
      startAt: row.start_at,
      endAt: row.end_at,
      status: row.status,
      kinds: JSON.parse(row.kinds),
      detections: JSON.parse(row.detections),
      duration: row.duration,
      bytes: row.bytes,
      error: row.error,
      playbackVersion: row.playback_version,
      playbackBytes: row.playback_bytes,
      playbackInfo: row.playback_info
        ? JSON.parse(row.playback_info)
        : undefined,
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
    direction = "older",
  } = {}) {
    const args = [from, to];
    let where = "start_at >= ? AND start_at <= ?";
    if (cameraId) {
      where += " AND camera_id=?";
      args.push(cameraId);
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
        "SELECT count(*) AS count,coalesce(sum(bytes+playback_bytes),0) AS bytes FROM events WHERE status='ready'",
      )
      .get();
    return { count: row.count, bytes: row.bytes };
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
    const max = options.max_storage_gb * 1024 ** 3;
    let bytes = this.totals().bytes;
    let removed = 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE status!='recording' ORDER BY start_at ASC,id ASC",
      )
      .all();
    for (const row of rows) {
      if (row.start_at >= cutoff && bytes <= max) continue;
      try {
        for (const ext of ["mp4", "jpg", "playback.mp4"])
          await unlink(this.path(row.id, ext)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        this.db.prepare("DELETE FROM events WHERE id=?").run(row.id);
        bytes -= row.bytes + row.playback_bytes;
        removed++;
      } catch {
        /* Keep metadata and retry later if storage is temporarily unavailable. */
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
