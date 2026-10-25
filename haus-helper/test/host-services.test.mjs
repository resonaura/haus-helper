import test from "node:test";
import assert from "node:assert/strict";
import { homeAssistantServices } from "../lib/host-services.mjs";

test("HA host services expose the actual Supervisor units without inventing resource counters", () => {
  const report = homeAssistantServices(
    {
      services: [
        {
          name: "NetworkManager.service",
          description: "Network Manager",
          state: "active",
          environment: "secret",
        },
        { name: "fixture.service", state: "failed" },
        { description: "invalid" },
      ],
    },
    1000,
  );
  assert.equal(report.available, true);
  assert.equal(report.source, "supervisor");
  assert.equal(report.services.length, 2);
  assert.equal(report.services[0].id, "NetworkManager.service");
  assert.equal(report.services[0].cpuPercent, null);
  assert.equal(report.services[0].memoryBytes, null);
  assert.equal(report.services[1].status, "failed");
  assert.ok(!JSON.stringify(report).includes("secret"));
  assert.equal(homeAssistantServices(null, 1000).available, false);
});
