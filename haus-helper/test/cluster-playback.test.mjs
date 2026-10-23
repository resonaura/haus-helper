import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { runMedia } from "../lib/media.mjs";
import { Store } from "../lib/store.mjs";
import { Cluster } from "../lib/cluster.mjs";
import { authenticator } from "../lib/cluster-auth.mjs";

const key = "test-node-key-with-at-least-32-characters";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
let media, mediaRoot;
before(async () => {
  mediaRoot = await mkdtemp(join(tmpdir(), "haus-cluster-media-"));
  const file = join(mediaRoot, "fixture.mp4");
  await runMedia("ffmpeg", [
    "-hide_banner",
    "-v",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=20",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-threads",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    file,
  ]);
  media = await readFile(file);
});
after(() => rm(mediaRoot, { recursive: true, force: true }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-cluster-playback-"));
  await mkdir(join(root, "media"));
  const store = new Store(join(root, "db.sqlite"), join(root, "media"));
  const cluster = new Cluster(store, { list: () => [], markChanged() {} });
  const event = store.create("camera.fixture", "motion", 1000, 3000);
  await writeFile(store.path(event.id), media);
  store.finish(event.id, { bytes: media.length, duration: 2 });
  const output = join(root, "prepared.partial.mp4");
  const nodes = [],
    servers = [];
  cluster.nodes = () => nodes;
  t.after(async () => {
    await cluster.stop();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const add = async ({
    cpu = 0.1,
    cpus = 2,
    memory = 1024 ** 3,
    replicated = true,
    supported = true,
    payload = media,
    checksum = digest(payload),
    onStart = () => {},
    alwaysPending = false,
    registrationDelay = 0,
    uploadSupported = true,
  } = {}) => {
    const authenticate = authenticator(key),
      calls = { started: 0, deleted: 0, polls: 0, uploaded: 0 };
    let sourcePresent = replicated;
    const job = randomUUID();
    const json = (res, code, value) =>
      res
        .writeHead(code, { "Content-Type": "application/json" })
        .end(JSON.stringify(value));
    const server = createServer(async (req, res) => {
      if (!authenticate(req)) return json(res, 401, {});
      if (req.method === "HEAD" && req.url === `/v1/blobs/${digest(media)}`)
        return res
          .writeHead(sourcePresent ? 200 : 404, {
            "Content-Length": sourcePresent ? media.length : 0,
          })
          .end();
      if (
        req.method === "PUT" &&
        req.url === `/v1/blobs/${digest(media)}` &&
        uploadSupported
      ) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), media);
        assert.equal(req.headers["x-haus-digest"], digest(media));
        calls.uploaded++;
        sourcePresent = true;
        return json(res, 201, {});
      }
      if (req.method === "POST" && req.url === "/v1/playback") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        assert.equal(req.headers["x-haus-digest"], digest(bytes));
        assert.equal(JSON.parse(bytes).digest, digest(media));
        calls.started++;
        onStart();
        if (registrationDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, registrationDelay),
          );
        return json(res, 202, { id: job, status: "preparing" });
      }
      if (req.method === "GET" && req.url === `/v1/playback/${job}`) {
        calls.polls++;
        return json(
          res,
          alwaysPending ? 202 : 200,
          alwaysPending
            ? { id: job, status: "preparing" }
            : {
                id: job,
                status: "ready",
                profile: 1,
                digest: checksum,
                bytes: payload.length,
                duration: 2,
                audio: true,
              },
        );
      }
      if (req.method === "GET" && req.url === `/v1/playback/${job}/media`)
        return res
          .writeHead(200, {
            "Content-Length": payload.length,
            "Content-Type": "video/mp4",
          })
          .end(payload);
      if (req.method === "DELETE" && req.url === `/v1/playback/${job}`) {
        calls.deleted++;
        return json(res, 200, {});
      }
      return json(res, 404, {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const node = {
      id: randomUUID(),
      key,
      enabled: true,
      roles: ["storage", "stream"],
      allowHttp: true,
      url: `http://127.0.0.1:${server.address().port}`,
    };
    nodes.push(node);
    cluster.health.set(node.id, {
      online: true,
      lastSeen: Date.now(),
      remote: {
        resources: { cpus, memoryBytes: memory, cpu, pressured: false },
        ...(supported ? { playback: { profile: 1, max: 1, active: 0 } } : {}),
      },
    });
    if (replicated)
      store.db
        .prepare(
          "INSERT INTO cluster_locations(digest,node_id,kind)VALUES(?,?,'media')",
        )
        .run(digest(media), node.id);
    return { node, calls };
  };
  return { root, store, cluster, event: store.get(event.id), output, add };
}

test("selects a lightly loaded capable replica, verifies media, cleans remote work and preserves the original", async (t) => {
  const f = await fixture(t);
  const busy = await f.add({ cpu: 0.8 });
  const light = await f.add({ cpu: 0.1 });
  const weak = await f.add({ cpus: 0.75, memory: 512 * 1024 ** 2 });
  assert.equal(
    await f.cluster.preparePlayback(f.event, { output: f.output }),
    true,
  );
  assert.equal(light.calls.started, 1);
  assert.equal(light.calls.deleted, 1);
  assert.equal(busy.calls.started + weak.calls.started, 0);
  assert.deepEqual(await readFile(f.output), media);
  assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
  assert.equal(f.cluster.playbackNodes.size, 0);
});
test("older nodes or failed just-in-time uploads leave local preparation available", async (t) => {
  const f = await fixture(t);
  const old = await f.add({ supported: false });
  const absent = await f.add({ replicated: false, uploadSupported: false });
  assert.equal(
    await f.cluster.preparePlayback(f.event, { output: f.output }),
    false,
  );
  assert.equal(old.calls.started + absent.calls.started, 0);
  await assert.rejects(() => access(f.output));
});
test("background admission allows a capable idle worker before periodic replication", async (t) => {
  const f = await fixture(t);
  await f.add({ cpus: 0.75, memory: 512 * 1024 ** 2 });
  const strong = await f.add({ replicated: false });
  assert.equal(f.cluster.canPreparePlayback(f.event), true);
  f.cluster.playbackNodes.add(strong.node.id);
  assert.equal(f.cluster.canPreparePlayback(f.event), false);
  f.cluster.playbackNodes.clear();
  f.cluster.health.get(strong.node.id).remote.resources.pressured = true;
  assert.equal(f.cluster.canPreparePlayback(f.event), false);
});
test("uploads a missing original on demand and returns verified playable media", async (t) => {
  const f = await fixture(t),
    node = await f.add({ replicated: false });
  assert.equal(
    await f.cluster.preparePlayback(f.event, { output: f.output }),
    true,
  );
  assert.equal(node.calls.uploaded, 1);
  assert.equal(node.calls.started, 1);
  assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
});
test("checksum or container failures discard only generated output and release the worker", async (t) => {
  for (const invalidContainer of [false, true]) {
    const f = await fixture(t);
    const payload = invalidContainer
      ? Buffer.from("not an MP4")
      : Buffer.from(media);
    if (!invalidContainer) payload[payload.length - 1] ^= 1;
    const node = await f.add({
      payload,
      checksum: invalidContainer ? digest(payload) : digest(media),
    });
    assert.equal(
      await f.cluster.preparePlayback(f.event, { output: f.output }),
      false,
    );
    assert.equal(node.calls.deleted, 1);
    await assert.rejects(() => access(f.output));
    assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
  }
});
test("connection cancellation stops polling and releases accepted remote work", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const node = await f.add({
    alwaysPending: true,
    onStart: () => setTimeout(() => abort.abort(), 20),
  });
  await assert.rejects(
    () =>
      f.cluster.preparePlayback(f.event, {
        output: f.output,
        signal: abort.signal,
      }),
    { name: "AbortError" },
  );
  assert.equal(node.calls.deleted, 1);
  assert.equal(f.cluster.playbackNodes.size, 0);
  assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
});

test("cancellation before the registration response still deletes the accepted job", async (t) => {
  for (const stopCluster of [false, true]) {
    const f = await fixture(t),
      abort = new AbortController();
    const node = await f.add({
      alwaysPending: true,
      registrationDelay: 150,
      onStart: () => {
        if (stopCluster) f.cluster.abort.abort();
        else abort.abort();
      },
    });
    await assert.rejects(
      () =>
        f.cluster.preparePlayback(f.event, {
          output: f.output,
          signal: abort.signal,
        }),
      { name: "AbortError" },
    );
    assert.equal(node.calls.started, 1);
    assert.equal(node.calls.deleted, 1);
    assert.equal(node.calls.polls, 0);
    assert.equal(f.cluster.playbackNodes.size, 0);
    await assert.rejects(() => access(f.output));
    assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
  }
});

test("the original can never be used as generated output", async (t) => {
  const f = await fixture(t);
  const node = await f.add();
  await assert.rejects(
    () =>
      f.cluster.preparePlayback(f.event, { output: f.store.path(f.event.id) }),
    /invalid_playback_output/,
  );
  assert.equal(node.calls.started, 0);
  assert.deepEqual(await readFile(f.store.path(f.event.id)), media);
});

test("parallel selections cannot claim the same worker slot from stale health data", async (t) => {
  const f = await fixture(t),
    abort = new AbortController();
  const node = await f.add({ alwaysPending: true });
  const first = f.cluster.preparePlayback(f.event, {
    output: f.output,
    signal: abort.signal,
  });
  const cancelled = assert.rejects(first, { name: "AbortError" });
  for (let i = 0; i < 100 && !node.calls.started; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(node.calls.started, 1);
  assert.equal(
    await f.cluster.preparePlayback(f.event, {
      output: join(f.root, "other.partial.mp4"),
    }),
    false,
  );
  abort.abort();
  await cancelled;
  assert.equal(node.calls.started, 1);
  assert.equal(node.calls.deleted, 1);
});
