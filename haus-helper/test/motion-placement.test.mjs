import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisCandidates } from "../lib/motion-placement.mjs";
import { Motion } from "../lib/motion.mjs";

function fixture() {
  const nodes = ["busy", "idle"].map((id) => ({
    id,
    name: id,
    enabled: true,
    roles: ["stream"],
  }));
  const health = new Map(
    nodes.map((node) => [
      node.id,
      {
        online: true,
        remote: {
          relayOrigin: "http://helper.test",
          detectors: { supported: true, active: 0, max: 2 },
          resources: {
            cpu: node.id === "busy" ? 0.8 : 0.1,
            memoryBytes: 1024,
            memoryUsedBytes: 100,
            pressured: false,
          },
          streams: { active: 0, max: 2 },
        },
      },
    ]),
  );
  const motion = new Motion({
    cluster: { nodes: () => nodes, health },
    config: { recording_enabled: true },
    warm: { leases: new Map() },
    recorder: {},
  });
  const rank = () =>
    analysisCandidates(nodes, health, motion.jobs, motion.cooldowns, 1000).map(
      (n) => n.id,
    );
  return { nodes, health, motion, rank };
}

test("selects the least loaded eligible analysis node using CPU, memory and reserved slots", () => {
  const { health, motion, rank } = fixture();
  assert.deepEqual(rank(), ["idle", "busy"]);
  health.get("idle").remote.resources.memoryUsedBytes = 840;
  assert.deepEqual(rank(), ["busy", "idle"]);
  health.get("idle").remote.resources.memoryUsedBytes = 100;
  motion.jobs.set("camera.one", { node: { id: "idle" } });
  motion.jobs.set("camera.two", { node: { id: "idle" } });
  assert.deepEqual(rank(), ["busy"]);
  motion.jobs.clear();
  health.get("idle").remote.detectors.active = 2;
  assert.deepEqual(rank(), ["busy"]);
});

test("ignores disabled, storage-only, offline, pressured, unsupported and cooling-down nodes", () => {
  const { nodes, health, motion, rank } = fixture();
  for (const mutate of [
    () => (nodes[1].enabled = false),
    () => (nodes[1].roles = ["storage"]),
    () => (health.get("idle").online = false),
    () => (health.get("idle").remote.resources.pressured = true),
    () => (health.get("idle").remote.detectors.supported = false),
    () => (health.get("idle").remote.detectors.max = 0),
    () => motion.cooldowns.set("idle", 1500),
  ]) {
    mutate();
    assert.deepEqual(rank(), ["busy"]);
    nodes[1].enabled = true;
    nodes[1].roles = ["stream"];
    health.get("idle").online = true;
    health.get("idle").remote.resources.pressured = false;
    health.get("idle").remote.detectors = {
      supported: true,
      active: 0,
      max: 2,
    };
    motion.cooldowns.clear();
  }
  health.get("busy").remote.resources.cpu = 0.1;
  health.get("idle").remote.streams.active = 2;
  assert.deepEqual(rank(), ["busy", "idle"]);
});

test("reports the prospective and actual processor while analysis stays opt-in", () => {
  const { nodes, motion } = fixture();
  motion.sync([
    {
      id: "camera.test",
      enabled: true,
      available: true,
      motionDetection: { enabled: false, mode: "objects" },
    },
  ]);
  assert.deepEqual(motion.status("camera.test"), {
    fresh: false,
    state: "off",
    processor: "idle",
    placement: "nvr",
  });
  motion.jobs.set("camera.test", { local: true, worker: { state: "running" } });
  assert.equal(motion.status("camera.test").placement, "home");
  assert.equal(motion.status("camera.test").processor, "Home Assistant");
  motion.jobs.clear();
  nodes.length = 0;
  motion.localSupported = true;
  motion.capacity = { detectors: 1, pressured: false };
  assert.deepEqual(motion.status("camera.test"), {
    fresh: false,
    state: "off",
    processor: "Home Assistant",
    placement: "home",
    fallbackReason: "no_nodes",
  });
  motion.capacity.pressured = true;
  assert.equal(motion.status("camera.test").blocked, "capacity");
  motion.localSupported = false;
  assert.equal(motion.status("camera.test").blocked, "unsupported");
  assert.equal(motion.jobs.size, 0);
});

test("distinguishes unavailable nodes from a full cluster", () => {
  const { nodes, health, motion } = fixture();
  nodes.forEach((node) => (health.get(node.id).online = false));
  assert.equal(
    motion.status("camera.test").fallbackReason,
    "nodes_unavailable",
  );
  nodes.forEach((node) => {
    health.get(node.id).online = true;
    health.get(node.id).remote.detectors.active = 2;
  });
  assert.equal(motion.status("camera.test").fallbackReason, "nodes_busy");
  nodes.forEach((node) => (node.roles = ["storage"]));
  assert.equal(
    motion.status("camera.test").fallbackReason,
    "no_analysis_nodes",
  );
});

test("releases disabled remote assignments and pauses an overloaded local fallback", async () => {
  const { nodes, motion } = fixture();
  let at = 1000,
    stopped = 0;
  motion.now = () => at;
  motion.config.recording_enabled = true;
  motion.localSupported = true;
  motion.capacity = {
    detectors: 1,
    pressured: true,
    memoryUsed: 800,
    memory: 1024,
  };
  motion.sync([
    {
      id: "camera.test",
      enabled: true,
      available: true,
      motionDetection: { enabled: true, mode: "objects" },
    },
  ]);
  nodes.forEach((node) => (node.enabled = false));
  motion.jobs.set("camera.test", {
    local: true,
    mode: "objects",
    worker: { state: "running", stop: async () => stopped++ },
  });
  await motion.tick();
  assert.equal(stopped, 0);
  at += 21000;
  await motion.tick();
  assert.equal(stopped, 1);
  assert.equal(motion.jobs.size, 0);
  // A disabled node must release its active assignment before its remote API is polled.
  let released;
  motion.release = async (id) => {
    released = id;
    motion.jobs.delete(id);
  };
  motion.jobs.set("camera.test", { node: nodes[0], mode: "objects" });
  await motion.tick();
  assert.equal(released, "camera.test");
});
