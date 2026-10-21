import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../lib/store.mjs";
import { Cluster } from "../lib/cluster.mjs";

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
