import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store.mjs";
import { defaults } from "../lib/config.mjs";
import { AutonomousActivity } from "../lib/autonomous-activity.mjs";

test("explicit activity authority restores a full assigned worker, fences new-event adoption and unifies retried native triggers without command replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-activity-controller-"));
  await mkdir(join(root, "media"));
  const store = new Store(join(root, "db.sqlite"), join(root, "media"));
  let at = Date.now();
  const camera = {
    id: "camera.fixture",
    enabled: true,
    available: true,
    motionDetection: { enabled: true, mode: "objects" },
    playbackSource: { platform: "mqtt", manufacturer: "Aqara" },
  };
  const registry = {
    cameras: [camera],
    states: [
      {
        entity_id: "sensor.fixture_p2p_rtsp_stream",
        state: "rtsp://u:private@192.168.1.9:8556/live",
      },
    ],
    entities: [],
  };
  const nodes = [
    { id: "a", enabled: true, roles: ["stream"] },
    { id: "b", enabled: true, roles: ["stream"] },
  ];
  const cluster = {
    nodes: () => nodes,
    health: new Map(
      nodes.map((node) => [
        node.id,
        {
          online: true,
          remote: {
            features: { autonomousCameraActivity: 1 },
            cameraActivity: { cameras: [] },
          },
        },
      ]),
    ),
  };
  const sessions = {
    registry: () => registry,
    camera: (id) => registry.cameras.find((camera) => camera.id === id),
    advertiseHost: async () => "192.168.1.5",
  };
  const plans = new Map(),
    requests = [],
    captures = new Map();
  let lostAck = true;
  let interrupted = [];
  let holdNextPut = false;
  const putStarted = Promise.withResolvers(),
    releasePut = Promise.withResolvers();
  const json = async (node, path, options = {}) => {
    requests.push({ node: node.id, path, ...options });
    if (path === "/v1/camera-activity/interrupted")
      return { items: interrupted };
    if (
      path.startsWith("/v1/camera-activity/interrupted/") &&
      options.method === "POST"
    ) {
      interrupted = interrupted.filter(
        (value) => value.event.id !== path.split("/").at(-1),
      );
      return { acknowledged: true };
    }
    if (path === "/v1/camera-activity/trigger") {
      if (!captures.has(options.data.requestId))
        captures.set(options.data.requestId, randomUUID());
      if (lostAck) {
        lostAck = false;
        throw Error("ack_lost");
      }
      return { recordedEventId: captures.get(options.data.requestId) };
    }
    if (options.method === "PUT") {
      if (holdNextPut && options.data.cameras.length) {
        holdNextPut = false;
        putStarted.resolve();
        await releasePut.promise;
      }
      plans.set(node.id, options.data.cameras);
      cluster.health.get(node.id).remote.cameraActivity = {
        cameras: options.data.cameras.map((plan) => ({
          ...plan,
          admitted: true,
          ready: true,
          state: "running",
          calibrated: true,
          lastResultAt: at,
          events: [],
        })),
      };
    }
    return cluster.health.get(node.id).remote.cameraActivity;
  };
  let activity = new AutonomousActivity({
    store,
    config: { ...defaults },
    cluster,
    sessions,
    now: () => at,
    json,
  });
  t.after(async () => {
    await activity.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  camera.motionDetection.enabled = false;
  await assert.rejects(activity.ensure(camera, nodes[0]), /unavailable/);
  assert.equal(requests.length, 0);
  camera.motionDetection.enabled = true;
  const first = await activity.ensure(camera, nodes[0]);
  assert.equal(plans.get("a")[0].source.kind, "p2p-restream");
  assert.equal(first.mode, "objects");
  assert.equal(activity.priorNode(camera).id, "a");
  await activity.stop();
  activity = new AutonomousActivity({
    store,
    config: { ...defaults },
    cluster,
    sessions,
    now: () => at,
    json,
  });
  assert.equal(
    activity.priorNode(camera).id,
    "a",
    "controller restart must reattach rather than allocate another analysis worker",
  );
  assert.equal(
    (await activity.ensure(camera, nodes[0])).policyId,
    first.policyId,
  );
  const event = {
    id: randomUUID(),
    cameraId: camera.id,
    startAt: at,
    endAt: at + 20000,
    kinds: ["person"],
    origin: { kind: "camera-activity", policyId: first.policyId },
  };
  assert.equal(activity.authorizes(nodes[0], { event }), true);
  assert.equal(activity.authorizes(nodes[1], { event }), false);
  assert.equal(
    activity.authorizes(nodes[0], {
      event: { ...event, origin: { ...event.origin, policyId: randomUUID() } },
    }),
    false,
  );
  assert.equal(
    activity.authorizes(nodes[0], {
      event: { ...event, startAt: at - 86400000 },
    }),
    false,
  );
  assert.equal(
    activity.triggerNative(camera.id, "person", "native-camera-person", at),
    true,
  );
  await activity.flushing;
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM nvr_activity_triggers").get().n,
    1,
  );
  await activity.flushTriggers();
  assert.equal(
    captures.size,
    1,
    "retry uses identical recording intent, never another capture ID",
  );
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM nvr_activity_triggers").get().n,
    0,
  );
  assert.equal(requests.filter((r) => r.path.endsWith("/trigger")).length, 2);
  camera.available = false;
  await activity.sync();
  assert.equal(
    plans.get("a").length,
    1,
    "HA availability cannot revoke independent analysis",
  );
  camera.motionDetection.enabled = false;
  at += 1000;
  await activity.sync();
  assert.equal(plans.get("a").length, 0);
  assert.equal(activity.active(camera.id), undefined);
  assert.equal(
    activity.authorizes(nodes[0], { event }),
    true,
    "authorized historical capture remains recoverable after explicit Off",
  );
  assert.equal(
    activity.authorizes(nodes[0], {
      event: { ...event, startAt: at + 1, endAt: at + 20000 },
    }),
    false,
    "completion grace cannot authorize a new event after revocation",
  );
  assert.equal(
    activity.triggerNative(camera.id, "person", "native-camera-person", at),
    false,
  );
  const failedEvent = { ...event, id: randomUUID() };
  interrupted = [
    { event: failedEvent, state: "interrupted", error: "node_restarted" },
  ];
  await activity.recoverInterrupted();
  const failed = store.get(failedEvent.id);
  assert.equal(failed.status, "interrupted");
  assert.equal(failed.bytes, 0);
  assert.equal(failed.localOriginal, false);
  assert.equal(
    interrupted.length,
    0,
    "acknowledge only after the interrupted state is persisted under the original ID",
  );
  camera.motionDetection.enabled = true;
  await activity.ensure(camera, nodes[0]);
  holdNextPut = true;
  const updating = activity.syncNode(nodes[0], true);
  await putStarted.promise;
  const removing = activity.clearNode(nodes[0].id);
  await assert.rejects(activity.ensure(camera, nodes[0]), /unavailable/);
  releasePut.resolve();
  await updating;
  await removing;
  assert.equal(
    plans.get("a").length,
    0,
    "a late policy refresh cannot re-enable inference after acknowledged node revocation",
  );
  assert.equal(activity.active(camera.id), undefined);
});

async function handoffFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-activity-handoff-"));
  await mkdir(join(root, "media"));
  const store = new Store(join(root, "db.sqlite"), join(root, "media"));
  const at = Date.now();
  const camera = {
    id: "camera.fixture",
    enabled: true,
    motionDetection: { enabled: true, mode: "objects" },
  };
  const nodes = ["a", "b"].map((id) => ({
    id,
    enabled: true,
    roles: ["stream"],
  }));
  const cluster = {
    nodes: () => nodes,
    health: new Map(
      nodes.map((node) => [
        node.id,
        {
          online: true,
          remote: {
            features: { autonomousCameraActivity: 1 },
            cameraActivity: { cameras: [] },
          },
        },
      ]),
    ),
  };
  const registry = {
    cameras: [camera],
    entities: [],
    states: [
      {
        entity_id: "sensor.fixture_p2p_rtsp_stream",
        state: "rtsp://192.168.1.9:8556/live",
      },
    ],
  };
  const plans = new Map(),
    calls = [];
  const hooks = {};
  const options = {
    store,
    config: { ...defaults },
    cluster,
    now: () => at,
    sessions: {
      registry: () => registry,
      camera: (id) => registry.cameras.find((c) => c.id === id),
      advertiseHost: async () => "192.168.1.5",
    },
    json: async (node, path, input = {}) => {
      calls.push({ node: node.id, path, ...input });
      if (input.method === "PUT") {
        await hooks.beforePut?.(node, input.data.cameras);
        plans.set(node.id, input.data.cameras);
        cluster.health.get(node.id).remote.cameraActivity.cameras =
          input.data.cameras.map((p) => ({
            ...p,
            admitted: true,
            ready: true,
            state: "running",
          }));
        await hooks.afterPut?.(node, input.data.cameras);
      }
      if (path.endsWith("/interrupted")) return { items: [] };
      return cluster.health.get(node.id).remote.cameraActivity;
    },
  };
  let activity = new AutonomousActivity(options);
  t.after(async () => {
    await activity.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    camera,
    nodes,
    cluster,
    plans,
    calls,
    hooks,
    store,
    at,
    get activity() {
      return activity;
    },
    async restart() {
      await activity.stop();
      activity = new AutonomousActivity(options);
      return activity;
    },
  };
}

test("a reachable activity handoff drains a late old refresh before admitting its replacement", async (t) => {
  const f = await handoffFixture(t);
  const first = await f.activity.ensure(f.camera, f.nodes[0]);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let hold = true;
  f.hooks.beforePut = async (node, plans) => {
    if (hold && node.id === "a" && plans.length) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
  };
  const refreshing = f.activity.syncNode(f.nodes[0], true);
  await entered.promise;
  const moving = f.activity.ensure(f.camera, f.nodes[1]);
  // A microtask barrier observes the actual queued handoff, not a timer race.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.plans.has("b"), false);
  release.resolve();
  await refreshing;
  const replacement = await moving;
  assert.notEqual(replacement.policyId, first.policyId);
  const oldClear = f.calls.findIndex(
    (c) => c.node === "a" && c.method === "PUT" && !c.data.cameras.length,
  );
  const newStart = f.calls.findIndex(
    (c) => c.node === "b" && c.method === "PUT" && c.data.cameras.length,
  );
  assert.ok(oldClear >= 0 && newStart > oldClear);
  assert.equal(f.plans.get("a").length, 0);
  assert.equal(f.plans.get("b").length, 1);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM nvr_activity_releases").get().n,
    0,
  );
});

test("lost revocation acknowledgements survive controller restart; offline owners are cleared when they rejoin", async (t) => {
  const f = await handoffFixture(t);
  await f.activity.ensure(f.camera, f.nodes[0]);
  let fail = true;
  f.hooks.afterPut = (node, plans) => {
    if (fail && node.id === "a" && !plans.length) throw Error("ack_lost");
  };
  await assert.rejects(f.activity.ensure(f.camera, f.nodes[1]), /ack_lost/);
  assert.equal(
    f.plans.has("b"),
    false,
    "a known reachable old owner must acknowledge revocation first",
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM nvr_activity_releases").get().n,
    1,
  );
  await f.restart();
  fail = false;
  await f.activity.ensure(f.camera, f.nodes[1]);
  assert.equal(f.plans.get("a").length, 0);
  f.cluster.health.get("b").online = false;
  const prior = f.activity.active(f.camera.id);
  await f.activity.ensure(f.camera, f.nodes[0]);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM nvr_activity_releases").get().n,
    1,
  );
  assert.equal(
    f.plans.get("b").length,
    1,
    "unreachable policy has not magically been revoked remotely",
  );
  assert.equal(
    f.activity.authorizes(f.nodes[1], {
      event: {
        id: randomUUID(),
        cameraId: f.camera.id,
        origin: { kind: "camera-activity", policyId: prior.policy_id },
        startAt: f.at + 1,
        endAt: f.at + 10000,
        kinds: ["person"],
      },
    }),
    false,
  );
  f.cluster.health.get("b").online = true;
  await f.activity.sync();
  assert.equal(f.plans.get("b").length, 0);
  assert.equal(f.plans.get("a").length, 1);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM nvr_activity_releases").get().n,
    0,
  );
});
