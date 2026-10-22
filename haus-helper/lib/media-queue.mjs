/** One encoder on the helper; completed recordings take priority over speculative playback work. */
export class MediaQueue {
  constructor(limit = 12) {
    this.limit = limit;
    this.pending = [];
    this.active = false;
    this.stopped = false;
  }
  run(work, priority = 0, key) {
    if (this.stopped) return Promise.reject(new Error("media_stopped"));
    if (this.pending.length >= this.limit)
      return Promise.reject(new Error("media_queue_busy"));
    return new Promise((resolve, reject) => {
      this.pending.push({ work, priority, key, resolve, reject });
      this.pending.sort((a, b) => b.priority - a.priority);
      this.next();
    });
  }
  promote(key, priority) {
    for (const item of this.pending)
      if (item.key === key) item.priority = Math.max(item.priority, priority);
    this.pending.sort((a, b) => b.priority - a.priority);
  }
  async next() {
    if (this.active || this.stopped) return;
    const item = this.pending.shift();
    if (!item) return;
    this.active = true;
    this.activeWork = { priority: item.priority, startedAt: Date.now() };
    try {
      item.resolve(await item.work());
    } catch (error) {
      item.reject(error);
    } finally {
      this.active = false;
      this.activeWork = undefined;
      void this.next();
    }
  }
  stop() {
    this.stopped = true;
    for (const item of this.pending) item.reject(new Error("media_stopped"));
    this.pending = [];
  }
}
