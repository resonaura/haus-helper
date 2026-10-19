import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../lib/server.mjs";
import { WarmStreams } from "../lib/warm-streams.mjs";
test("the source gateway exposes opaque camera resources without HA tokens or general API access", async (t) => {
  const visited = [];
  const ha = {
    connected: true,
    media: async (url) => {
      visited.push(url);
      return url.endsWith(".m3u8")
        ? new Response(
            '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.ts\n',
            { headers: { "Content-Type": "application/vnd.apple.mpegurl" } },
          )
        : new Response("synthetic-fragment", {
            headers: { "Content-Type": "video/mp2t" },
          });
    },
  };
  const warm = new WarmStreams(ha, { buffers: new Map() }),
    token = "a".repeat(48),
    entry = {
      id: "camera.test",
      lease: token,
      source: "http://ha/core/api/hls/private-camera-token/master.m3u8",
      expires: Date.now() + 60000,
    };
  warm.entries.set(entry.id, entry);
  warm.leases.set(token, entry);
  const resource = warm.resource(entry, entry.source);
  const server = createApi({
    config: { standalone: true, apiToken: "owner-only" },
    ha,
    store: {},
    recorder: {},
    warm,
    getRegistry: () => ({ cameras: [], states: [] }),
    refresh: async () => {},
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await warm.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const response = await fetch(`${base}/cluster/source/${token}/${resource}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes("private-camera-token"));
  assert.ok(!text.includes("http://ha"));
  const segment = text.split("\n").find((line) => line.startsWith("/cluster/"));
  assert.ok(segment);
  assert.equal(
    await (await fetch(base + segment)).text(),
    "synthetic-fragment",
  );
  assert.ok(
    visited.every((url) =>
      url.startsWith("http://ha/core/api/hls/private-camera-token/"),
    ),
  );
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const count = visited.length;
  assert.equal(
    (await fetch(`${base}/cluster/source/${token}/${"f".repeat(24)}`)).status,
    400,
  );
  assert.equal(visited.length, count);
  warm.leases.delete(token);
  assert.equal((await fetch(base + segment)).status, 400);
  assert.equal(visited.length, count);
});
