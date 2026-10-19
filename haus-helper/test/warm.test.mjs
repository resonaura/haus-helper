import { test } from "node:test";
import assert from "node:assert/strict";
import { WarmStreams, rewritePlaylist } from "../lib/warm-streams.mjs";
test("warm sessions share a source, obey capacity and expire after idle; batteries release immediately", async () => {
  let now = 1000,
    calls = 0,
    probes = 0;
  const warm = new WarmStreams(
    {
      stream: async (id) => {
        calls++;
        return `http://ha/api/hls/${id.split(".")[1]}/master.m3u8`;
      },
      media: async () => {
        probes++;
        return new Response("#EXTM3U");
      },
    },
    { buffers: new Map() },
    undefined,
    { limit: 2, idleMs: 45000, now: () => now },
  );
  const camera = { id: "camera.test" };
  await warm.touch(camera, "one", true);
  await warm.touch(camera, "two", true);
  assert.equal(calls, 1);
  await warm.touch({ id: "camera.second" }, "three", true);
  assert.equal(
    (await warm.touch({ id: "camera.third" }, "four", true)).reason,
    "capacity",
  );
  await warm.touch(camera, "one", false);
  await warm.touch(camera, "two", false);
  await warm.tick();
  assert.ok(probes > 0);
  now += 45001;
  await warm.tick();
  assert.ok(!warm.entries.has(camera.id));
  await warm.touch({ id: "camera.battery", batteryPowered: true }, "one", true);
  await warm.touch(
    { id: "camera.battery", batteryPowered: true },
    "one",
    false,
  );
  await warm.tick();
  assert.ok(!warm.entries.has("camera.battery"));
  await warm.stop();
  assert.equal(warm.entries.size, 0);
});
test("source capabilities cannot escape their exact camera HLS prefix", async () => {
  const warm = new WarmStreams(
    { media: async () => new Response("test") },
    { buffers: new Map() },
  );
  const entry = {
    source: "http://ha/api/hls/camera-one/master.m3u8",
    expires: Date.now() + 60000,
  };
  warm.leases.set("secret", entry);
  await assert.rejects(() => warm.source("secret", "/api/config"));
  await assert.rejects(() =>
    warm.source("secret", "http://external/api/hls/camera-one/segment.ts"),
  );
  assert.equal(
    (
      await warm.source(
        "secret",
        warm.resource(entry, "/api/hls/camera-one/segment.ts"),
      )
    ).response.status,
    200,
  );
  assert.throws(() =>
    warm.resource(entry, "http://external/api/hls/camera-one/segment.ts"),
  );
  await warm.stop();
});
test("manifest rewriting handles relative segments and quoted URI attributes", () => {
  const rewritten = rewritePlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment.ts\n',
    "http://ha/api/hls/id/playlist.m3u8",
    (value) =>
      "/proxy/" + Buffer.from(new URL(value).pathname).toString("base64url"),
  );
  assert.ok(!rewritten.includes("http://ha"));
  assert.ok(rewritten.includes('URI="/proxy/'));
  assert.ok(!rewritten.includes("\nsegment.ts"));
});
test("privacy/offline camera transitions revoke warm sources without waiting for idle expiry", async () => {
  const warm = new WarmStreams(
    { stream: async () => "http://ha/api/hls/camera-one/master.m3u8" },
    { buffers: new Map() },
  );
  await warm.touch({ id: "camera.one", available: true }, "client", true);
  warm.sync([{ id: "camera.one", available: false }]);
  assert.equal(warm.entries.size, 0);
  assert.equal(
    (await warm.touch({ id: "camera.one", available: false }, "client", true))
      .warm,
    false,
  );
  await warm.stop();
});

test("simultaneous opens cannot claim the same idle warming slot", async () => {
  const warm = new WarmStreams(
    { stream: async () => "http://ha/api/hls/test/master.m3u8" },
    { buffers: new Map() },
    undefined,
    { limit: 1 },
  );
  await warm.touch({ id: "camera.old" }, "old", true);
  await warm.touch({ id: "camera.old" }, "old", false);
  const results = await Promise.all([
    warm.touch({ id: "camera.one" }, "one", true),
    warm.touch({ id: "camera.two" }, "two", true),
    warm.touch({ id: "camera.three" }, "three", true),
  ]);
  assert.equal(results.filter((result) => result.warm).length, 1);
  assert.equal(warm.entries.size, 1);
  await warm.stop();
  assert.equal(
    (await warm.touch({ id: "camera.late" }, "late", true)).warm,
    false,
  );
  assert.equal(warm.entries.size, 0);
});

test("dashboard preheat never wakes batteries and reuses a healthy recording buffer", async () => {
  let calls = 0;
  const warm = new WarmStreams(
    {
      stream: async () => {
        calls++;
        return "http://ha/api/hls/test/master.m3u8";
      },
    },
    { buffers: new Map([["camera.recording", { status: "buffering" }]]) },
  );
  assert.equal(
    (
      await warm.touch(
        { id: "camera.battery", batteryPowered: true },
        "preview",
        true,
        true,
      )
    ).reason,
    "battery",
  );
  assert.equal(
    (await warm.touch({ id: "camera.recording" }, "preview", true, true))
      .source,
    "recording",
  );
  assert.equal(calls, 0);
  await warm.stop();
});
test("failed manifest keepalives reacquire the source and overlapping ticks do not duplicate requests", async () => {
  let calls = 0;
  const warm = new WarmStreams(
    {
      stream: async () => `http://ha/api/hls/test/${++calls}.m3u8`,
      media: async () => new Response(null, { status: 503 }),
    },
    { buffers: new Map() },
  );
  await warm.touch({ id: "camera.test" }, "one", true);
  await Promise.all([warm.tick(), warm.tick()]);
  assert.equal(calls, 1);
  await warm.tick();
  await warm.tick();
  assert.equal(calls, 2);
  assert.match(warm.entries.get("camera.test").source, /2.m3u8/);
  await warm.stop();
});
