import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
  PrimarySourceRecovery,
  probePrimarySource,
} from "../lib/primary-source-recovery.mjs";
import { runMedia } from "../lib/media.mjs";

test("a working fallback stays alive during cooldown, failed probes and active events", async () => {
  let now = 0,
    enabled = true,
    attempts = 0,
    promoted = 0;
  const recovery = new PrimarySourceRecovery({
    now: () => now,
    retryMs: 100,
    probe: async () => {
      attempts++;
      if (attempts === 1) throw Error("unavailable");
    },
  });
  const buffer = {};
  const options = {
    eligible: () => enabled,
    find: async () => ({ kind: "rtsp" }),
    promote: () => promoted++,
  };
  recovery.consider(buffer, options);
  now = 99;
  recovery.consider(buffer, options);
  assert.equal(attempts, 0);
  now = 100;
  await recovery.consider(buffer, options);
  assert.equal(attempts, 1);
  assert.equal(promoted, 0);
  now = 199;
  recovery.consider(buffer, options);
  assert.equal(attempts, 1);
  enabled = false;
  now = 200;
  recovery.consider(buffer, options);
  assert.equal(attempts, 1);
  enabled = true;
  await recovery.consider(buffer, options);
  assert.equal(promoted, 1);
  await recovery.stop();
});

test("one in-flight probe is shared across ticks and cannot promote a disabled or recording camera", async () => {
  for (const cancel of [false, true]) {
    let finish,
      promoted = 0,
      enabled = true,
      attempts = 0;
    const recovery = new PrimarySourceRecovery({
      retryMs: 0,
      probe: async () => {
        attempts++;
        await new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const buffer = {},
      other = {};
    const options = {
      eligible: () => enabled,
      find: async () => ({ kind: "rtsp" }),
      promote: () => promoted++,
    };
    const work = recovery.consider(buffer, options);
    await Promise.resolve();
    recovery.consider(buffer, options);
    recovery.consider(other, options);
    assert.equal(attempts, 1);
    if (cancel) recovery.cancel(buffer);
    else enabled = false;
    finish();
    await work;
    assert.equal(promoted, 0);
    assert.equal(recovery.active.size, 0);
    await recovery.stop();
  }
});

test("shutdown cancels a probe before releasing its slot and no-RTSP discovery never interrupts HA", async () => {
  let promoted = 0,
    stopped = false;
  const recovery = new PrimarySourceRecovery({
    retryMs: 0,
    probe: (_, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(Error("aborted"));
          },
          { once: true },
        );
      }),
  });
  const options = {
    eligible: () => true,
    find: async () => ({ kind: "ha" }),
    promote: () => promoted++,
  };
  await recovery.consider({}, options);
  assert.equal(recovery.active.size, 0);
  const work = recovery.consider(
    {},
    { ...options, find: async () => ({ kind: "rtsp" }) },
  );
  await Promise.resolve();
  await recovery.stop();
  await work;
  assert.equal(stopped, true);
  assert.equal(promoted, 0);
  assert.equal(recovery.active.size, 0);
  recovery.consider({}, options);
  assert.equal(recovery.active.size, 0);
});

test(
  "the real probe requires a decoded frame and cancels a stalled RTSP peer",
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "haus-primary-source-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = join(root, "picture.mp4");
    await runMedia("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10",
      "-t",
      "0.2",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      input,
    ]);
    await probePrimarySource({ url: input }, new AbortController().signal);
    const invalid = join(root, "empty.mp4");
    await writeFile(invalid, "not video");
    await assert.rejects(
      () => probePrimarySource({ url: invalid }, new AbortController().signal),
      /primary_source_unavailable/,
    );
    const abort = new AbortController();
    let reached = false;
    const clients = new Set();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
      socket.once("data", (bytes) => {
        reached = bytes.toString().includes("RTSP/1.0");
        abort.abort();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const client of clients) client.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    const began = performance.now();
    await assert.rejects(() =>
      probePrimarySource(
        {
          url: `rtsp://127.0.0.1:${server.address().port}/fixture`,
          inputArguments: ["-rtsp_transport", "tcp"],
        },
        abort.signal,
      ),
    );
    assert.equal(reached, true);
    assert.ok(
      performance.now() - began < 5000,
      "cancellation reaps the encoder instead of waiting for the socket timeout",
    );
  },
);
