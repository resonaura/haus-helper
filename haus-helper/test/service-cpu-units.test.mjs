import test from "node:test";
import assert from "node:assert/strict";
import { HostTelemetry } from "../lib/host-telemetry.mjs";

test("Supervisor ready percentages and derived cumulative counters share whole-host CPU units", async () => {
  const telemetry = new HostTelemetry({});
  let payload = { cpu_percent: 25 };
  telemetry.supervisor = async () => payload;
  assert.equal((await telemetry.stats("/fixture")).cpu_percent, 25);
  telemetry.cpuSamples.set("/fixture", {
    usage: 100,
    system: 1000,
    at: Date.now() - 1000,
  });
  payload = {
    cpu_percent: null,
    cpu_usage: 300,
    cpu_system_usage: 1800,
    online_cpus: 8,
  };
  assert.equal((await telemetry.stats("/fixture")).cpu_percent, 25);
  telemetry.cpuSamples.set("/fixture", {
    usage: 100,
    system: 1000,
    at: Date.now() - 1000,
  });
  payload.online_cpus = 2;
  assert.equal((await telemetry.stats("/fixture")).cpu_percent, 25);
});
