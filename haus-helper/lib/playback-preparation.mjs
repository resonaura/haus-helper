import { playbackReady } from "./playback.mjs";

/** Short HTTP polls survive ingress timeouts without duplicating an encoder. */
export class PlaybackPreparation {
  constructor(recorder, { now = Date.now, limit = 64 } = {}) {
    this.recorder = recorder;
    this.now = now;
    this.limit = limit;
    this.jobs = new Map();
  }
  status(event, priority, options = {}) {
    const key = event.id + (options.forceCompatibility ? ":repair" : "");
    const repair = this.jobs.get(event.id + ":repair");
    if (!options.forceCompatibility && repair?.state === "preparing")
      return "preparing";
    if (
      playbackReady(event) &&
      (!options.forceCompatibility ||
        event.playbackInfo?.compatibilityRepaired === true)
    ) {
      this.jobs.delete(key);
      return "ready";
    }
    let job = this.jobs.get(key);
    if (job?.state === "failed" && this.now() - job.finishedAt >= 5000) {
      this.jobs.delete(key);
      job = undefined;
    }
    if (job) {
      if (job.state === "preparing" && priority > job.priority) {
        job.priority = priority;
        // Recorder coalesces this request and promotes its existing queue item.
        void this.recorder
          .preparePlayback(event, priority, options)
          .catch(() => {});
      }
      return job.state;
    }
    for (const [id, existing] of this.jobs) {
      if (this.jobs.size < this.limit) break;
      if (existing.state !== "preparing") this.jobs.delete(id);
    }
    if (this.jobs.size >= this.limit) return "busy";
    job = { state: "preparing", priority };
    this.jobs.set(key, job);
    void Promise.resolve()
      .then(() => this.recorder.preparePlayback(event, priority, options))
      .then(
        () => {
          job.state = "ready";
          job.finishedAt = this.now();
        },
        (error) => {
          job.state = "failed";
          job.finishedAt = this.now();
          console.warn("[media] Playback preparation failed", {
            eventId: event.id,
            code: /^media_process_(?:\d+|null)$/.test(String(error?.message))
              ? error.message
              : "processing_failed",
          });
        },
      );
    return job.state;
  }
  clear() {
    this.jobs.clear();
  }
}
