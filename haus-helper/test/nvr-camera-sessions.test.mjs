import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  NvrCameraSessions,
  nvrCameraSource,
} from "../lib/nvr-camera-sessions.mjs";
import { Store } from "../lib/store.mjs";
import { Recorder } from "../lib/recorder.mjs";
import { defaults } from "../lib/config.mjs";
import { runMedia } from "../lib/media.mjs";

const owner = "test-owner-000000000000";
const camera = {
  id: "camera.garden",
  enabled: true,
  available: true,
  sensors: [],
  playbackSource: { platform: "mqtt", manufacturer: "Aqara" },
};
const state = (state) => ({
  entity_id: "sensor.garden_p2p_rtsp_stream",
  state,
});
const session = {
  id: randomUUID(),
  state: "ready",
  audio: true,
  capabilities: { webrtc: true, recording: true },
};
test("durable prebuffer follows its actual assigned node, retains outage context and revokes explicit Off without assigning standbys", async (t) => {
  const f = await fixture(t);
  for (const node of f.nodes)
    f.cluster.health.get(node.id).remote.features = { cameraContinuity: 1 };
  await f.sessions.ensure(f.registry.cameras[0], f.sessions.recordingOwner);
  f.registry.states.push({ entity_id: camera.id, state: "idle" });
  await f.sessions.syncContinuity(true);
  const policies = f.calls.filter(
    (call) => call.path === "/v1/camera-continuity",
  );
  assert.equal(policies.length, 2);
  const assigned = policies.find((call) => call.data.cameras.length);
  assert.ok(assigned);
  assert.equal(policies.filter((call) => call.data.cameras.length).length, 1);
  assert.equal(assigned.data.cameras[0].source.kind, "p2p-restream");
  const assignedNode = f.nodes.find((node) => node.id === assigned.node);
  assignedNode.enabled = false;
  await f.sessions.syncContinuity(true);
  assert.equal(
    f.calls
      .filter(
        (call) =>
          call.path === "/v1/camera-continuity" && call.node === assigned.node,
      )
      .at(-1).data.cameras.length,
    0,
  );
  assignedNode.enabled = true;
  f.registry.cameras[0].available = false;
  await f.sessions.syncContinuity(true);
  assert.equal(
    f.calls
      .filter(
        (call) =>
          call.path === "/v1/camera-continuity" && call.node === assigned.node,
      )
      .at(-1).data.cameras.length,
    1,
  );
  f.registry.states.find((state) => state.entity_id === camera.id).state =
    "off";
  await f.sessions.syncContinuity(true);
  assert.ok(
    f.calls
      .filter((call) => call.path === "/v1/camera-continuity")
      .slice(-2)
      .every((call) => call.data.cameras.length === 0),
  );
});
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "haus-camera-nvr-")),
    media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "db.sqlite"), media),
    config = { ...defaults, data: root, media };
  const registry = {
    cameras: [structuredClone(camera)],
    states: [state("rtsp://user:private@192.168.4.44:8556/live")],
    entities: [],
  };
  const nodes = [
    {
      id: "a",
      url: "http://192.168.5.117:8788",
      enabled: true,
      roles: ["stream"],
      allowHttp: true,
    },
    {
      id: "b",
      url: "http://192.168.5.115:8788",
      enabled: true,
      roles: ["stream"],
      allowHttp: true,
    },
  ];
  const cluster = {
    nodes: () => nodes,
    health: new Map(
      nodes.map((node, i) => [
        node.id,
        {
          online: true,
          remote: {
            rtspSessions: {
              profile: 1,
              active: i ? 0 : 2,
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
  const calls = [];
  const json = async (node, path, options) => {
    calls.push({ node: node.id, path, ...options });
    return session;
  };
  const request = async (node, path, options) => {
    calls.push({ node: node.id, path, ...options });
    return new Response("{}");
  };
  const sessions = new NvrCameraSessions({
    config,
    store,
    cluster,
    registry: () => registry,
    json,
    request,
    ...overrides,
  });
  t.after(async () => {
    await sessions.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    media,
    store,
    config,
    registry,
    nodes,
    cluster,
    calls,
    sessions,
  };
}
test("simultaneous owners open one shared producer without racing onto separate nodes", async (t) => {
  const firstStarted = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  const calls = [];
  const { sessions, cluster } = await fixture(t, {
    json: async (node) => {
      calls.push(node.id);
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return session;
    },
  });
  for (const health of cluster.health.values()) {
    health.remote.rtspSessions.active = 0;
    health.remote.rtspSessions.max = 1;
  }
  const first = sessions.touch(camera, owner, true);
  await firstStarted.promise;
  const second = sessions.touch(camera, owner + "-viewer", true);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map((r) => r.warm),
    [true, true],
  );
  assert.deepEqual(
    calls,
    ["a", "a"],
    "join the first producer, including when that node has no spare source slots",
  );
});

test("new owners reuse the warm camera producer even when another node is less loaded", async (t) => {
  const { sessions, cluster, calls } = await fixture(t);
  assert.equal((await sessions.touch(camera, owner, true)).warm, true);
  assert.equal(calls.at(-1).node, "b");
  cluster.health.get("a").remote.rtspSessions.active = 0;
  cluster.health.get("b").remote.rtspSessions.active = 1;
  assert.equal(
    (await sessions.touch(camera, owner + "-viewer", true)).warm,
    true,
  );
  assert.equal(
    calls.at(-1).node,
    "b",
    "attach the owner to the existing producer rather than open a duplicate on the freer node",
  );
  cluster.health.get("b").online = false;
  assert.equal(
    (await sessions.touch(camera, owner + "-replacement", true)).warm,
    true,
  );
  assert.equal(
    calls.at(-1).node,
    "a",
    "an offline producer still fails over to a healthy node",
  );
});

test("a viewer revalidates a recent warm lease and recreates a producer after node restart", async (t) => {
  const ids = [randomUUID(), randomUUID()];
  let generation = 0;
  const calls = [];
  const { sessions } = await fixture(t, {
    json: async (node, path, options) => {
      calls.push({ node: node.id, path, ...options });
      if (path === "/v1/cameras/sessions")
        return { ...session, id: ids[generation] };
      if (path.endsWith("/lease")) {
        if (!path.includes(ids[generation]))
          throw Error("camera_session_not_found");
        return { ...session, id: ids[generation] };
      }
      if (path.endsWith("/webrtc")) {
        if (!path.includes(ids[generation]))
          throw Error("camera_session_not_found");
        return {
          viewerId: randomUUID(),
          answer: { type: "answer", sdp: "v=0\r\n" },
        };
      }
      throw Error("unexpected_node_operation");
    },
  });
  await sessions.touch(camera, owner, true);
  generation = 1; // The node restarted immediately after the successful preheat.
  const viewer = await sessions.viewer(camera, owner, randomUUID(), "v=0\r\n");
  assert.equal(viewer.answer.type, "answer");
  assert.ok(
    calls.some((call) => call.path.endsWith("/lease")),
    "camera opening must not trust a cached session UUID after a restart",
  );
  assert.equal(sessions.entries.get(`${camera.id}:${owner}`).id, ids[1]);
});

test("only explicit protected P2P telemetry selects Aqara, never native RTSP, unrelated URLs, or HA HLS", () => {
  assert.deepEqual(
    nvrCameraSource(camera, {
      states: [state("rtsp://192.168.4.44:8556")],
      entities: [],
    }),
    { kind: "p2p-restream", url: "rtsp://192.168.4.44:8556" },
  );
  assert.throws(
    () =>
      nvrCameraSource(camera, {
        states: [
          {
            entity_id: "sensor.garden_rtsp_stream",
            state: "rtsp://192.168.4.44/native",
          },
        ],
        entities: [],
      }),
    /protected_p2p/,
  );
  assert.throws(
    () =>
      nvrCameraSource(camera, {
        states: [
          state("unavailable"),
          {
            entity_id: "sensor.garden_rtsp_stream",
            state: "rtsp://192.168.4.44/native",
          },
        ],
        entities: [],
      }),
    /source_unavailable/,
  );
  assert.throws(
    () =>
      nvrCameraSource(camera, {
        states: [state("rtsp://localhost/live")],
        entities: [],
      }),
    /not_reachable/,
  );
  assert.throws(
    () =>
      nvrCameraSource(camera, {
        states: [state("https://ha.local/api/hls/live")],
        entities: [],
      }),
    /source_unavailable/,
  );
});
test("Eufy keeps its explicitly configured RTSP route and never bypasses a registered P2P route", () => {
  const eufy = {
    ...camera,
    aliases: ["camera.garden_internal"],
    deviceIds: ["eufy-camera"],
    playbackSource: {
      platform: "eufy_security",
      manufacturer: "Eufy Security",
      model: "T8410C",
    },
  };
  const native = {
    entity_id: "sensor.garden_rtsp_stream_url",
    state: "rtsp://user:private@192.168.4.22/live",
  };
  const entry = { entity_id: native.entity_id, device_id: "eufy-camera" };
  const provider = {
    entity_id: "sensor.garden_stream_provider",
    state: "RTSP",
  };
  assert.deepEqual(
    nvrCameraSource(eufy, { states: [native, provider], entities: [entry] }),
    { kind: "rtsp", url: native.state },
  );
  assert.deepEqual(
    nvrCameraSource(eufy, {
      states: [
        native,
        { ...provider, state: "P2P" },
        state("rtsp://192.168.4.44/p2p"),
      ],
      entities: [entry],
    }),
    { kind: "p2p-restream", url: "rtsp://192.168.4.44/p2p" },
  );
  for (const registry of [
    { states: [native, provider, state("unavailable")], entities: [entry] },
    {
      states: [native, provider],
      entities: [
        entry,
        { entity_id: state("").entity_id, disabled_by: "user" },
      ],
    },
    {
      states: [native, provider],
      entities: [{ ...entry, disabled_by: "user" }],
    },
    {
      states: [
        { ...native, entity_id: "sensor.neighbor_rtsp_stream_url" },
        provider,
      ],
      entities: [],
    },
    {
      states: [{ ...native, state: "rtsp://8.8.8.8/live" }, provider],
      entities: [entry],
    },
  ])
    assert.throws(() => nvrCameraSource(eufy, registry), /source_unavailable/);
  assert.throws(
    () =>
      nvrCameraSource(eufy, {
        states: [{ ...native, state: "rtsp://127.0.0.1/live" }, provider],
        entities: [entry],
      }),
    /not_reachable/,
  );
  for (const providers of [
    [],
    [{ ...provider, state: "P2P" }],
    [{ ...provider, state: "unavailable" }],
    [{ ...provider, entity_id: "sensor.neighbor_stream_provider" }],
  ])
    assert.throws(
      () =>
        nvrCameraSource(eufy, {
          states: [native, ...providers],
          entities: [entry],
        }),
      /protected_p2p/,
    );
  assert.throws(
    () =>
      nvrCameraSource(eufy, {
        states: [native, provider],
        entities: [
          entry,
          { entity_id: provider.entity_id, disabled_by: "user" },
        ],
      }),
    /protected_p2p/,
  );
});
test("Eufy configured RTSP reaches an NVR without changing camera transport or exposing its source", async (t) => {
  const { sessions, registry, calls } = await fixture(t);
  registry.cameras[0].playbackSource = {
    platform: "eufy_security",
    manufacturer: "Eufy Security",
    model: "T8410C",
  };
  registry.cameras[0].aliases = ["camera.garden_internal"];
  registry.states = [
    {
      entity_id: "sensor.garden_rtsp_stream_url",
      state: "rtsp://user:private@192.168.4.22/live",
    },
    { entity_id: "sensor.garden_stream_provider", state: "RTSP" },
  ];
  const result = await sessions.touch(registry.cameras[0], owner, true);
  assert.equal(result.warm, true);
  assert.equal(result.transport, "nvr-webrtc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/cameras/sessions");
  assert.deepEqual(calls[0].data.source, {
    kind: "rtsp",
    url: registry.states[0].state,
  });
  assert.equal(calls[0].data.requireAudio, true);
  assert.ok(!JSON.stringify(result).includes("rtsp:"));
  assert.ok(!JSON.stringify(result).includes("private"));
});
test("least-loaded capable node receives exact source privately and warm response never includes credentials", async (t) => {
  const { sessions, calls } = await fixture(t);
  const result = await sessions.touch(camera, owner, true, true);
  assert.equal(result.transport, "nvr-webrtc");
  assert.equal(result.sessionId, session.id);
  assert.equal(calls[0].node, "b");
  assert.equal(calls[0].data.source.kind, "p2p-restream");
  assert.equal(
    calls[0].data.source.url,
    "rtsp://user:private@192.168.4.44:8556/live",
  );
  assert.equal(calls[0].data.advertiseHost, "192.168.5.115");
  assert.equal(calls[0].data.preRollSeconds, 8);
  assert.equal(calls[0].data.recordAudio, true);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.ok(!JSON.stringify(result).includes("rtsp:"));
});
test("prewarm allocation accounts for sessions opened since the last node-health poll", async (t) => {
  const requests = [];
  const { sessions, registry, cluster } = await fixture(t, {
    json: async (node, path, options) => {
      requests.push({ node: node.id, path, ...options });
      return { ...session, id: randomUUID() };
    },
  });
  for (const health of cluster.health.values())
    health.remote.rtspSessions.active = 0;
  const other = {
    ...camera,
    id: "camera.entry",
    playbackSource: { platform: "mqtt", manufacturer: "Aqara" },
  };
  registry.cameras.push(other);
  registry.states.push({
    entity_id: "sensor.entry_p2p_rtsp_stream",
    state: "rtsp://192.168.4.45:8556/live",
  });
  await sessions.touch(camera, owner, true);
  await sessions.touch(other, owner + "-entry", true);
  assert.deepEqual(
    requests
      .filter((call) => call.path === "/v1/cameras/sessions")
      .map((call) => call.node),
    ["a", "b"],
  );
  assert.equal(sessions.nodeReservations.size, 0);
});
test("unsupported or weak nodes return truthful no-NVR status; previews never wake battery or offline cameras", async (t) => {
  const { sessions, cluster, calls } = await fixture(t);
  for (const health of cluster.health.values())
    health.remote.rtspSessions.max = 0;
  assert.equal(
    (await sessions.touch(camera, owner, true)).reason,
    "camera_nvr_required",
  );
  assert.equal(
    (
      await sessions.touch(
        { ...camera, batteryPowered: true },
        owner,
        true,
        true,
      )
    ).reason,
    "camera_battery_preview_disabled",
  );
  assert.equal(
    (await sessions.touch({ ...camera, available: false }, owner, true)).reason,
    "camera_unavailable",
  );
  assert.equal(calls.length, 0);
});
test("release while a warm registration is pending cancels late ownership and sends explicit node release", async (t) => {
  let resolve;
  const { sessions, calls } = await fixture(t, {
    json: async () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = sessions.touch(camera, owner, true);
  await new Promise(setImmediate);
  await sessions.release(camera.id, owner);
  resolve(session);
  assert.equal((await pending).warm, false);
  assert.equal(sessions.entries.size, 0);
  assert.ok(
    calls.some(
      (call) => call.method === "DELETE" && call.path.endsWith(session.id),
    ),
  );
});
test("close before viewer creation tombstones the app UUID and deletes a late node viewer", async (t) => {
  let resolveOffer;
  const { sessions, calls } = await fixture(t, {
    json: async (_node, path) =>
      path.endsWith("/webrtc")
        ? new Promise((done) => {
            resolveOffer = done;
          })
        : session,
  });
  const viewerId = randomUUID();
  const pending = sessions.viewer(camera, owner, viewerId, "v=0\r\n");
  await new Promise(setImmediate);
  await sessions.closeViewer(camera.id, owner, viewerId);
  resolveOffer({
    viewerId: randomUUID(),
    answer: { type: "answer", sdp: "v=0\r\n" },
    candidates: [],
  });
  await assert.rejects(pending, /viewer_closed/);
  assert.equal(sessions.viewers.size, 0);
  assert.ok(
    calls.some(
      (call) => call.method === "DELETE" && call.path.includes("/viewers/"),
    ),
  );
  await assert.rejects(
    sessions.viewer(camera, owner, viewerId, "v=0\r\n"),
    /viewer_closed/,
  );
});
test("preview release cannot close an independent viewer and unavailable sources revoke current owners", async (t) => {
  const { sessions, calls, registry } = await fixture(t, {
    json: async (_node, path) =>
      path.endsWith("/webrtc")
        ? {
            viewerId: randomUUID(),
            answer: { type: "answer", sdp: "v=0\r\n" },
            candidates: [],
          }
        : session,
  });
  await sessions.touch(camera, owner + "-preview", true, true);
  await sessions.viewer(camera, owner, randomUUID(), "v=0\r\n");
  await sessions.touch(camera, owner + "-preview", false, true);
  assert.equal(sessions.viewers.size, 1);
  assert.ok(!calls.some((call) => call.path.includes("/viewers/")));
  registry.cameras[0].available = false;
  sessions.sync(registry.cameras);
  await new Promise(setImmediate);
  assert.equal(sessions.entries.size, 0);
});
test("recording input stays on NVR and matching late Activity Assist extends one journaled event", async (t) => {
  const { sessions, store, config } = await fixture(t);
  const recorder = new Recorder(
    config,
    {
      stream: () => {
        throw Error("HA HLS forbidden");
      },
    },
    store,
    undefined,
    { capture: sessions },
  );
  t.after(() => recorder.stop());
  recorder.sync([camera]);
  await sessions.tick();
  const at = Date.now(),
    event = recorder.trigger(camera.id, "motion", "hardware", at);
  await sessions.record(event);
  const extended = recorder.trigger(
    camera.id,
    "person",
    "haus_software_motion",
    at - 5000,
  );
  await sessions.record(extended);
  assert.equal(extended.id, event.id);
  assert.equal(sessions.events.get(event.id).startAt, at - 5000);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM nvr_camera_events").get().n,
    1,
  );
  assert.equal(recorder.buffers.get(camera.id).inputKind, "nvr-rtsp");
  assert.equal(recorder.buffers.get(camera.id).process, undefined);
});
test("capture diagnostics retain submission codes, throttle retries and never log remote secrets", async (t) => {
  const diagnostics = [];
  const error = Object.assign(
    Error("rtsp://private:secret@example.invalid/live"),
    { code: "camera_recording_busy", status: 503 },
  );
  const { sessions, store } = await fixture(t, {
    log: (event, fields) => diagnostics.push({ event, ...fields }),
    json: async (_node, path) => {
      if (path.endsWith("/recordings")) throw error;
      return session;
    },
  });
  const event = store.create(
    camera.id,
    "motion",
    Date.now(),
    Date.now() + 1000,
  );
  await assert.rejects(sessions.record(event), error);
  await assert.rejects(sessions.record(event), error);
  assert.deepEqual(diagnostics, [
    {
      event: "recording_operation_failed",
      eventId: event.id,
      cameraId: camera.id,
      phase: "submit",
      reason: "camera_recording_busy",
      status: 503,
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("secret"), false);
  assert.equal(sessions.eventPending.size, 0);
  assert.equal(sessions.events.size, 0);
});
test("diagnostic failures do not hide the original capture error or retain pending work", async (t) => {
  const failure = Error("camera_recording_busy");
  const { sessions, store } = await fixture(t, {
    log: () => {
      throw Error("logger failed");
    },
    json: async (_node, path) => {
      if (path.endsWith("/recordings")) throw failure;
      return session;
    },
  });
  const event = store.create(
    camera.id,
    "motion",
    Date.now(),
    Date.now() + 1000,
  );
  await assert.rejects(sessions.finalize(event), failure);
  assert.equal(sessions.eventPending.size, 0);
  assert.equal(sessions.events.size, 0);
});
test("a rejected storage reservation is reported as capacity, not corrupted media", async (t) => {
  const { sessions, store, config } = await fixture(t, {
    log: () => {},
    json: async (_node, path) => {
      if (path.endsWith("/recordings"))
        throw Object.assign(Error("Node returned 507"), {
          code: "storage_full",
          status: 507,
        });
      return session;
    },
  });
  const recorder = new Recorder(config, {}, store, undefined, {
    capture: sessions,
  });
  t.after(() => recorder.stop());
  sessions.sync([camera]);
  const event = store.create(
    camera.id,
    "motion",
    Date.now(),
    Date.now() + 1000,
  );
  await recorder.finish(event);
  assert.equal(store.get(event.id).status, "failed");
  assert.equal(
    store.get(event.id).error,
    "Free space on your recording server and try again.",
  );
});
test("verified NVR MP4 imports actual pre-roll/audio and ACKs only after catalog persistence", async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "haus-nvr-recording-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  const source = join(sourceRoot, "source.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    source,
  ]);
  const data = await readFile(source),
    digest = createHash("sha256").update(data).digest("hex"),
    at = Date.now();
  const result = {
    id: randomUUID(),
    state: "ready",
    bytes: data.length,
    sha256: digest,
    duration: 2,
    mediaStartAt: at - 8000,
    audio: true,
  };
  const calls = [];
  const { sessions, store } = await fixture(t, {
    json: async (_node, path) => (path.endsWith("/status") ? result : session),
    request: async (_node, path, options) => {
      calls.push({ path, ...options });
      return path.endsWith("/media")
        ? new Response(data, {
            headers: {
              "content-length": String(data.length),
              "content-type": "video/mp4",
            },
          })
        : new Response("{}");
    },
  });
  const event = store.create(camera.id, "motion", at, at + 1000);
  await sessions.record(event);
  await sessions.finalize(event);
  const saved = store.get(event.id);
  assert.equal(saved.status, "ready");
  assert.equal(saved.mediaStartAt, at - 8000);
  assert.equal(saved.playbackInfo.audio, true);
  assert.deepEqual(await readFile(store.path(event.id)), data);
  assert.ok(
    calls.some(
      (call) => call.method === "DELETE" && call.path.endsWith(event.id),
    ),
  );
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM nvr_camera_events").get().n,
    0,
  );
});
test("wrong digest cannot replace an existing recording or ACK the remote original", async (t) => {
  const calls = [];
  const { sessions, store } = await fixture(t, {
    json: async (_node, path) =>
      path.endsWith("/status")
        ? {
            state: "ready",
            bytes: 4,
            sha256: "a".repeat(64),
            duration: 2,
            mediaStartAt: Date.now() - 8000,
            audio: true,
          }
        : session,
    request: async (_node, path, options) => {
      calls.push({ path, ...options });
      return new Response("fail", { headers: { "content-length": "4" } });
    },
  });
  const event = store.create(
    camera.id,
    "motion",
    Date.now(),
    Date.now() + 1000,
  );
  await writeFile(store.path(event.id), "original");
  await sessions.record(event);
  await assert.rejects(sessions.finalize(event), /digest_mismatch/);
  assert.equal(await readFile(store.path(event.id), "utf8"), "original");
  assert.equal(store.get(event.id).status, "recording");
  assert.ok(
    !calls.some(
      (call) => call.method === "DELETE" && call.path.endsWith(event.id),
    ),
  );
});

test("late controller recovers a durable NVR original after its temporary session expired, pages past unrelated receipts and never captures it twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-durable-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "clip.mp4");
  await runMedia("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=16000",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-threads",
    "1",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    file,
  ]);
  const data = await readFile(file),
    sha256 = createHash("sha256").update(data).digest("hex");
  let at = Date.now(),
    receipt,
    acknowledgements = 0,
    store;
  const calls = [];
  const f = await fixture(t, {
    now: () => at,
    json: async (_node, path, options = {}) => {
      calls.push({ path, ...options });
      if (path === "/v1/camera-recordings")
        return {
          items: Array.from({ length: 16 }, () => ({
            ...receipt,
            event: { ...receipt.event, id: randomUUID() },
          })),
          nextCursor: "16",
        };
      if (path === "/v1/camera-recordings?cursor=16")
        return { items: [receipt], nextCursor: null };
      if (path === `/v1/camera-recordings/${receipt.event.id}`) {
        if (options.method === "POST") {
          assert.equal(
            store.get(receipt.event.id).status,
            "ready",
            "never ACK before durable Helper catalog update",
          );
          assert.deepEqual(await readFile(store.path(receipt.event.id)), data);
          acknowledgements++;
          return { acknowledged: true };
        }
        return receipt;
      }
      throw Error("camera_session_not_found");
    },
    request: async (_node, path, options) => {
      calls.push({ path, ...options });
      assert.equal(path, `/v1/blobs/${sha256}`);
      return new Response(data, {
        headers: { "content-length": String(data.length) },
      });
    },
  });
  store = f.store;
  f.cluster.health.get("a").remote.features = { cameraRecordingRecovery: 1 };
  const oldAt = at - 20 * 60000;
  const event = store.create(camera.id, "motion", oldAt, oldAt + 1000);
  store.finish(event.id, { status: "interrupted" });
  receipt = {
    state: "ready",
    event: {
      id: event.id,
      cameraId: event.cameraId,
      startAt: event.startAt,
      endAt: event.endAt,
      kinds: event.kinds,
    },
    bytes: data.length,
    sha256,
    duration: 2,
    mediaStartAt: oldAt - 8000,
    audio: true,
  };
  await f.sessions.recoverRecordings();
  assert.equal(acknowledgements, 0);
  at += 10001;
  await f.sessions.recoverRecordings();
  assert.equal(store.get(event.id).status, "ready");
  assert.equal(store.get(event.id).mediaStartAt, oldAt - 8000);
  assert.equal(store.get(event.id).playbackInfo.audio, true);
  assert.equal(acknowledgements, 1);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  assert.ok(
    calls.every((call) => !call.path.includes("/cameras/sessions")),
    "recovery must not attempt to record an old interval again",
  );
  at += 10001;
  await f.sessions.recoverRecordings();
  at += 10001;
  await f.sessions.recoverRecordings();
  assert.equal(acknowledgements, 2, "lost ACK can be repeated idempotently");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events").get().n, 1);
  const good = receipt.sha256;
  receipt.sha256 = "a".repeat(64);
  at += 10001;
  await f.sessions.recoverRecordings();
  at += 10001;
  await f.sessions.recoverRecordings();
  assert.equal(
    acknowledgements,
    2,
    "a conflicting original is never acknowledged or allowed to replace ready media",
  );
  receipt.sha256 = good;
});
