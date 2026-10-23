import test from "node:test";
import assert from "node:assert/strict";
import { HostTelemetry } from "../lib/host-telemetry.mjs";

test("one-shot Supervisor counters measure container CPU across polls without adding request latency", async () => {
  let sample = {
    cpu_usage: 100,
    cpu_system_usage: 1000,
    online_cpus: 4,
    cpu_percent: null,
  };
  const calls = [];
  const telemetry = new HostTelemetry(
    { standalone: false },
    {
      fetcher: async (url) => {
        calls.push(new URL(url).pathname + new URL(url).search);
        return Response.json({ result: "ok", data: sample });
      },
    },
  );
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  sample = { ...sample, cpu_usage: 125, cpu_system_usage: 2000 };
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, 10);
  assert.deepEqual(calls, [
    "/core/stats?one_shot=true",
    "/core/stats?one_shot=true",
  ]);
  // A restart, repeated sample or missing counters must never invent a busy CPU.
  sample = { ...sample, cpu_usage: 1, cpu_system_usage: 3000 };
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  sample = { cpu_percent: null, memory_usage: 2000 };
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  sample = {
    cpu_usage: 50,
    cpu_system_usage: 4000,
    online_cpus: 4,
    cpu_percent: null,
  };
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  sample = { ...sample, cpu_percent: 3.35 };
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, 3.35);
});

test("container CPU history is isolated and expires instead of spanning a stale interval", async () => {
  const telemetry = new HostTelemetry(
    { standalone: false },
    {
      fetcher: async () =>
        Response.json({
          result: "ok",
          data: {
            cpu_usage: 200,
            cpu_system_usage: 2000,
            online_cpus: 2,
            cpu_percent: null,
          },
        }),
    },
  );
  telemetry.cpuSamples.set("/core/stats", {
    usage: 100,
    system: 1000,
    at: Date.now() - 61000,
  });
  assert.equal((await telemetry.stats("/core/stats")).cpu_percent, null);
  assert.equal(
    (await telemetry.stats("/addons/other/stats")).cpu_percent,
    null,
  );
});
