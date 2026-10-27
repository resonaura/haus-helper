import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store.mjs";
import { NvrCameraSessions } from "../lib/nvr-camera-sessions.mjs";

test("a dead source owner is skipped across cameras, a replacement viewer uses the healthy node, and cleanup preserves both identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "haus-failover-"));
  const store = new Store(":memory:", root),
    calls = [],
    releases = [];
  let now = 100000,
    failed = false;
  const nodes = ["a", "b"].map((id) => ({
    id,
    url: `http://192.168.5.${id === "a" ? 117 : 115}:8788`,
    enabled: true,
    roles: ["stream"],
  }));
  const registry = {
    cameras: ["garden", "pets"].map((id) => ({
      id: `camera.${id}`,
      available: true,
      enabled: true,
      sensors: [],
      playbackSource: { platform: "mqtt", manufacturer: "Aqara" },
    })),
    states: ["garden", "pets"].map((id) => ({
      entity_id: `sensor.${id}_p2p_rtsp_stream`,
      state: `rtsp://192.168.5.10:8556/${id}`,
    })),
    entities: [],
  };
  const cluster = {
    nodes: () => nodes,
    health: new Map(
      nodes.map((node) => [
        node.id,
        {
          online: true,
          remote: {
            rtspSessions: {
              profile: 1,
              active: 0,
              max: 4,
              webrtc: true,
              recording: true,
            },
            resources: { pressured: false },
          },
        },
      ]),
    ),
  };
  const ids = new Map();
  const controller = new NvrCameraSessions({
    config: {
      recording_enabled: true,
      pre_roll_seconds: 8,
      record_audio: true,
    },
    store,
    cluster,
    registry: () => registry,
    now: () => now,
    request: async (node, path, options) => {
      releases.push({ node: node.id, path, owner: options.data.owner });
      return new Response("{}");
    },
    json: async (node, path, options) => {
      calls.push({ node: node.id, path, timeout: options.timeout });
      if (node.id === "a" && failed)
        throw Object.assign(new Error("source private address omitted"), {
          name: "TimeoutError",
        });
      if (path.endsWith("/webrtc"))
        return {
          viewerId: randomUUID(),
          answer: { type: "answer", sdp: "v=0\r\nfixture" },
        };
      const camera = options.data.cameraId ?? path;
      const key = `${node.id}:${camera}`;
      if (!ids.has(key)) ids.set(key, randomUUID());
      return {
        id: ids.get(key),
        state: "ready",
        audio: true,
        capabilities: { webrtc: true, recording: true },
      };
    },
  });
  try {
    const first = await controller.ensure(
      registry.cameras[0],
      "fixture-viewer-owner-00001",
    );
    assert.equal(first.node.id, "a");
    now += 16000;
    failed = true;
    const next = await controller.ensure(
      registry.cameras[0],
      "fixture-viewer-owner-00001",
      false,
      undefined,
      true,
    );
    assert.equal(next.node.id, "b");
    assert.ok(
      releases.some(
        (item) => item.node === "a" && item.path.endsWith(first.id),
      ),
    );
    const failures = calls.filter((item) => item.node === "a").length;
    await controller.ensure(registry.cameras[1], "fixture-recording-owner-02");
    assert.equal(calls.filter((item) => item.node === "a").length, failures);
    assert.ok(calls.some((item) => item.node === "a" && item.timeout === 3500));
    const answer = await controller.viewer(
      registry.cameras[0],
      "fixture-viewer-owner-00001",
      randomUUID(),
      "v=0\r\nfixture",
    );
    assert.equal(answer.answer.type, "answer");
    assert.equal(calls.at(-1).node, "b");
    failed = false;
    now += 4000;
    assert.equal(controller.validNode(nodes[0]), true);
    assert.equal(
      (
        await controller.ensure(
          registry.cameras[0],
          "fixture-viewer-owner-00001",
        )
      ).node.id,
      "b",
    );
    controller.cameras = registry.cameras;
    controller.buffers.set("camera.garden", {
      status: "buffering",
      lastAdvance: now,
      stopped: false,
    });
    assert.equal(controller.sourceHealth()[0].available, true);
    now += 15001;
    assert.equal(controller.sourceHealth()[0].available, false);
    controller.buffers.get("camera.garden").lastAdvance = now;
    registry.cameras[0].available = false;
    assert.equal(controller.sourceHealth()[0].available, false);
  } finally {
    await controller.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
