import { spawn } from "node:child_process";

/** Prove that the primary source supplies a decoded picture before leaving HA. */
export function probePrimarySource(input, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        /^rtsps?:/.test(input.url) ? "-timeout" : "-rw_timeout",
        "8000000",
        ...(input.inputArguments || []),
        "-threads",
        "1",
        "-i",
        input.url,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-progress",
        "pipe:1",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let frame = false,
      failed = false,
      progress = "";
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, 15000);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk) => {
      progress = (progress + chunk).slice(-4096);
      if (/(?:^|\n)frame=\s*[1-9]\d*(?:\n|$)/.test(progress)) frame = true;
    });
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0 && frame && !failed) resolve();
      else reject(new Error("primary_source_unavailable"));
    });
  });
}

/** Probe at most one fallback in the background, never interrupt an active event. */
export class PrimarySourceRecovery {
  constructor({
    now = () => performance.now(),
    probe = probePrimarySource,
    retryMs = 300000,
  } = {}) {
    this.now = now;
    this.probe = probe;
    this.retryMs = retryMs;
    this.next = new WeakMap();
    this.active = new Map();
  }
  consider(buffer, { eligible, find, promote }) {
    if (this.stopped) return;
    if (!eligible()) {
      this.active.get(buffer)?.abort.abort();
      return;
    }
    if (!this.next.has(buffer))
      this.next.set(buffer, this.now() + this.retryMs);
    if (this.active.size || this.now() < this.next.get(buffer)) return;
    this.next.set(buffer, this.now() + this.retryMs);
    const entry = { abort: new AbortController() };
    this.active.set(buffer, entry);
    entry.pending = (async () => {
      try {
        const input = await find();
        entry.abort.signal.throwIfAborted();
        if (input?.kind !== "rtsp") return;
        await this.probe(input, entry.abort.signal);
        entry.abort.signal.throwIfAborted();
        if (!this.stopped && eligible()) promote();
      } catch {
        // A working fallback remains untouched; retry later without URL logs.
      } finally {
        this.active.delete(buffer);
      }
    })();
    return entry.pending;
  }
  cancel(buffer) {
    this.active.get(buffer)?.abort.abort();
  }
  async stop() {
    this.stopped = true;
    for (const entry of this.active.values()) entry.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.pending),
    );
  }
}
