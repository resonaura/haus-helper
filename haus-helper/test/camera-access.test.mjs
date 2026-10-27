import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CameraAccessBootstrap,
  cameraAccessKey,
} from "../lib/camera-access.mjs";

test("bootstrap issues stable camera-only capabilities without exporting root/source credentials or starting standby decoders", async () => {
  const rootKey = "paired-root-key-with-at-least-32-bytes";
  const nodes = [
    {
      id: "a",
      key: rootKey,
      url: "http://192.168.5.117:8098",
      allowHttp: true,
      enabled: true,
      roles: ["stream"],
    },
    {
      id: "b",
      key: rootKey,
      url: "http://192.168.5.115:8098",
      enabled: true,
      roles: [],
    },
  ];
  const camera = {
    id: "camera.garden",
    available: true,
    batteryPowered: false,
    playbackSource: { manufacturer: "Aqara" },
  };
  const registry = {
    cameras: [camera],
    states: [
      {
        entity_id: "sensor.garden_p2p_rtsp_stream",
        state: "rtsp://user:source-private@192.168.5.3:8556/camera",
      },
    ],
    entities: [],
  };
  const calls = [];
  const access = new CameraAccessBootstrap({
    now: () => 100000000,
    sessions: {
      camera: () => camera,
      registry: () => registry,
      advertiseHost: async () => "192.168.5.117",
    },
    cluster: {
      nodes: () => nodes,
      health: new Map(
        nodes.map((node) => [
          node.id,
          {
            online: true,
            remote: {
              features: { directCameraAccess: true, cameraAccessPolicy: 1 },
            },
          },
        ]),
      ),
    },
    config: { pre_roll_seconds: 8, record_audio: true },
    json: async (node, path, input) => {
      calls.push({ node: node.id, path, data: input.data });
      return {
        id: input.data.id,
        cameraId: camera.id,
        expiresAt: input.data.expiresAt,
      };
    },
  });
  const client = "11111111-1111-4111-8111-111111111111";
  const a = access.bootstrap(camera.id, client),
    b = access.bootstrap(camera.id, client);
  assert.equal(a, b);
  const result = await a;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/camera-access");
  assert.equal(result.nodes.length, 1);
  assert.equal(
    result.nodes[0].key,
    cameraAccessKey(rootKey, result.nodes[0].id, camera.id, result.expiresAt),
  );
  assert.equal(JSON.stringify(result).includes(rootKey), false);
  assert.equal(JSON.stringify(result).includes("source-private"), false);
  assert.equal(JSON.stringify(result).includes("rtsp:"), false);
  const again = await access.bootstrap(camera.id, client);
  assert.deepEqual(again, result);
  registry.states.push({ entity_id: camera.id, state: "off" });
  await access.reconcile();
  assert.deepEqual(calls.at(-1).data, { cameras: [] });
  assert.equal(calls.at(-1).path, "/v1/camera-access/reconcile");
  camera.available = false;
  await assert.rejects(
    access.bootstrap(camera.id, client),
    /camera_unavailable/,
  );
  assert.throws(() => access.bootstrap(camera.id, "../bad"), /invalid/);
});
