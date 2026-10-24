import { ORIGINAL_POLICY_VERSION } from "./playback-compatible.mjs";
import { playbackReady, PLAYBACK_VERSION } from "./playback.mjs";

const pending = `e.status='ready' AND e.local_original=1 AND
  (e.playback_version!=? OR (coalesce(e.playback_bytes,0)=0 AND
   json_extract(e.playback_info,'$.originalCompatible')=1 AND
   coalesce(json_extract(e.playback_info,'$.originalPolicyVersion'),0)!=?))`;

/** Drain a bounded page of pending recordings on idle NVRs, never on HA fallback. */
export class RecentPlayback {
  constructor(store, recorder, cluster, now = () => Date.now()) {
    Object.assign(this, { store, recorder, cluster, now });
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS background_preparation_attempts(event_id TEXT PRIMARY KEY,next_at INTEGER NOT NULL)",
    );
    this.rows = store.db.prepare(`SELECT e.id FROM events e
      LEFT JOIN background_preparation_attempts a ON a.event_id=e.id
      WHERE ${pending} AND coalesce(a.next_at,0)<=?
      ORDER BY coalesce(a.next_at,0),e.start_at DESC,e.id DESC LIMIT 64`);
    this.defer = store.db.prepare(
      "INSERT INTO background_preparation_attempts(event_id,next_at)VALUES(?,?) ON CONFLICT(event_id)DO UPDATE SET next_at=excluded.next_at",
    );
    this.clear = store.db.prepare(
      "DELETE FROM background_preparation_attempts WHERE event_id=?",
    );
    this.prune = store.db.prepare(`DELETE FROM background_preparation_attempts
      WHERE NOT EXISTS(SELECT 1 FROM events e WHERE e.id=background_preparation_attempts.event_id AND ${pending})`);
  }
  async tick() {
    if (
      this.busy ||
      this.recorder.stopped ||
      this.recorder.playbackJobs.size ||
      this.recorder.encoding.activeWork ||
      this.recorder.encoding.pending.length
    )
      return;
    this.prune.run(PLAYBACK_VERSION, ORIGINAL_POLICY_VERSION);
    const rows = this.rows.all(
      PLAYBACK_VERSION,
      ORIGINAL_POLICY_VERSION,
      this.now(),
    );
    for (const { id } of rows) {
      const event = this.store.get(id);
      const camera = this.recorder.cameras?.find(
        (item) => item.id === event.cameraId,
      );
      if (
        !camera?.enabled ||
        event.localOriginal === false ||
        playbackReady(event) ||
        !this.cluster.canPreparePlayback(event)
      ) {
        // A disabled or not-yet-replicated page must not hide older footage.
        this.defer.run(id, this.now() + 15000);
        continue;
      }
      this.defer.run(id, this.now() + 60000);
      this.busy = true;
      try {
        await this.recorder.preparePlayback(event, -10, { remoteOnly: true });
      } catch {
        // Foreground playback retains its normal fallback and retry policy.
      } finally {
        this.busy = false;
        if (playbackReady(this.store.get(id) ?? {})) this.clear.run(id);
      }
      return;
    }
  }
}
