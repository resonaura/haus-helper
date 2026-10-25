import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Cluster } from "../lib/cluster.mjs";
import { Servers } from "../lib/servers.mjs";
import { Store } from "../lib/store.mjs";

const deferred = () => Promise.withResolvers();
async function fixture(t, handle) {
  const root = await mkdtemp(join(tmpdir(), "haus-cluster-health-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media);
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let at = 0;
  const backups = { list: () => [], markChanged() {} };
  const cluster = new Cluster(store, backups, { now: () => at });
  const add = (id = "fixture-node") => {
    const node = {
      id,
      name: id,
      instanceId: "fixture-instance",
      enabled: true,
      roles: ["storage"],
      url: `http://127.0.0.1:${server.address().port}`,
      allowHttp: true,
      key: "fixture-node-key-".repeat(3),
    };
    store.db
      .prepare("INSERT INTO cluster_nodes(id,value)VALUES(?,?)")
      .run(node.id, JSON.stringify(node));
    cluster.invalidateHealth();
    return node;
  };
  t.after(async () => {
    await cluster.stop();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    cluster,
    backups,
    media,
    add,
    advance: (ms = 5000) => (at += ms),
    now: () => at,
  };
}
const reply = (res, usage = 0.1) =>
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      protocol: 1,
      instanceId: "fixture-instance",
      host: {
        sampledAt: new Date().toISOString(),
        cpu: { usage },
        docker: {
          available: true,
          containers: [{ id: "fixture-container", cpuPercent: usage * 100 }],
        },
      },
      storage: { usedBytes: 10, maxBytes: 100 },
      streams: { active: 0, max: 1 },
    }),
  );

test("health refreshes coalesce, cache completed attempts and retry after the bounded interval", async (t) => {
  const gate = deferred();
  let requests = 0;
  const f = await fixture(t, async (_req, res) => {
    requests++;
    await gate.promise;
    reply(res);
  });
  f.add();
  const first = f.cluster.refreshHealth();
  assert.equal(f.cluster.refreshHealth(), first);
  gate.resolve();
  await first;
  assert.equal(requests, 1);
  await f.cluster.refreshHealth();
  f.advance(999);
  await f.cluster.refreshHealth();
  assert.equal(requests, 1);
  f.advance(1);
  await f.cluster.refreshHealth();
  assert.equal(requests, 2);
  const forced = f.cluster.refreshHealth({ force: true });
  assert.equal(f.cluster.refreshHealth({ force: true }), forced);
  await forced;
  assert.equal(
    requests,
    3,
    "copy boundaries bypass the TTL without overlapping requests",
  );
});

test("server reads receive fresh process/resource reports while replication is still running", async (t) => {
  let usage = 0.1,
    requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    reply(res, usage);
  });
  f.add();
  const copying = deferred(),
    finishCopy = deferred();
  f.backups.list = () => [{ digest: "a".repeat(64) }];
  f.backups.path = () => "/unused-fixture-backup";
  f.cluster.replicate = async () => {
    copying.resolve();
    await finishCopy.promise;
  };
  f.cluster.abort.signal.addEventListener("abort", () => finishCopy.resolve(), {
    once: true,
  });
  const distribution = f.cluster.tick();
  await copying.promise;
  assert.equal(f.cluster.busy, true);
  assert.equal(requests, 1);
  const servers = new Servers({
    store: f.store,
    cluster: f.cluster,
    backups: f.backups,
    ha: { connected: true },
    config: { standalone: true, max_storage_gb: 0, media: f.media },
    now: f.now,
    filesystem: async () => ({ blocks: 1000, bsize: 4096, bavail: 500 }),
  });
  usage = 0.8;
  f.advance();
  await Promise.all([servers.status(), servers.status()]);
  await f.cluster.healthRefresh;
  const reports = await Promise.all([servers.status(), servers.status()]);
  assert.equal(requests, 2);
  assert.equal(reports[0].servers[1].host.cpu.usage, 0.8);
  assert.equal(reports[0].servers[1].host.docker.containers[0].cpuPercent, 80);
  assert.equal(reports[1].servers[1].host.cpu.usage, 0.8);
  assert.equal(f.cluster.busy, true, "the archive has not finished");
  finishCopy.resolve();
  await distribution;
  assert.equal(
    requests,
    4,
    "both archive synchronization boundaries force a fresh report",
  );
});

test("a forced boundary queues one fresh pass after an older dashboard request", async (t) => {
  const received = deferred(),
    release = deferred();
  let requests = 0;
  const f = await fixture(t, async (_req, res) => {
    const current = ++requests;
    if (current === 1) {
      received.resolve();
      await release.promise;
    }
    reply(res, current === 1 ? 0.1 : 0.8);
  });
  const node = f.add();
  const dashboard = f.cluster.refreshHealth();
  await received.promise;
  const boundary = f.cluster.refreshHealth({ force: true });
  assert.equal(f.cluster.refreshHealth({ force: true }), boundary);
  assert.equal(requests, 1, "forced work does not overlap the earlier request");
  release.resolve();
  await dashboard;
  await boundary;
  assert.equal(requests, 2);
  assert.equal(f.cluster.health.get(node.id).remote.host.cpu.usage, 0.8);
});

test("failed health requests retain the last-known report and are retried after the TTL", async (t) => {
  let failed = false,
    requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    if (failed) res.writeHead(503).end();
    else reply(res);
  });
  const node = f.add();
  await f.cluster.refreshHealth();
  const previous = f.cluster.health.get(node.id);
  failed = true;
  f.advance();
  await f.cluster.refreshHealth();
  const unavailable = f.cluster.health.get(node.id);
  assert.equal(unavailable.online, false);
  assert.equal(unavailable.remote, previous.remote);
  assert.equal(unavailable.lastSeen, previous.lastSeen);
  await f.cluster.refreshHealth();
  assert.equal(requests, 2, "failure does not create an immediate retry loop");
  failed = false;
  f.advance();
  await f.cluster.refreshHealth();
  assert.equal(f.cluster.health.get(node.id).online, true);
  assert.equal(requests, 3);
});

test("health requests retain the existing four-node concurrency bound", async (t) => {
  const saturated = deferred(),
    release = deferred();
  let requests = 0,
    active = 0,
    peak = 0;
  const f = await fixture(t, async (_req, res) => {
    requests++;
    active++;
    peak = Math.max(peak, active);
    if (active === 4) saturated.resolve();
    await release.promise;
    active--;
    reply(res);
  });
  for (let index = 0; index < 6; index++) f.add(`node-${index}`);
  const refreshing = f.cluster.refreshHealth();
  await saturated.promise;
  assert.equal(requests, 4);
  assert.equal(peak, 4);
  release.resolve();
  await refreshing;
  assert.equal(requests, 6);
  assert.equal(peak, 4);
});

test("shutdown aborts outstanding status requests and settles the health lifecycle", async (t) => {
  const received = deferred(),
    closed = deferred();
  let requests = 0;
  const f = await fixture(t, (_req, res) => {
    requests++;
    res.once("close", () => closed.resolve());
    received.resolve();
  });
  f.add();
  const refreshing = f.cluster.refreshHealth();
  await received.promise;
  const forced = f.cluster.refreshHealth({ force: true });
  await f.cluster.stop();
  await refreshing;
  await forced;
  await closed.promise;
  assert.equal(f.cluster.healthRefresh, undefined);
  assert.equal(f.cluster.forcedHealthRefresh, undefined);
  await f.cluster.refreshHealth();
  assert.equal(requests, 1);
});

test(
  "server reads return last-known data without waiting behind a hung peer",
  { timeout: 3000 },
  async (t) => {
    const received = deferred(),
      release = deferred();
    const f = await fixture(t, async (_req, res) => {
      received.resolve();
      await release.promise;
      reply(res, 0.8);
    });
    const node = f.add();
    f.cluster.health.set(node.id, {
      online: true,
      lastSeen: 0,
      remote: {
        host: { sampledAt: new Date(0).toISOString(), cpu: { usage: 0.1 } },
      },
    });
    const refreshing = f.cluster.refreshHealth();
    await received.promise;
    const servers = new Servers({
      store: f.store,
      cluster: f.cluster,
      backups: f.backups,
      ha: { connected: true },
      config: { standalone: true, max_storage_gb: 0, media: f.media },
      now: f.now,
      filesystem: async () => ({ blocks: 1000, bsize: 4096, bavail: 500 }),
    });
    const before = await servers.status();
    assert.equal(before.servers[1].host.cpu.usage, 0.1);
    assert.equal(
      f.cluster.healthRefresh,
      refreshing,
      "status returned while the node is still pending",
    );
    release.resolve();
    await refreshing;
    const after = await servers.status();
    assert.equal(after.servers[1].host.cpu.usage, 0.8);
  },
);

test("a rejected background refresh does not reject the server response or leak an unhandled promise", async (t) => {
  const f = await fixture(t, (_req, res) => reply(res));
  f.cluster.poll = async () => {
    throw new Error("fixture-collection-failure");
  };
  const servers = new Servers({
    store: f.store,
    cluster: f.cluster,
    backups: f.backups,
    ha: { connected: true },
    config: { standalone: true, max_storage_gb: 0, media: f.media },
    now: f.now,
    filesystem: async () => ({ blocks: 1000, bsize: 4096, bavail: 500 }),
  });
  const status = await servers.status();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.servers[0].id, "home-assistant");
  assert.equal(f.cluster.healthRefresh, undefined);
});

test("an in-flight response cannot restore a node removed from the home", async (t) => {
  const received = deferred(),
    release = deferred();
  const f = await fixture(t, async (_req, res) => {
    received.resolve();
    await release.promise;
    reply(res);
  });
  const node = f.add();
  const refreshing = f.cluster.refreshHealth();
  await received.promise;
  f.cluster.remove(node.id);
  release.resolve();
  await refreshing;
  assert.equal(f.cluster.health.has(node.id), false);
  assert.equal(f.cluster.healthSampledAt, undefined);
});
