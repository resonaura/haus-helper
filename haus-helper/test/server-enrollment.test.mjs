import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Cluster } from "../lib/cluster.mjs";
import { Store } from "../lib/store.mjs";

const sshServerId = "ssh:98406f80-75ca-4c91-9633-23cc2f32a100";
async function fixture(t, roles = []) {
  const root = await mkdtemp(join(tmpdir(), "haus-server-enrollment-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media);
  const bytes = Buffer.from("recovery-copy"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const backup = join(root, "recovery.enc");
  await writeFile(backup, bytes);
  const requests = [],
    peers = [];
  const addPeer = async () => {
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (req.url !== "/v1/status") return res.writeHead(500).end();
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          protocol: 1,
          nodeId: "monitor-fixture",
          instanceId: "monitor-instance",
          roles,
          storage: { usedBytes: 0, maxBytes: 10000 },
          streams: { active: 0, max: 0 },
          host: {
            scope: "host",
            sampledAt: new Date().toISOString(),
            cpu: { usage: 0.2 },
          },
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    peers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  };
  const cluster = new Cluster(store, {
    list: () => [{ digest, bytes: bytes.length, kind: "haus", createdAt: 1 }],
    path: () => backup,
    markChanged() {},
  });
  const input = (url, extra = {}) => ({
    name: "Monitoring fixture",
    url,
    key: "fixture-key-".repeat(4),
    roles,
    allowHttp: true,
    ...extra,
  });
  t.after(async () => {
    await cluster.stop();
    store.close();
    await Promise.all(
      peers.map(async (server) => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }),
    );
    await rm(root, { recursive: true, force: true });
  });
  return { cluster, addPeer, requests, input };
}

test("an SSH monitoring connection receives telemetry without camera, backup or storage work", async (t) => {
  const f = await fixture(t);
  const result = await f.cluster.add(
    f.input(await f.addPeer(), { sshServerId }),
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].sshServerId, sshServerId);
  assert.deepEqual(result.nodes[0].roles, []);
  assert.equal(result.nodes[0].remote.host.cpu.usage, 0.2);
  assert.equal(result.pairedNodeId, result.nodes[0].id);
  assert.equal(result.nodes[0].key, undefined);
  await f.cluster.work();
  assert.ok(f.requests.length > 1);
  assert.ok(f.requests.every((path) => path === "/v1/status"));
});

test("SSH associations are validated and unique across new and existing connections", async (t) => {
  const f = await fixture(t);
  const first = await f.cluster.add(
    f.input(await f.addPeer(), { sshServerId }),
  );
  const secondUrl = await f.addPeer();
  await assert.rejects(
    f.cluster.add(f.input(secondUrl, { sshServerId })),
    /invalid_duplicate_ssh_server/,
  );
  const second = await f.cluster.add(f.input(secondUrl));
  const secondId = second.pairedNodeId;
  await assert.rejects(
    f.cluster.update(secondId, { sshServerId }),
    /invalid_duplicate_ssh_server/,
  );
  await assert.rejects(
    f.cluster.update(secondId, { sshServerId: "home-assistant" }),
    /invalid_node/,
  );
  await f.cluster.update(first.pairedNodeId, { sshServerId: null });
  await f.cluster.update(secondId, { sshServerId });
  assert.equal(
    f.cluster.nodes().find((node) => node.id === secondId).sshServerId,
    sshServerId,
  );
});

test("a monitoring-only agent cannot be enrolled for unavailable media roles", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.cluster.add(f.input(await f.addPeer(), { roles: ["storage"] })),
    /invalid_node_roles/,
  );
  assert.equal(f.cluster.nodes().length, 0);
});

test("parallel enrollment cannot attach two helpers to the same SSH machine", async (t) => {
  const f = await fixture(t);
  const urls = await Promise.all([f.addPeer(), f.addPeer()]);
  const results = await Promise.allSettled(
    urls.map((url) => f.cluster.add(f.input(url, { sshServerId }))),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(f.cluster.nodes().length, 1);
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /invalid_duplicate_ssh_server/,
  );
});

test("stream-only helpers are not assigned recovery storage copies", async (t) => {
  const f = await fixture(t, ["stream"]);
  await f.cluster.add(f.input(await f.addPeer()));
  await f.cluster.work();
  assert.ok(f.requests.every((path) => path === "/v1/status"));
});
