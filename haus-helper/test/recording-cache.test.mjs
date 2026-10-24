import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { Cluster } from "../lib/cluster.mjs";
import { Servers } from "../lib/servers.mjs";
import { createApi } from "../lib/server.mjs";
import { defaults } from "../lib/config.mjs";
import { archiveEvent } from "../lib/recording-archive.mjs";
import { Backups, unseal } from "../lib/backups.mjs";
import { runMedia } from "../lib/media.mjs";

const digest = (data) => createHash("sha256").update(data).digest("hex");
async function fixture(
  t,
  { limit = 100, roles = ["storage"], supported = true } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "haus-tier-cache-")),
    media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media),
    blobs = new Map(),
    posted = [];
  const config = {
    ...defaults,
    data: root,
    media,
    max_storage_gb: limit / 1024 ** 3,
    standalone: true,
    apiToken: "test-token",
  };
  let verification = "valid",
    prepareCalls = 0,
    verifyGate,
    streamGate;
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url, "http://node.invalid"),
      key = url.pathname.split("/")[3];
    if (url.pathname === "/v1/status")
      return res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          protocol: 1,
          instanceId: "fixture",
          nodeId: "worker",
          storage: {
            availableBytes: 1e9,
            maxBytes: 1e9,
            usedBytes: 0,
            reservedBytes: 0,
            verification: { supported },
          },
          streams: { active: 0, max: 2 },
        }),
      );
    if (
      req.method === "POST" &&
      ["/v1/recordings", "/v1/backups"].includes(url.pathname)
    ) {
      let text = "";
      for await (const part of req) text += part;
      if (url.pathname === "/v1/recordings") posted.push(JSON.parse(text));
      return res
        .writeHead(201, { "content-type": "application/json" })
        .end("{}");
    }
    if (req.method === "PUT") {
      if (verification === "full") return res.writeHead(507).end();
      let parts = [];
      for await (const part of req) parts.push(part);
      const bytes = Buffer.concat(parts);
      if (digest(bytes) !== key) return res.writeHead(409).end();
      blobs.set(key, bytes);
      return res.writeHead(201).end();
    }
    if (req.method === "DELETE") {
      blobs.delete(key);
      return res.writeHead(200).end();
    }
    const data = blobs.get(key);
    if (!data) return res.writeHead(404).end();
    if (req.method === "POST" && url.pathname.endsWith("/verify")) {
      if (verifyGate && data.toString().startsWith("ORIGINAL"))
        await verifyGate;
      if (verification === "missing") return res.writeHead(404).end();
      return res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          digest: verification === "corrupt" ? "0".repeat(64) : digest(data),
          bytes: data.length,
          verified:
            verification !== "unverified" &&
            !(
              verification === "backup-unverified" &&
              !data.toString().startsWith("ORIGINAL") &&
              !data.toString().startsWith("PREPARED")
            ) &&
            !(
              verification === "prepared-unverified" &&
              data.toString().startsWith("PREPARED")
            ),
        }),
      );
    }
    let start = 0,
      end = data.length - 1;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      start = Number(range[1]);
      end = range[2] ? Number(range[2]) : end;
    }
    const headers = {
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
    };
    if (range)
      headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === "GET" && streamGate) {
      res.flushHeaders();
      await streamGate;
    }
    res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const backups = new Backups(config, store);
  await backups.initialize();
  const cluster = new Cluster(store, backups);
  const node = {
    id: "worker",
    name: "Worker",
    url: `http://127.0.0.1:${remote.address().port}`,
    enabled: true,
    roles,
    allowHttp: true,
    key: "fixture-key-".repeat(6),
    instanceId: "fixture",
  };
  store.db
    .prepare("INSERT INTO cluster_nodes(id,value)VALUES(?,?)")
    .run(node.id, JSON.stringify(node));
  cluster.enableRecordingCache(config);
  await cluster.poll();
  const api = createApi({
    config,
    store,
    cluster,
    backups,
    ha: { connected: true },
    getRegistry: () => ({ cameras: [], states: [] }),
    refresh: async () => {},
    recorder: {
      status: () => [],
      preparePlayback: async (event) => {
        prepareCalls++;
        return store.path(
          event.id,
          event.playbackBytes ? "playback.mp4" : "mp4",
        );
      },
    },
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`,
    headers = { Authorization: "Bearer test-token" };
  t.after(async () => {
    await cluster.stop();
    await backups.stop();
    api.closeAllConnections();
    remote.closeAllConnections();
    await Promise.all([
      new Promise((r) => api.close(r)),
      new Promise((r) => remote.close(r)),
    ]);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const event = async (index, { ready = true, prepared = true } = {}) => {
    const at = Date.now() - 100000 + index * 1000,
      item = store.create("camera.fixture", "motion", at, at + 1000);
    const original = Buffer.from(`ORIGINAL-${index}`.padEnd(32, "o")),
      playback = Buffer.from(`PREPARED-${index}`.padEnd(32, "p"));
    await writeFile(store.path(item.id), original);
    await writeFile(store.path(item.id, "jpg"), "thumbnail");
    store.finish(item.id, {
      bytes: original.length,
      duration: 1,
      playbackVersion: ready ? 4 : 0,
    });
    if (prepared) {
      await writeFile(store.path(item.id, "playback.mp4"), playback);
      store.setPlayback(item.id, playback.length, ready ? 4 : 0, {
        audio: true,
      });
    }
    return { id: item.id, original, playback };
  };
  return {
    root,
    store,
    cluster,
    config,
    blobs,
    posted,
    event,
    base,
    headers,
    node,
    backups,
    setVerification: (value) => {
      verification = value;
    },
    setVerifyGate: (value) => {
      verifyGate = value;
    },
    setStreamGate: (value) => {
      streamGate = value;
    },
    prepareCalls: () => prepareCalls,
  };
}

test("HA defaults to a 10GiB recent-video cache without replacing an explicit saved unlimited policy", async (t) => {
  assert.equal(defaults.max_storage_gb, 10);
  const f = await fixture(t);
  f.store.db.exec(
    "CREATE TABLE IF NOT EXISTS service_policy(id TEXT PRIMARY KEY,value TEXT NOT NULL)",
  );
  f.store.db
    .prepare(
      "INSERT OR REPLACE INTO service_policy VALUES('primary-storage',?)",
    )
    .run(JSON.stringify({ storageLimitBytes: null, source: "user" }));
  const servers = new Servers({
    config: f.config,
    store: f.store,
    cluster: f.cluster,
    backups: { markChanged() {} },
    ha: { connected: true },
  });
  assert.equal(servers.policy.storageLimitBytes, null);
  assert.equal(f.config.max_storage_gb, 0);
});

test("verified recent-cache rotation leaves capture headroom before the hard limit", async (t) => {
  const f = await fixture(t, { limit: 100 });
  const old = await f.event(0, { prepared: false });
  const fresh = await f.event(1, { prepared: false });
  const newest = await f.event(2, { prepared: false });
  assert.equal(f.store.totals().bytes, 96);
  f.setVerification("unverified");
  await f.cluster.work();
  assert.equal(
    f.store.get(old.id).localOriginal,
    true,
    "headroom cannot evict an unverified original",
  );
  f.setVerification("valid");
  await f.cluster.work();
  assert.equal(f.store.get(old.id).localOriginal, false);
  assert.equal(f.store.get(fresh.id).localOriginal, true);
  assert.equal(f.store.get(newest.id).localOriginal, true);
  assert.equal(f.store.totals().bytes, 64);
  assert.equal(
    f.config.max_storage_gb * 1024 ** 3,
    100,
    "the user limit is unchanged",
  );
  const next = await f.event(3, { prepared: false });
  assert.equal(
    f.store.totals().bytes,
    96,
    "the next capture fits without waiting for another trim",
  );
  assert.equal(f.store.get(next.id).localOriginal, true);
  assert.equal(f.store.totals().unavailableBytes, 0);
});

test("oldest verified originals and prepared copies rotate locally; ranged video/original and thumbnail remain readable", async (t) => {
  const f = await fixture(t, { limit: 100 }),
    old = await f.event(0),
    fresh = await f.event(1);
  await f.cluster.work();
  assert.equal(f.store.get(old.id).localOriginal, false);
  assert.equal(f.store.get(old.id).localPlayback, false);
  assert.equal(f.store.get(fresh.id).localOriginal, true);
  assert.equal(f.store.totals().bytes, 64);
  assert.equal(f.store.totals().totalBytes, 128);
  assert.equal(f.store.totals().archivedBytes, 64);
  assert.equal(f.store.list({}).events.length, 2);
  assert.equal(
    (await readFile(f.store.path(old.id, "jpg"))).toString(),
    "thumbnail",
  );
  const original = await fetch(`${f.base}/api/events/${old.id}/original`, {
    headers: { ...f.headers, Range: "bytes=2-7" },
  });
  assert.equal(original.status, 206);
  assert.equal(original.headers.get("content-range"), "bytes 2-7/32");
  assert.deepEqual(
    Buffer.from(await original.arrayBuffer()),
    old.original.subarray(2, 8),
  );
  const video = await fetch(`${f.base}/api/events/${old.id}/video`, {
    headers: f.headers,
  });
  assert.equal(video.status, 200);
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), old.playback);
  assert.equal(
    f.prepareCalls(),
    0,
    "archived prepared media must never wait for original processing",
  );
  const head = await fetch(`${f.base}/api/events/${old.id}/original`, {
    method: "HEAD",
    headers: f.headers,
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "32");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const thumb = await fetch(`${f.base}/api/events/${old.id}/thumbnail`, {
    headers: f.headers,
  });
  assert.equal(thumb.status, 200);
  assert.ok(
    !f.posted.some((row) => row.digest === digest(old.original)),
    "only the preferred prepared digest belongs in the worker's per-event index",
  );
  assert.ok(f.posted.some((row) => row.digest === digest(old.playback)));
});

test("a proven compatible original needs one archived immutable variant", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0, { prepared: false });
  await f.cluster.work();
  assert.equal(f.store.get(item.id).localOriginal, false);
  assert.equal(
    f.store.db
      .prepare("SELECT count(*) AS n FROM event_archive WHERE event_id=?")
      .get(item.id).n,
    1,
  );
  const response = await fetch(`${f.base}/api/events/${item.id}/video`, {
    headers: f.headers,
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), item.original);
});

for (const scenario of [
  "stream-only",
  "offline",
  "unsupported",
  "missing",
  "unverified",
  "prepared-unverified",
  "corrupt",
  "full",
])
  test(`never evicts the only usable local copy when archive is ${scenario}`, async (t) => {
    const f = await fixture(t, {
        limit: 1,
        roles: scenario === "stream-only" ? ["stream"] : ["storage"],
        supported: scenario !== "unsupported",
      }),
      item = await f.event(0);
    if (scenario === "offline")
      f.cluster.health.set(f.node.id, { online: false });
    if (
      [
        "missing",
        "unverified",
        "prepared-unverified",
        "corrupt",
        "full",
      ].includes(scenario)
    )
      f.setVerification(scenario);
    if (scenario === "offline") await archiveEvent(f.cluster, item.id);
    else await f.cluster.work();
    await f.cluster.recordingCache.trim();
    assert.equal(f.store.get(item.id).localOriginal, true);
    assert.equal(f.store.get(item.id).localPlayback, true);
    assert.deepEqual(await readFile(f.store.path(item.id)), item.original);
  });

test("a missing remote blob discovered after successful archival revokes local eviction", async (t) => {
  const f = await fixture(t, { limit: 1000 }),
    item = await f.event(0);
  await f.cluster.work();
  f.blobs.delete(digest(item.original));
  f.config.max_storage_gb = 1 / 1024 ** 3;
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(item.id).localOriginal, true);
  assert.deepEqual(await readFile(f.store.path(item.id)), item.original);
});

test("pending unprepared media is kept local rather than losing its repair input", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0, { ready: false });
  await f.cluster.work();
  assert.equal(f.store.get(item.id).localOriginal, true);
  assert.equal(f.store.get(item.id).localPlayback, true);
});

test("reader/preparer pins and exclusive eviction serialize without touching pre-roll or event metadata", async (t) => {
  const f = await fixture(t, { limit: 1000 }),
    item = await f.event(0);
  await f.cluster.work();
  const buffer = join(f.root, "buffer");
  await mkdir(buffer);
  await writeFile(join(buffer, "pre-roll.ts"), "ring-before-motion");
  f.config.max_storage_gb = 1 / 1024 ** 3;
  const release = await f.store.pinMedia(item.id);
  assert.equal(await f.cluster.recordingCache.trim(), 0);
  assert.equal(f.store.get(item.id).localOriginal, true);
  release();
  const exclusive = f.store.evictMedia(item.id);
  let acquired = false;
  const reader = f.store.pinMedia(item.id).then((unpin) => {
    acquired = true;
    unpin();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, false);
  exclusive();
  await reader;
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(item.id).localOriginal, false);
  assert.equal(
    (await readFile(join(buffer, "pre-roll.ts"))).toString(),
    "ring-before-motion",
  );
  assert.equal(f.store.get(item.id).status, "ready");
  assert.equal(
    f.store.recordedDays({
      cameraId: "camera.fixture",
      boundaries: [Date.now() - 1e7, Date.now() + 1e7],
    }).length,
    1,
  );
});

test("quota shrink keeps archives and catalog until independent age retention, which also respects active readers", async (t) => {
  const f = await fixture(t, { limit: 1000 }),
    item = await f.event(0);
  await f.cluster.work();
  f.config.max_storage_gb = 1 / 1024 ** 3;
  await f.cluster.recordingCache.trim();
  const release = await f.store.pinMedia(item.id);
  assert.equal(await f.store.prune(f.config, Date.now() + 8 * 86400000), 0);
  release();
  assert.equal(await f.store.prune(f.config, Date.now() + 8 * 86400000), 1);
  assert.equal(f.store.get(item.id), undefined);
  await f.cluster.prune([f.node]);
  assert.equal(f.blobs.has(digest(item.original)), false);
  assert.equal(f.blobs.has(digest(item.playback)), false);
});

test("an archive going offline returns a clear temporary media error without deleting catalog", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0);
  await f.cluster.work();
  f.cluster.health.set(f.node.id, { online: false });
  const response = await fetch(`${f.base}/api/events/${item.id}/video`, {
    headers: f.headers,
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "archived_media_unavailable");
  assert.equal(f.store.get(item.id).status, "ready");
});

test("64 blocked oldest entries cannot starve a newer eligible verified cache entry", async (t) => {
  const f = await fixture(t, { limit: 100000 });
  for (let i = 0; i < 65; i++) await f.event(i, { ready: false });
  const eligible = await f.event(70);
  await f.cluster.work();
  assert.ok(
    f.store.db
      .prepare("SELECT digest FROM event_archive WHERE event_id=?")
      .get(eligible.id),
    "unprepared oldest entries must not bury ready archive work",
  );
  f.config.max_storage_gb = 1 / 1024 ** 3;
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(eligible.id).localOriginal, true);
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(eligible.id).localOriginal, false);
});

test("a failed oldest archive page cannot starve newer eligible originals", async (t) => {
  const f = await fixture(t, { limit: 100000 });
  for (let i = 0; i < 9; i++) await f.event(i);
  f.setVerification("unverified");
  await f.cluster.work();
  f.setVerification("valid");
  await f.cluster.work();
  const newest = f.store.list({ limit: 1 }).events[0];
  assert.ok(
    f.store.db
      .prepare("SELECT digest FROM event_archive_locations WHERE event_id=?")
      .get(newest.id),
  );
});

test("an authenticated ranged remote reader pins its event against age deletion until the response completes", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0);
  await f.cluster.work();
  let complete;
  f.setStreamGate(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  t.after(() => complete());
  const response = await fetch(`${f.base}/api/events/${item.id}/video`, {
    headers: { ...f.headers, Range: "bytes=0-7" },
  });
  assert.equal(response.status, 206);
  assert.equal(await f.store.prune(f.config, Date.now() + 8 * 86400000), 0);
  complete();
  await response.arrayBuffer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await f.store.prune(f.config, Date.now() + 8 * 86400000), 1);
});

test("a reader arriving during verification waits until exclusive local eviction commits", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    item = await f.event(0);
  await f.cluster.work();
  f.config.max_storage_gb = 1 / 1024 ** 3;
  let complete;
  f.setVerifyGate(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const eviction = f.cluster.recordingCache.trim();
  while (!f.store.mediaEvictions.has(item.id))
    await new Promise((resolve) => setImmediate(resolve));
  let acquired = false;
  const reader = f.store.pinMedia(item.id).then((release) => {
    acquired = true;
    release();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, false);
  complete();
  await eviction;
  await reader;
  assert.equal(f.store.get(item.id).localOriginal, false);
});

test("raising or removing the local budget during remote verification revokes pending eviction", async (t) => {
  for (const limit of [100000, 0]) {
    const f = await fixture(t, { limit: 100000 }),
      item = await f.event(0);
    await f.cluster.work();
    f.config.max_storage_gb = 1 / 1024 ** 3;
    let complete;
    f.setVerifyGate(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    t.after(() => complete());
    const eviction = f.cluster.recordingCache.trim();
    while (!f.store.mediaEvictions.has(item.id))
      await new Promise((resolve) => setImmediate(resolve));
    f.config.max_storage_gb = limit;
    complete();
    assert.equal(await eviction, 0);
    assert.equal(f.store.get(item.id).localOriginal, true);
    assert.deepEqual(await readFile(f.store.path(item.id)), item.original);
  }
});

test("same-version playback repair invalidates old prepared archives and direct grants", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    item = await f.event(0);
  await f.cluster.work();
  assert.ok(
    f.store.db
      .prepare("SELECT digest FROM cluster_media WHERE event_id=?")
      .get(item.id),
  );
  const repaired = Buffer.from("REPAIRED".padEnd(32, "r"));
  await writeFile(f.store.path(item.id, "playback.mp4"), repaired);
  f.store.setPlayback(item.id, repaired.length, 4, { audio: true });
  assert.equal(
    f.store.db
      .prepare(
        "SELECT digest FROM event_archive WHERE event_id=? AND variant='prepared'",
      )
      .get(item.id),
    undefined,
  );
  assert.equal(
    f.store.db
      .prepare("SELECT digest FROM cluster_media WHERE event_id=?")
      .get(item.id),
    undefined,
  );
  await f.cluster.work();
  f.config.max_storage_gb = 1 / 1024 ** 3;
  await f.cluster.recordingCache.trim();
  const response = await fetch(`${f.base}/api/events/${item.id}/video`, {
    headers: f.headers,
  });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), repaired);
});

test("restart reconciliation recovers the unlink/flag crash window without calling missing footage archived", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    archived = await f.event(0);
  await f.cluster.work();
  const missing = await f.event(1);
  await unlink(f.store.path(archived.id));
  await unlink(f.store.path(archived.id, "playback.mp4"));
  await unlink(f.store.path(missing.id));
  await unlink(f.store.path(missing.id, "playback.mp4"));
  await f.store.reconcileLocalMedia();
  assert.equal(f.store.get(archived.id).localOriginal, false);
  assert.equal(f.store.totals().bytes, 0);
  assert.equal(f.store.totals().archivedBytes, 64);
  assert.equal(f.store.totals().unavailableBytes, 64);
  assert.equal(f.store.totals().archivedEvents, 1);
  const response = await fetch(`${f.base}/api/events/${archived.id}/video`, {
    headers: f.headers,
  });
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    archived.playback,
  );
});

test("disconnect and helper shutdown release remote playback pins while the body is stalled", async (t) => {
  for (const stop of [false, true]) {
    const f = await fixture(t, { limit: 1 }),
      item = await f.event(0);
    await f.cluster.work();
    let complete;
    f.setStreamGate(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    t.after(() => complete());
    const controller = new AbortController(),
      response = await fetch(`${f.base}/api/events/${item.id}/video`, {
        headers: f.headers,
        signal: controller.signal,
      });
    const body = response.arrayBuffer().catch(() => {});
    if (stop) await f.cluster.stop();
    else controller.abort();
    await body;
    for (let i = 0; i < 50 && f.store.mediaPins.has(item.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(f.store.mediaPins.has(item.id), false);
    complete();
  }
});

test("an aborted reader waiting on eviction never acquires a stale event pin", async (t) => {
  const f = await fixture(t),
    item = await f.event(0),
    release = f.store.evictMedia(item.id),
    controller = new AbortController();
  const reader = f.store.pinMedia(item.id, controller.signal);
  controller.abort();
  await assert.rejects(reader, { name: "AbortError" });
  release();
  assert.equal(f.store.mediaPins.has(item.id), false);
});

test("verified archive adoption protects a just-in-time preparation original from cluster cleanup", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0);
  f.blobs.set(digest(item.original), item.original);
  f.cluster.notePlaybackUpload(f.node.id, digest(item.original));
  await archiveEvent(f.cluster, item.id);
  assert.equal(
    f.store.db
      .prepare("SELECT kind FROM cluster_locations WHERE digest=?")
      .get(digest(item.original)).kind,
    "archive",
  );
  await f.cluster.recordingCache.trim();
  await f.cluster.prune([f.node]);
  assert.equal(f.store.get(item.id).localOriginal, false);
  assert.ok(f.blobs.has(digest(item.original)));
  assert.ok(f.blobs.has(digest(item.playback)));
  for (const [route, data] of [
    ["original", item.original],
    ["video", item.playback],
  ]) {
    const response = await fetch(`${f.base}/api/events/${item.id}/${route}`, {
      headers: f.headers,
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  }
});

test("retrying original archival never overwrites the prepared worker catalog row", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    item = await f.event(0);
  await archiveEvent(f.cluster, item.id);
  f.store.db
    .prepare(
      "DELETE FROM event_archive_locations WHERE event_id=? AND variant='original'",
    )
    .run(item.id);
  f.store.markArchiveChanged();
  await archiveEvent(f.cluster, item.id);
  assert.ok(f.posted.length);
  assert.ok(
    f.posted.every(
      (row) =>
        row.digest === digest(item.playback) && row.event.playbackVersion === 4,
    ),
  );
});

test("a healthy third storage node can archive when earlier candidates reject new copies", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0);
  const full = createServer((req, res) =>
    res.writeHead(req.method === "PUT" ? 507 : 404).end(),
  );
  await new Promise((resolve) => full.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => full.close(resolve)));
  f.store.db.prepare("DELETE FROM cluster_nodes").run();
  for (const id of ["full-a", "full-b"]) {
    const node = {
      ...f.node,
      id,
      url: `http://127.0.0.1:${full.address().port}`,
    };
    f.store.db
      .prepare("INSERT INTO cluster_nodes VALUES(?,?)")
      .run(id, JSON.stringify(node));
    f.cluster.health.set(id, { ...f.cluster.health.get(f.node.id) });
  }
  f.store.db
    .prepare("INSERT INTO cluster_nodes VALUES(?,?)")
    .run(f.node.id, JSON.stringify(f.node));
  await archiveEvent(f.cluster, item.id);
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(item.id).localOriginal, false);
  assert.ok(f.blobs.has(digest(item.original)));
  assert.ok(f.blobs.has(digest(item.playback)));
});

test("missing or unverifiable recovery metadata keeps original and playback local", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    item = await f.event(0);
  await archiveEvent(f.cluster, item.id);
  f.config.max_storage_gb = 1 / 1024 ** 3;
  const canSnapshot = f.backups.canSnapshot.bind(f.backups);
  f.backups.canSnapshot = () => false;
  assert.equal(await f.cluster.recordingCache.trim(), 0);
  f.backups.canSnapshot = canSnapshot;
  f.setVerification("backup-unverified");
  assert.equal(await f.cluster.recordingCache.trim(), 0);
  assert.equal(f.store.get(item.id).localOriginal, true);
  f.setVerification("valid");
  assert.equal(await f.cluster.recordingCache.trim(), 64);
  assert.equal(f.store.get(item.id).localOriginal, false);
});

test("an in-progress HA backup cannot block a verified catalog snapshot and cache rotation", async (t) => {
  const f = await fixture(t, { limit: 1 });
  const item = await f.event(0);
  await archiveEvent(f.cluster, item.id);
  f.backups.config.standalone = false;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.backups.supervisor = async (path, init) => {
    if (init?.method === "POST")
      return Response.json({ result: "ok", data: { slug: "owned-slow-ha" } });
    await gate;
    return new Response("ha-fixture");
  };
  const slow = f.backups.snapshot("ha");
  try {
    assert.equal(f.backups.busy, true);
    assert.equal(await f.cluster.recordingCache.trim(), 64);
    assert.equal(f.store.get(item.id).localOriginal, false);
    assert.equal(f.backups.busy, true, "the HA backup must remain active");
    const catalog = f.backups.list().find((b) => b.kind === "haus");
    assert.ok(catalog.archiveGeneration >= f.store.archiveGeneration());
    assert.ok(f.blobs.has(catalog.digest));
    assert.ok(f.blobs.has(digest(item.original)));
    assert.ok(f.blobs.has(digest(item.playback)));
  } finally {
    release();
    await slow;
  }
});

test("a changed archive map revokes a pending eviction until its newer recovery snapshot is verified", async (t) => {
  const f = await fixture(t, { limit: 100000 }),
    item = await f.event(0);
  await archiveEvent(f.cluster, item.id);
  f.config.max_storage_gb = 1 / 1024 ** 3;
  let complete;
  f.setVerifyGate(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  t.after(() => complete());
  const eviction = f.cluster.recordingCache.trim();
  while (!f.store.mediaEvictions.has(item.id))
    await new Promise((resolve) => setImmediate(resolve));
  f.store.markArchiveChanged();
  complete();
  assert.equal(await eviction, 0);
  assert.equal(f.store.get(item.id).localOriginal, true);
  await f.cluster.recordingCache.trim();
  assert.equal(f.store.get(item.id).localOriginal, false);
});

test("a verified remote encrypted snapshot restores both archived variants after local video is gone", async (t) => {
  const f = await fixture(t, { limit: 1 }),
    item = await f.event(0);
  await f.cluster.work();
  const backup = f.backups.list().find((item) => item.kind === "haus");
  assert.equal(backup.archiveGeneration, f.store.archiveGeneration());
  const recovery = join(f.root, "recovery");
  await mkdir(recovery);
  const sealed = join(recovery, "recovery.enc"),
    tar = join(recovery, "recovery.tar.gz");
  await writeFile(sealed, f.blobs.get(backup.digest));
  await unseal(sealed, tar, f.backups.key);
  await runMedia("tar", ["-xzf", tar, "-C", recovery]);
  const restored = new Store(join(recovery, "haus.sqlite"), f.store.media);
  t.after(() => restored.close());
  await restored.reconcileLocalMedia();
  assert.equal(restored.get(item.id).localOriginal, false);
  assert.equal(restored.archiveGeneration(), backup.archiveGeneration);
  const cluster = new Cluster(restored, { list: () => [], markChanged() {} });
  t.after(() => cluster.stop());
  await cluster.poll();
  for (const [variant, data] of [
    ["original", item.original],
    ["prepared", item.playback],
  ]) {
    const remote = await cluster.archiveMedia(
      restored.get(item.id),
      variant,
      undefined,
      new AbortController().signal,
    );
    assert.ok(remote);
    try {
      assert.deepEqual(Buffer.from(await remote.response.arrayBuffer()), data);
    } finally {
      remote.release();
    }
  }
});

test("restart probes only known local variants in keyset batches with four filesystem calls at most", async (t) => {
  const f = await fixture(t, { limit: 100000 });
  for (let i = 0; i < 260; i++) await f.event(i);
  const first = f.store.list({ direction: "newer", limit: 1 }).events[0];
  f.store.setLocal(first.id, "original", false);
  f.store.setLocal(first.id, "prepared", false);
  let active = 0,
    max = 0,
    calls = 0;
  await f.store.reconcileLocalMedia(async (file) => {
    active++;
    max = Math.max(max, active);
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await stat(file);
    } finally {
      active--;
    }
  });
  assert.equal(calls, 518);
  assert.ok(max <= 4);
  assert.equal(
    f.store.get(first.id).localOriginal,
    false,
    "untracked files cannot silently rehydrate an archived variant",
  );
});
