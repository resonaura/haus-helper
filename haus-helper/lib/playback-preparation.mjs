import { PLAYBACK_VERSION } from "./playback.mjs";

/** Short HTTP polls survive ingress timeouts without duplicating an encoder. */
export class PlaybackPreparation {
  constructor(recorder, { now = Date.now, limit = 64 } = {}) {
    this.recorder = recorder;
    this.now = now;
    this.limit = limit;
    this.jobs = new Map();
  }
  status(event, priority) {
    if (event.playbackVersion === PLAYBACK_VERSION) {
      this.jobs.delete(event.id);
      return "ready";
    }
    let job = this.jobs.get(event.id);
    if (job?.state === "failed" && this.now() - job.finishedAt >= 5000) {
      this.jobs.delete(event.id);
      job = undefined;
    }
    if (job) {
      if (job.state === "preparing" && priority > job.priority) {
        job.priority = priority;
        // Recorder coalesces this request and promotes its existing queue item.
        void this.recorder.preparePlayback(event, priority).catch(() => {});
      }
      return job.state;
    }
    for (const [id, existing] of this.jobs) {
      if (this.jobs.size < this.limit) break;
      if (existing.state !== "preparing") this.jobs.delete(id);
    }
    if (this.jobs.size >= this.limit) return "busy";
    job = { state: "preparing", priority };
    this.jobs.set(event.id, job);
    void Promise.resolve()
      .then(() => this.recorder.preparePlayback(event, priority))
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
