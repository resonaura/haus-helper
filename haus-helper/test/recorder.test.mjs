import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.mjs";
import { Recorder } from "../lib/recorder.mjs";
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
