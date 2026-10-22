import test from "node:test";
import assert from "node:assert/strict";
import { CameraAvailability } from "../lib/camera-availability.mjs";
import { discoverCameras } from "../lib/discovery.mjs";
function fixture() {
  let at = 1000;
  const policy = new CameraAvailability({ now: () => at, wallNow: () => at });
  const camera = { id: "camera.proxy", available: true, enabled: true };
  const states = [{ entity_id: camera.id, state: "idle" }];
  const buffer = { status: "buffering", lastAdvance: at };
  const buffers = new Map([[camera.id, buffer]]);
  const apply = () => policy.apply([camera], states, buffers);
  const advance = (ms, flowing = true) => {
    at += ms;
    if (flowing) buffer.lastAdvance = at;
  };
  apply();
  return { policy, camera, states, buffer, buffers, apply, advance };
}
test("brief proxy outages retain flowing recordings through registry refresh", () => {
  const f = fixture();
  f.states[0].state = "unavailable";
  f.advance(1000);
  f.apply();
  assert.equal(f.camera.available, true);
  f.advance(20_000);
  const replacement = { ...f.camera, available: false };
  f.policy.apply([replacement], f.states, f.buffers);
  assert.equal(replacement.available, true);
  f.states[0].state = "idle";
  f.apply();
  f.advance(60_000);
  f.apply();
  assert.equal(f.camera.available, true);
});
test("outages expire at 30 seconds even while fallback frames continue", () => {
  const f = fixture();
  f.states[0].state = "unavailable";
  f.apply();
  f.advance(29_999);
  f.apply();
  assert.equal(f.camera.available, true);
  f.advance(1);
  f.apply();
  assert.equal(f.camera.available, false);
  f.advance(60_000);
  f.apply();
  assert.equal(f.camera.available, false);
  f.states[0].state = "idle";
  f.apply();
  assert.equal(f.camera.available, true);
  f.states[0].state = "unavailable";
  f.apply();
  assert.equal(f.camera.available, true);
});
test("explicit off, disabled recording, and stalled producers stop immediately", () => {
  for (const reason of ["off", "disabled", "stale", "stopped"]) {
    const f = fixture();
    f.states[0].state = reason === "off" ? "off" : "unavailable";
    if (reason === "disabled") f.camera.enabled = false;
    if (reason === "stale") f.advance(10_001, false);
    if (reason === "stopped") f.buffer.stopped = true;
    f.apply();
    assert.equal(f.camera.available, false, reason);
  }
});
test("never-seen offline cameras stay offline and removed entries are forgotten", () => {
  const policy = new CameraAvailability();
  const camera = { id: "camera.absent", available: false, enabled: true };
  const states = [{ entity_id: camera.id, state: "unavailable" }];
  const buffers = new Map([
    [camera.id, { status: "buffering", lastAdvance: Date.now() }],
  ]);
  policy.apply([camera], states, buffers);
  assert.equal(camera.available, false);
  policy.apply([], [], buffers);
  assert.equal(policy.entries.size, 0);
});

test("a wall-clock correction cannot extend the monotonic outage deadline", () => {
  let clock = 0,
    wall = 100_000;
  const policy = new CameraAvailability({
    now: () => clock,
    wallNow: () => wall,
  });
  const camera = { id: "camera.clock", available: true, enabled: true };
  const states = [{ entity_id: camera.id, state: "idle" }];
  const buffer = { status: "buffering", lastAdvance: wall };
  const buffers = new Map([[camera.id, buffer]]);
  policy.apply([camera], states, buffers);
  states[0].state = "unavailable";
  policy.apply([camera], states, buffers);
  wall -= 3_600_000;
  clock += 30_001;
  buffer.lastAdvance = wall;
  policy.apply([camera], states, buffers);
  assert.equal(camera.available, false);
});

test("discovery and heartbeats never warm an offline physical source's idle wrapper", () => {
  const states = [
    {
      entity_id: "camera.room",
      state: "idle",
      attributes: { friendly_name: "Room" },
    },
    {
      entity_id: "camera.room_internal",
      state: "unavailable",
      attributes: { friendly_name: "Room Internal" },
    },
  ];
  const entities = [{ entity_id: "camera.room", platform: "generic" }];
  const overrides = { "camera.room": { enabled: true } };
  let at = 0;
  const policy = new CameraAvailability({ now: () => at, wallNow: () => at });
  for (const sourceState of ["unavailable", "unknown", "off", undefined]) {
    const current = sourceState
      ? states.map((state, index) =>
          index ? { ...state, state: sourceState } : state,
        )
      : states.slice(0, 1);
    // A missing source still remains a known alias between registry refreshes.
    const cameras = discoverCameras(states, entities, [], overrides);
    for (let tick = 0; tick < 3; tick++) {
      at += 60_000;
      policy.apply(cameras, current, new Map());
      assert.equal(cameras[0].available, false, String(sourceState));
      assert.equal(cameras[0].enabled, true);
    }
  }
  states[1].state = "streaming";
  const recovered = discoverCameras(states, entities, [], overrides);
  policy.apply(recovered, states, new Map());
  assert.equal(recovered[0].available, true);
});

test("physical source outages share the bounded grace even if the wrapper stays idle", () => {
  const f = fixture();
  f.camera.aliases = ["camera.source"];
  f.states.push({ entity_id: "camera.source", state: "streaming" });
  f.apply();
  f.states[1].state = "unavailable";
  f.apply();
  assert.equal(f.camera.available, true);
  f.advance(29_999);
  f.apply();
  assert.equal(f.camera.available, true);
  // Rediscovery and public wrapper updates must not restart the grace period.
  const replacement = { ...f.camera, available: false };
  f.advance(1);
  f.policy.apply([replacement], f.states, f.buffers);
  assert.equal(replacement.available, false);
  f.advance(60_000);
  f.apply();
  assert.equal(f.camera.available, false);
  f.states[1].state = "idle";
  f.apply();
  assert.equal(f.camera.available, true);
  f.states[1].state = "off";
  f.apply();
  assert.equal(f.camera.available, false);
});
