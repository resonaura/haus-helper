import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  stat,
  readFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Recorder, parseSegments } from "../lib/recorder.mjs";
import { runMedia } from "../lib/media.mjs";
import { defaults } from "../lib/config.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-recorder-"));
  const media = join(root, "media");
  const dir = join(root, "buffer");
  await mkdir(media);
  await mkdir(dir);
  const store = new Store(join(root, "db.sqlite"), media);
  const config = { ...defaults, data: root, media };
  const recorder = new Recorder(config, {}, store);
  recorder.cameras = [
    { id: "camera.test", available: true, enabled: true, sensors: [] },
  ];
  t.after(async () => {
    await recorder.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, media, dir, store, config, recorder };
}
test("extends motion for a new object without losing previous labels and caps event duration", async (t) => {
  const { recorder, store } = await fixture(t);
  const first = recorder.trigger("camera.test", "motion", undefined, 1000);
  const again = recorder.trigger(
    "camera.test",
    "pet",
    "binary_sensor.pet",
    2000,
  );
  assert.equal(first.id, again.id);
  assert.deepEqual(again.kinds, ["motion", "pet"]);
  recorder.trigger("camera.test", "person", undefined, 300000);
  assert.equal(store.get(first.id).endAt, 301000);
  assert.throws(() => recorder.trigger("camera.unknown"), /recording_disabled/);
});
test(
  "finalizes a real H264 buffer into a seekable local MP4 and thumbnail",
  { timeout: 30000 },
  async (t) => {
    const { dir, store, recorder } = await fixture(t);
    const at = Date.UTC(2026, 9, 17, 12);
    const name = "20261017T120000.mp4";
    await runMedia(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=gray:s=160x90:r=10",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(dir, name),
      ],
      { timeout: 10000 },
    );
    await writeFile(join(dir, "index.csv"), `${name},0,3\n`);
    recorder.buffers.set("camera.test", { dir, stopped: true });
    const event = recorder.trigger(
      "camera.test",
      "motion",
      undefined,
      at + 1000,
    );
    await recorder.finish(event);
    const result = store.get(event.id);
    assert.equal(result.status, "ready");
    assert.ok(result.duration >= 2.9);
    assert.ok(result.bytes > 1000);
    assert.ok((await stat(store.path(event.id, "jpg"))).size > 0);
  },
);
test("a missing camera buffer records an honest failure rather than an empty playable clip", async (t) => {
  const { recorder, store } = await fixture(t);
  const event = recorder.trigger("camera.test");
  await recorder.finish(event);
  assert.equal(store.get(event.id).status, "failed");
  assert.equal(store.get(event.id).videoUrl, undefined);
});

test("held motion extends the tail without inventing detections and rotates at the clip limit", async (t) => {
  const { recorder, store } = await fixture(t);
  const now = Date.now();
  recorder.cameras[0].sensors = [
    { id: "binary_sensor.motion", kind: "motion", active: true },
  ];
  const first = recorder.trigger(
    "camera.test",
    "motion",
    "binary_sensor.motion",
    now - 10000,
  );
  await recorder.tick();
  assert.equal(store.get(first.id).detections.length, 1);
  assert.ok(store.get(first.id).endAt >= now + 19000);
  const old = store.create(
    "camera.test",
    "motion",
    now - 310000,
    now - 10000,
    "binary_sensor.motion",
  );
  recorder.active.set("camera.test", old);
  await recorder.tick();
  assert.notEqual(recorder.active.get("camera.test").id, old.id);
  assert.ok(store.recording().some((event) => event.id !== old.id));
});

test(
  "starts an authenticated HLS camera and writes playable pre-roll segments",
  { timeout: 30000 },
  async (t) => {
    const { root, dir, recorder, config } = await fixture(t);
    const source = join(root, "source");
    await mkdir(source);
    await runMedia("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=10",
      "-t",
      "5",
      "-c:v",
      "libx264",
      "-g",
      "10",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      join(source, "index.m3u8"),
    ]);
    let authorized = 0;
    const server = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer test-only") {
        res.writeHead(401).end();
        return;
      }
      authorized++;
      const name = req.url?.slice(1);
      if (!/^(index.m3u8|index\d+.ts)$/.test(name)) {
        res.writeHead(404).end();
        return;
      }
      try {
        res.end(await readFile(join(source, name)));
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    config.token = "test-only";
    recorder.ha = {
      stream: async () =>
        `http://127.0.0.1:${server.address().port}/index.m3u8`,
    };
    const buffer = { id: "camera.test", dir, stopped: false };
    recorder.buffers.set(buffer.id, buffer);
    await recorder.startBuffer(buffer);
    assert.notEqual(buffer.status, "unavailable", buffer.lastError);
    for (
      let attempt = 0;
      attempt < 100 && !(await recorder.segments(buffer)).length;
      attempt++
    )
      await pause(50);
    if (buffer.process) await once(buffer.process, "close");
    const segments = await recorder.segments(buffer);
    assert.equal(
      new Set(segments.map((part) => part.path)).size,
      segments.length,
      "HLS batches never overwrite another pre-roll segment",
    );
    assert.ok(
      segments.reduce((sum, part) => sum + part.end - part.start, 0) >= 4900,
    );
    assert.ok(
      authorized > 1,
      "both playlist and segments carry authentication",
    );
    assert.ok(
      segments.length > 0,
      "camera produces finalized pre-roll segments",
    );
    assert.ok((await stat(segments.at(-1).path)).size > 0);
  },
);

test("batched segments have unique sequence identities and duplicate paths are never replayed", () => {
  const prefix = "b1792298711085-a1b2c3d4";
  const parts = parseSegments(
    `${prefix}-000000000.mp4,0,2\n${prefix}-000000001.mp4,2,4\n${prefix}-000000002.mp4,4,6\n${prefix}-000000002.mp4,4,6`,
    "/buffer",
  );
  assert.equal(parts.length, 3);
  assert.equal(new Set(parts.map((part) => part.path)).size, 3);
  assert.equal(parts[0].end, parts[1].start);
  assert.equal(parts[2].end - parts[0].start, 6000);
  assert.equal(
    parseSegments("20261017T120000.mp4,0,2\n20261017T120000.mp4,2,4", "/buffer")
      .length,
    1,
  );
});

test(
  "prepares one hardware-compatible legacy copy and preserves the original",
  { timeout: 30000 },
  async (t) => {
    const { store, recorder } = await fixture(t);
    const event = store.create(
      "camera.test",
      "manual",
      Date.now(),
      Date.now() + 2000,
    );
    await runMedia("ffmpeg", [
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=10",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      store.path(event.id),
    ]);
    const before = await readFile(store.path(event.id));
    store.finish(event.id, { duration: 2, bytes: before.length });
    const legacy = store.get(event.id);
    const paths = await Promise.all([
      recorder.preparePlayback(legacy),
      recorder.preparePlayback(legacy),
    ]);
    assert.equal(paths[0], paths[1]);
    assert.notEqual(paths[0], store.path(event.id));
    assert.deepEqual(await readFile(store.path(event.id)), before);
    assert.ok(store.get(event.id).playbackBytes > 0);
    assert.equal(
      store.totals().bytes,
      before.length + (await stat(paths[0])).size,
    );
    assert.equal(await recorder.preparePlayback(store.get(event.id)), paths[0]);
    await runMedia("ffmpeg", [
      "-v",
      "error",
      "-xerror",
      "-i",
      paths[0],
      "-f",
      "null",
      "-",
    ]);
    await store.prune({ retention_days: 7, max_storage_gb: 0 });
    assert.equal(store.get(event.id), undefined);
    await assert.rejects(stat(paths[0]), { code: "ENOENT" });
  },
);

test(
  "a stalled recorder is terminated, then forcibly reaped if it ignores shutdown",
  { timeout: 8000 },
  async (t) => {
    const { recorder, dir } = await fixture(t);
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter();
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        child.exitCode = 137;
        child.emit("close");
      }
    };
    child.exitCode = null;
    recorder.buffers.set("camera.test", {
      dir,
      process: child,
      lastAdvance: Date.now() - 31000,
      status: "buffering",
    });
    await recorder.tick();
    assert.deepEqual(signals, ["SIGTERM"]);
    await pause(3100);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  },
);
