import { PLAYBACK_VERSION } from "./playback.mjs";

/** Prepare a small recent working set on idle capable NVRs, never on HA fallback. */
export class RecentPlayback {
  constructor(store, recorder, cluster, now = () => Date.now()) {
    Object.assign(this, { store, recorder, cluster, now });
    this.attempts = new Map();
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
    const rows = this.store.db
      .prepare(
        "SELECT id FROM events WHERE status='ready' ORDER BY start_at DESC LIMIT 64",
      )
      .all();
    const current = new Set(rows.map(({ id }) => id));
    for (const id of this.attempts.keys())
      if (!current.has(id)) this.attempts.delete(id);
    const cameras = new Map();
    for (const { id } of rows) {
      const event = this.store.get(id);
      const count = cameras.get(event.cameraId) ?? 0;
      if (count >= 2) continue;
      cameras.set(event.cameraId, count + 1);
      const camera = this.recorder.cameras?.find(
        (item) => item.id === event.cameraId,
      );
      if (
        !camera?.enabled ||
        !camera.available ||
        event.playbackVersion === PLAYBACK_VERSION ||
        this.now() - (this.attempts.get(id) ?? -Infinity) < 60_000 ||
        !this.cluster.canPreparePlayback(event)
      )
        continue;
      this.busy = true;
      this.attempts.set(id, this.now());
      try {
        await this.recorder.preparePlayback(event, -10, { remoteOnly: true });
      } catch {
        // Foreground playback retains its normal fallback and retry policy.
      } finally {
        this.busy = false;
      }
      return;
    }
  }
}
