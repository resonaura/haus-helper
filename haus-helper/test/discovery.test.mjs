import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverCameras,
  detectionKind,
  isDetectionEvent,
} from "../lib/discovery.mjs";
const state = (id, name, cls) => ({
  entity_id: id,
  state: "off",
  attributes: { friendly_name: name, device_class: cls },
});
test("binds detectors to their own camera device, never a neighboring device", () => {
  const states = [
    state("camera.entry", "Entry"),
    state("camera.garden", "Garden"),
    state("binary_sensor.entry_motion", "Motion", "motion"),
    state("binary_sensor.entry_pet", "Pet detected"),
    state("binary_sensor.garden_motion", "Garden motion", "motion"),
  ];
  const entries = states.map((s) => ({
    entity_id: s.entity_id,
    device_id: s.entity_id.includes("garden") ? "garden" : "entry",
  }));
  const cameras = discoverCameras(states, entries, []);
  assert.deepEqual(
    cameras[0].sensors.map((sensor) => sensor.kind),
    ["motion", "pet"],
  );
  assert.equal(cameras[1].sensors.length, 1);
  assert.ok(cameras[0].sensors.every((sensor) => sensor.source === "device"));
});
test("matches a unique camera name but leaves ambiguous names as suggestions", () => {
  const states = [
    state("camera.patio", "Patio"),
    state("camera.bedroom_one", "Bedroom 1"),
    state("camera.bedroom_two", "Bedroom 2"),
    state("binary_sensor.patio_motion", "Patio motion", "motion"),
    state("binary_sensor.bedroom_motion", "Bedroom motion", "motion"),
  ];
  const cameras = discoverCameras(states, [], []);
  assert.equal(cameras[0].sensors[0].id, "binary_sensor.patio_motion");
  assert.equal(cameras[1].sensors.length, 0);
  assert.equal(cameras[2].sensors.length, 0);
  assert.equal(cameras[1].suggested.length, 1);
});
test("preserves explicit empty detector selection and disabled cameras", () => {
  const cameras = discoverCameras(
    [
      state("camera.entry", "Entry"),
      state("binary_sensor.entry_motion", "Entry motion", "motion"),
    ],
    [],
    [],
    { "camera.entry": { enabled: false, sensorIds: [] } },
  );
  assert.equal(cameras[0].enabled, false);
  assert.equal(cameras[0].sensorMode, "manual");
  assert.deepEqual(cameras[0].sensors, []);
});
test("ignores telemetry and only triggers on activation edges or event timestamps", () => {
  assert.equal(
    detectionKind(state("binary_sensor.motion_battery", "Motion battery")),
    undefined,
  );
  assert.equal(
    isDetectionEvent(
      { state: "on" },
      {
        ...state("binary_sensor.entry_motion", "Motion", "motion"),
        state: "on",
      },
    ),
    false,
  );
  assert.equal(
    isDetectionEvent(
      { state: "off" },
      {
        ...state("binary_sensor.entry_motion", "Motion", "motion"),
        state: "on",
      },
    ),
    true,
  );
  assert.equal(
    isDetectionEvent(
      { state: "unknown" },
      { ...state("event.doorbell", "Doorbell"), state: "2026-10-17T00:00:00Z" },
    ),
    false,
  );
  assert.equal(
    isDetectionEvent(
      { state: "2026-10-17T00:00:00Z" },
      { ...state("event.doorbell", "Doorbell"), state: "2026-10-17T00:01:00Z" },
    ),
    true,
  );
});
