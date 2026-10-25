import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { Cluster } from "../lib/cluster.mjs";
import {
  archiveStorageMetadata,
  refreshArchiveStorageMetadata,
} from "../lib/archive-storage-metadata.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-cluster-metadata-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media);
  store.db.exec(
    "CREATE TABLE cluster_locations(digest TEXT NOT NULL,node_id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(digest,node_id))",
  );
  const posted = [],
    requests = [];
  let failure = false;
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (req.method === "POST" && req.url === "/v1/recordings") {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (failure) {
        res.writeHead(503).end();
        return;
      }
      posted.push(JSON.parse(body));
      res
        .writeHead(201, { "content-type": "application/json" })
        .end('{"saved":true}');
      return;
    }
    res.writeHead(400).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const cluster = new Cluster(store, { list: () => [] });
  const node = {
    id: "fixture-node",
    name: "Fixture",
    enabled: true,
    roles: ["storage"],
    url: `http://127.0.0.1:${server.address().port}`,
    allowHttp: true,
    key: "fixture-private-key-".repeat(3),
  };
  store.db
    .prepare("INSERT INTO cluster_nodes(id,value)VALUES(?,?)")
    .run(node.id, JSON.stringify(node));
  cluster.poll = async () => {};
  cluster.health.set(node.id, {
    online: true,
    remote: { storage: { usedBytes: 100, maxBytes: 100, reservedBytes: 0 } },
  });
  t.after(async () => {
    await cluster.stop();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const event = async (index) => {
    const item = store.create(
      "camera.fixture",
      "motion",
      1000 + index,
      3000 + index,
    );
    const bytes = Buffer.from("existing-camera-file-" + index);
    store.finish(item.id, {
      duration: 1002,
      bytes: bytes.length,
      playbackVersion: 2,
    });
    await writeFile(store.path(item.id), bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    store.db
      .prepare(
        "INSERT INTO cluster_media(event_id,digest,bytes,version)VALUES(?,?,?,?)",
      )
      .run(item.id, digest, bytes.length, 2);
    store.db
      .prepare(
        "INSERT INTO cluster_locations(digest,node_id,kind)VALUES(?,?,?)",
      )
      .run(digest, node.id, "media");
    return item;
  };
  return {
    store,
    cluster,
    posted,
    requests,
    event,
    fail: (value) => {
      failure = value;
    },
  };
}

test("old NVR catalogs migrate in bounded batches without uploading existing blobs, even on a full node", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) await f.event(i);
  await f.cluster.work();
  assert.equal(f.posted.length, 8);
  await f.cluster.work();
  assert.equal(f.posted.length, 10);
  await f.cluster.work();
  assert.equal(f.posted.length, 10, "matching metadata is not republished");
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM cluster_locations WHERE catalog_version=1 AND metadata_hash IS NOT NULL",
      )
      .get().n,
    10,
  );
});

test("archive storage classification repairs legacy catalogs in bounded batches without uploading or selecting originals over prepared media", async (t) => {
  const f = await fixture(t);
  f.cluster.health.get("fixture-node").remote.storage.usage = { version: 1 };
  for (let i = 0; i < 10; i++) {
    const event = await f.event(i);
    f.store.setPlayback(event.id, 20, 9);
    const original = "a".repeat(64),
      prepared = i.toString(16).padStart(64, "b");
    for (const [variant, digest, version] of [
      ["original", original, 0],
      ["prepared", prepared, 9],
    ]) {
      f.store.db
        .prepare(
          "INSERT INTO event_archive(event_id,variant,digest,bytes,version)VALUES(?,?,?,?,?)",
        )
        .run(event.id, variant, digest, 20, version);
      f.store.db
        .prepare(
          "INSERT INTO event_archive_locations(event_id,variant,node_id,digest,bytes,version,verified_at)VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          event.id,
          variant,
          "fixture-node",
          digest,
          20,
          version,
          Date.now(),
        );
    }
    assert.equal(
      archiveStorageMetadata(f.store, f.store.get(event.id), prepared).variant,
      "prepared",
    );
  }
  f.fail(true);
  await refreshArchiveStorageMetadata(f.cluster);
  assert.equal(f.posted.length, 0);
  f.fail(false);
  f.cluster.storageMetadataCursor = 0;
  await refreshArchiveStorageMetadata(f.cluster);
  assert.equal(f.posted.length, 8);
  await refreshArchiveStorageMetadata(f.cluster);
  assert.equal(f.posted.length, 10);
  await refreshArchiveStorageMetadata(f.cluster);
  await refreshArchiveStorageMetadata(f.cluster);
  assert.equal(
    f.posted.length,
    10,
    "identical classifications coalesce after cursor wraps",
  );
  assert.ok(
    f.posted.every(
      (item) =>
        item.variant === "prepared" && item.originalDigest === "a".repeat(64),
    ),
  );
  assert.ok(
    f.requests.every(
      (item) => item.method === "POST" && item.url === "/v1/recordings",
    ),
  );
});

test("corrected playback metadata updates despite identical media digest and bytes", async (t) => {
  const f = await fixture(t),
    event = await f.event(0);
  await f.cluster.work();
  assert.equal(f.posted.length, 1);
  f.store.setPlayback(event.id, 0, 3, {
    duration: 2,
    audioTailSeconds: 1000,
    audioTrimSeconds: 1000,
  });
  await f.cluster.work();
  assert.equal(f.posted.length, 2);
  assert.equal(f.posted[1].digest, f.posted[0].digest);
  assert.equal(f.posted[1].event.duration, 2);
  assert.equal(f.posted[1].event.originalDuration, 1002);
  assert.equal(f.posted[1].event.playbackInfo.audioTrimSeconds, 1000);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
});

test("failed metadata publication remains pending without losing or copying the stored blob", async (t) => {
  const f = await fixture(t);
  await f.event(0);
  f.fail(true);
  await f.cluster.work();
  assert.equal(f.posted.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT catalog_version FROM cluster_locations").get()
      .catalog_version,
    0,
  );
  f.fail(false);
  await f.cluster.work();
  assert.equal(f.posted.length, 1);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
});

test("node storage policy updates are authenticated, preserve enabled state and only commit after remote acceptance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-node-settings-")),
    media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "db.sqlite"), media);
  let accepted = false,
    received;
  const remote = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received = {
      method: req.method,
      path: req.url,
      value: JSON.parse(text),
      digest: req.headers["x-haus-digest"],
      signature: req.headers["x-haus-signature"],
    };
    res
      .writeHead(accepted ? 200 : 503, { "Content-Type": "application/json" })
      .end(
        JSON.stringify(
          accepted
            ? {
                storageLimitBytes: received.value.storageLimitBytes,
                source: "user",
              }
            : {},
        ),
      );
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  let changed = 0;
  const cluster = new Cluster(store, {
    list: () => [],
    markChanged: () => changed++,
  });
  const node = {
    id: "fixture-policy",
    name: "Home server",
    enabled: true,
    roles: ["storage", "stream"],
    allowHttp: true,
    url: `http://127.0.0.1:${remote.address().port}`,
    key: "private-fixture-node-signing-key-123456789",
  };
  store.db
    .prepare("INSERT INTO cluster_nodes(id,value)VALUES(?,?)")
    .run(node.id, JSON.stringify(node));
  t.after(async () => {
    await cluster.stop();
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(() =>
    cluster.update(node.id, { enabled: false, storageLimitBytes: null }),
  );
  assert.equal(cluster.nodes()[0].enabled, true);
  assert.equal(changed, 0);
  accepted = true;
  await cluster.update(node.id, { storageLimitBytes: null });
  assert.equal(received.method, "PATCH");
  assert.equal(received.path, "/v1/settings");
  assert.deepEqual(received.value, { storageLimitBytes: null });
  assert.match(received.digest, /^[a-f0-9]{64}$/);
  assert.ok(received.signature);
  assert.equal(cluster.nodes()[0].enabled, true);
  assert.equal(changed, 1);
  for (const patch of [
    {},
    { enabled: "false" },
    { storageLimitBytes: -1 },
    { url: "http://evil.invalid" },
  ])
    await assert.rejects(() => cluster.update(node.id, patch), /invalid_node/);
});

test("replica metadata never advertises old packet-only originals as normalized playback", async () => {
  const { recordingMetadata } = await import("../lib/recording-metadata.mjs");
  const event = {
    id: "fixture",
    playbackVersion: 4,
    playbackBytes: 0,
    playbackInfo: { originalCompatible: true },
  };
  assert.equal(recordingMetadata(event).playbackVersion, 0);
  assert.equal(
    recordingMetadata({ ...event, playbackBytes: 100 }).playbackVersion,
    4,
  );
  const trusted = recordingMetadata({
    ...event,
    playbackInfo: {
      originalCompatible: true,
      originalPolicyVersion: 1,
      originalProvenance: {
        kind: "camera",
        platform: "eufy_security",
        manufacturer: "Eufy Security",
        model: "T8410C",
      },
    },
  });
  assert.equal(trusted.playbackVersion, 4);
  assert.equal(trusted.playbackInfo.originalProvenance.model, "T8410C");
});
