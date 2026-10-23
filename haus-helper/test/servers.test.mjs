import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Servers, parseHostProc } from "../lib/servers.mjs";
import { Store } from "../lib/store.mjs";
import { createApi } from "../lib/server.mjs";

const meminfo =
  "MemTotal: 8000 kB\nMemAvailable: 3000 kB\nSwapTotal: 2000 kB\nSwapFree: 1500 kB\n";

test("host CPU/memory parsing measures kernel totals and does not substitute core container memory", () => {
  const sample = parseHostProc(
    "cpu 100 20 30 400 10 2 3 0 0 0\ncpu0 1\ncpu1 1\n",
    meminfo,
    "100.25 2",
  );
  assert.deepEqual(sample.cpuTimes, { total: 565, idle: 410 });
  assert.equal(sample.logicalCores, 2);
  assert.equal(sample.memory.totalBytes, 8000 * 1024);
  assert.equal(sample.memory.usedBytes, 5000 * 1024);
  assert.equal(sample.swap.usedBytes, 500 * 1024);
  assert.equal(sample.uptimeSeconds, 100.25);
  assert.equal(parseHostProc("", "", "").memory.totalBytes, null);
});

async function fixture(t, standalone = false) {
  const root = await mkdtemp(join(tmpdir(), "haus-servers-"));
  const media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media);
  const config = {
    standalone,
    token: "private-supervisor-token",
    apiToken: "fixture-api",
    max_storage_gb: 0,
    retention_days: 7,
    media,
  };
  let cpu = 100,
    idle = 100,
    at = 10000,
    changed = 0;
  const calls = [];
  const payloads = {
    "/host/info": {
      hostname: "homeassistant",
      operating_system: "Home Assistant OS",
      kernel: "Linux",
      disk_total: 100,
      disk_free: 60,
      disk_used: 40,
      serial: "do-not-leak",
    },
    "/core/info": { image: "ha/core", arch: "aarch64", secret: "do-not-leak" },
    "/core/stats?one_shot=true": {
      cpu_percent: 12,
      memory_usage: 1000000,
      memory_limit: 2000000,
    },
    "/addons": {
      addons: [
        {
          slug: "fixture",
          name: "Fixture service",
          state: "started",
          options: { password: "private-option" },
        },
      ],
    },
    "/addons/fixture/stats?one_shot=true": {
      cpu_percent: 5,
      memory_usage: 2000,
      memory_limit: 8000,
    },
    "/host/disks": {
      disks: [
        {
          id: "disk1",
          model: "SSD",
          size: 1000,
          serial: "private-serial",
          partitions: [
            { uuid: "vol1", label: "Data", filesystem: "ext4", size: 900 },
          ],
        },
      ],
    },
  };
  const options = {
    config,
    ha: { connected: true },
    store,
    cluster: {
      status: () => ({
        nodes: [
          {
            id: "remote",
            name: "Node",
            key: "private-node-key",
            enabled: true,
            online: true,
            roles: ["storage"],
            remote: {
              settings: { storageLimitBytes: null, source: "default" },
              host: {
                scope: "container",
                disks: [
                  { id: "disk-a", kind: "disk", type: "disk", physical: true },
                  {
                    id: "volume-a",
                    kind: "volume",
                    type: "container",
                    physical: false,
                    parentIds: ["disk-a"],
                  },
                ],
              },
              storage: { availableBytes: 900 },
            },
          },
        ],
      }),
    },
    backups: { markChanged: () => changed++ },
    now: () => at,
    read: async (path) =>
      path.endsWith("meminfo")
        ? meminfo
        : path.endsWith("uptime")
          ? "100 0"
          : path.endsWith("stat")
            ? `cpu ${cpu} 0 0 ${idle} 0 0 0 0\ncpu0 1\n`
            : path.endsWith("cpuinfo")
              ? "model name : Fixture CPU\n"
              : "0.1 0.2 0.3 1/100 1",
    filesystem: async () => ({
      blocks: 100000000,
      bavail: 50000000,
      bsize: 4096,
    }),
    fetcher: async (url, init) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push({ path, init });
      return new Response(
        JSON.stringify({ result: "ok", data: payloads[path] ?? {} }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  };
  const servers = new Servers(options);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    servers,
    options,
    store,
    config,
    calls,
    changed: () => changed,
    advance: () => {
      at += 5001;
      cpu += 30;
      idle += 70;
    },
  };
}

test("aggregates real HA host and managed container samples, preserves unknown values and redacts options/keys", async (t) => {
  const f = await fixture(t);
  const first = await f.servers.status(),
    primary = first.servers[0];
  assert.equal(primary.settings.storageLimitBytes, null);
  assert.equal(primary.host.memory.totalBytes, 8000 * 1024);
  assert.equal(primary.host.cpu.usage, null);
  assert.equal(
    primary.host.docker.containers.find((x) => x.id === "home-assistant-core")
      .memoryUsedBytes,
    1000000,
  );
  assert.equal(
    primary.host.disks.find((x) => x.id === "vol1").parentId,
    "disk1",
  );
  assert.equal(primary.host.pm2.available, false);
  assert.equal(first.servers[1].host.scope, "container");
  assert.deepEqual(first.servers[1].host.disks, [
    { id: "disk-a", kind: "disk", type: "disk", physical: true },
    {
      id: "volume-a",
      kind: "volume",
      type: "container",
      physical: false,
      parentIds: ["disk-a"],
    },
  ]);
  assert.equal(JSON.stringify(first).includes("private"), false);
  const count = f.calls.length;
  await f.servers.status();
  assert.equal(f.calls.length, count, "hot polls use cached bounded sample");
  f.advance();
  assert.ok(
    Math.abs((await f.servers.status()).servers[0].host.cpu.usage - 0.3) <
      0.0001,
  );
  assert.ok(
    f.calls.every(
      (x) => x.init.method === undefined && !x.path.includes("/host/stats"),
    ),
  );
});

test("primary quota is unlimited by default, persists independently and never erases preferences", async (t) => {
  const f = await fixture(t);
  f.store.setCamera("camera.fixture", { enabled: true });
  f.servers.update({ storageLimitBytes: 50 * 1024 ** 3 });
  assert.equal(f.config.max_storage_gb, 50);
  assert.equal(new Servers(f.options).policy.storageLimitBytes, 50 * 1024 ** 3);
  assert.equal(f.changed(), 1);
  assert.deepEqual(f.store.overrides()["camera.fixture"], { enabled: true });
  for (const patch of [
    {},
    { storageLimitBytes: -1 },
    { storageLimitBytes: "20" },
    { storageLimitBytes: Number.MAX_SAFE_INTEGER + 1 },
    { storageLimitBytes: null, enabled: true },
  ])
    assert.throws(() => f.servers.update(patch), /invalid_storage_limit/);
  f.servers.update({ storageLimitBytes: null });
  assert.equal(f.config.max_storage_gb, 0);
  assert.equal(new Servers(f.options).policy.storageLimitBytes, null);
});

test("unavailable supervisor and standalone never mislabel local container stats as remote HA host metrics", async (t) => {
  const f = await fixture(t, true);
  const primary = (await f.servers.status()).servers[0];
  assert.equal(f.calls.length, 0);
  assert.equal(primary.host.memory.totalBytes, null);
  assert.equal(primary.host.cpu.usage, null);
  assert.equal(primary.host.docker.available, false);
});

test("server API is authenticated and HA quota writes require client JSON", async (t) => {
  const f = await fixture(t, true);
  const api = createApi({
    ...f.options,
    servers: f.servers,
    recorder: { status: () => [] },
    getRegistry: () => ({ cameras: [], states: [] }),
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });
  const url = `http://127.0.0.1:${api.address().port}/api/servers`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { Authorization: "Bearer fixture-api" };
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(
    (
      await fetch(`${url}/home-assistant`, {
        method: "PATCH",
        headers,
        body: "{}",
      })
    ).status,
    400,
  );
  const response = await fetch(`${url}/home-assistant`, {
    method: "PATCH",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Haus-Client": "1",
    },
    body: JSON.stringify({ storageLimitBytes: null }),
  });
  assert.equal(response.status, 200);
});

test(
  "slow app statistics share a strict collection budget and concurrent clients share one sample",
  { timeout: 7000 },
  async (t) => {
    const f = await fixture(t);
    let statsCalls = 0;
    const servers = new Servers({
      ...f.options,
      fetcher: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === "/addons")
          return new Response(
            JSON.stringify({
              result: "ok",
              data: {
                addons: Array.from({ length: 64 }, (_, i) => ({
                  slug: `service_${i}`,
                  name: `Service ${i}`,
                  state: "started",
                })),
              },
            }),
          );
        if (path.startsWith("/addons/")) {
          statsCalls++;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response("{}")), 5000);
            init.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal.reason);
              },
              { once: true },
            );
          });
        }
        return new Response(JSON.stringify({ result: "ok", data: {} }));
      },
    });
    const started = performance.now();
    const [a, b] = await Promise.all([servers.status(), servers.status()]);
    assert.equal(a.servers[0].lastSeen, b.servers[0].lastSeen);
    assert.ok(
      performance.now() - started < 4000,
      "a dashboard read must not wait for 64 stalled app endpoints",
    );
    assert.ok(statsCalls <= 16);
    assert.equal(
      a.servers[0].host.docker.containers.length,
      65,
      "a sampling deadline cannot hide installed containers",
    );
    const calls = statsCalls;
    await servers.status();
    assert.equal(statsCalls, calls);
  },
);
