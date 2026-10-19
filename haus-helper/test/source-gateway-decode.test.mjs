import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApi } from "../lib/server.mjs";
import { WarmStreams } from "../lib/warm-streams.mjs";
const run = promisify(execFile);

test("FFmpeg decodes nested HLS and fMP4 through opaque source capabilities with extension checks enabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-source-decode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=10",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-g",
      "10",
      "-f",
      "hls",
      "-hls_time",
      "1",
      "-hls_segment_type",
      "fmp4",
      "-hls_playlist_type",
      "vod",
      join(root, "media.m3u8"),
    ],
    { timeout: 15000 },
  );
  const ha = {
    media: async (value) => {
      const name = basename(new URL(value).pathname);
      return new Response(
        name === "master.m3u8"
          ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nmedia.m3u8\n"
          : await readFile(join(root, name)),
        {
          headers: {
            "Content-Type": name.endsWith(".m3u8")
              ? "application/vnd.apple.mpegurl"
              : "video/mp4",
          },
        },
      );
    },
  };
  const warm = new WarmStreams(ha, { buffers: new Map() });
  const token = "a".repeat(48);
  const entry = {
    id: "camera.fixture",
    source: "http://private-ha/api/hls/private-token/master.m3u8",
    expires: Date.now() + 60000,
  };
  warm.entries.set(entry.id, entry);
  warm.leases.set(token, entry);
  const server = createApi({
    config: { standalone: true, apiToken: "fixture-only" },
    ha,
    store: {},
    recorder: {},
    warm,
    getRegistry: () => ({ cameras: [], states: [] }),
    refresh: async () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await warm.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const source = `http://127.0.0.1:${server.address().port}/cluster/source/${token}/${warm.resource(entry, entry.source)}`;
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-i", source, "-an", "-f", "framemd5", "-"],
    { timeout: 15000 },
  );
  assert.equal(
    stdout.split("\n").filter((line) => /^0,/.test(line)).length,
    30,
  );
});
