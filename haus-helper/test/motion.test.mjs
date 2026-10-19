import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Motion } from "../lib/motion.mjs";
import { motionSettings } from "../lib/motion-settings.mjs";
import { recordingMetadata } from "../lib/recording-metadata.mjs";
test("software detection is explicitly opted in and rejects unknown configuration", () => {
  assert.deepEqual(motionSettings({ enabled: false, mode: "objects" }), {
    enabled: false,
    mode: "objects",
  });
  for (const value of [
    null,
    {},
    { enabled: true, mode: "other" },
    { enabled: true, mode: "objects", url: "private" },
  ])
    assert.throws(() => motionSettings(value));
  const event = {
    id: "test",
    mediaStartAt: 100.2,
    startAt: 8100,
    endAt: 20000,
    duration: 20,
    detections: Array(500).fill({ kind: "person" }),
    playbackInfo: {
      audio: true,
      sourceGaps: Array(100).fill({ at: 2, duration: 3 }),
    },
  };
  const metadata = recordingMetadata(event);
  assert.equal(metadata.mediaStartAt, 100);
  assert.equal(metadata.playbackInfo.audio, true);
  assert.ok(JSON.stringify(metadata).length < 1000);
});
test("distributes by node capacity, deduplicates motion and reassigns failed workers without leaking leases", async (t) => {
  let at = 1000000,
    streams = 0,
    detections = 0;
  const nodes = [],
    health = new Map(),
    workers = [];
  const addNode = async (name, max) => {
    const jobs = new Map(),
      worker = { failed: false, jobs };
    const server = createServer(async (req, res) => {
      if (req.method === "POST") {
        for await (const _ of req) {
        }
        const id = randomUUID();
        jobs.set(id, {});
        return res.writeHead(201).end(JSON.stringify({ id }));
      }
      if (req.method === "DELETE") {
        jobs.delete(req.url.split("/").at(-1));
        return res.end("{}");
      }
      if (worker.failed) return res.writeHead(503).end("{}");
      res.end(
        JSON.stringify({
          state: "running",
          events: [{ sequence: 1, kind: "person", at }],
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    );
    const node = {
      id: name,
      name,
      enabled: true,
      roles: ["stream"],
      url: `http://127.0.0.1:${server.address().port}`,
      allowHttp: true,
      key: "fixture-only-private-key-long-enough",
    };
    nodes.push(node);
    workers.push(worker);
    health.set(name, {
      online: true,
      remote: {
        relayOrigin: "http://helper.test:8099",
        detectors: { supported: true, active: 0, max },
        resources: { pressured: false },
      },
    });
    return worker;
  };
  const weak = await addNode("weak", 1),
    strong = await addNode("strong", 2);
  const warm = { leases: new Map(), resource: () => "b".repeat(24) };
  const motion = new Motion({
    ha: {
      stream: async () => {
        streams++;
        return "http://ha.test/private";
      },
    },
    cluster: { nodes: () => nodes, health },
    recorder: { trigger: () => detections++ },
    warm,
    config: { recording_enabled: true },
    now: () => at,
  });
  t.after(() => motion.stop());
  const cameras = Array.from({ length: 4 }, (_, index) => ({
    id: `camera.test_${index}`,
    enabled: true,
    available: true,
    motionDetection: { enabled: false, mode: "objects" },
  }));
  motion.sync(cameras);
  await motion.tick();
  assert.equal(streams, 0);
  cameras.forEach((camera) => (camera.motionDetection.enabled = true));
  await motion.tick();
  assert.equal(weak.jobs.size, 1);
  assert.equal(strong.jobs.size, 2);
  assert.equal(streams, 3);
  await motion.tick();
  assert.equal(detections, 3);
  at += 4000;
  await motion.tick();
  assert.equal(detections, 3);
  weak.failed = true;
  const replacement = await addNode("replacement", 2);
  await motion.tick();
  assert.equal(weak.jobs.size, 0);
  assert.equal(replacement.jobs.size, 2);
  cameras.forEach((camera) => (camera.motionDetection.enabled = false));
  await motion.tick();
  assert.equal(motion.jobs.size, 0);
  assert.equal(warm.leases.size, 0);
});
