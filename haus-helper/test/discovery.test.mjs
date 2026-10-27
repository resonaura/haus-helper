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
  assert.deepEqual(cameras[0].motionDetection, {
    enabled: false,
    mode: "objects",
  });
  assert.equal(cameras[0].enabled, false);
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

test("canonicalizes matching Generic wrappers and inherits their internal device detectors", () => {
  const states = [
    state("camera.outdoor", "Outdoor Camera"),
    state("camera.outdoor_internal", "Outdoor Camera Outdoor Camera Camera"),
    state("camera.outdoor_side", "Outdoor Side Camera"),
    state("binary_sensor.outdoor_pet", "Outdoor Pet Detected"),
    state("binary_sensor.outdoor_motion", "Outdoor Motion", "motion"),
  ];
  const entries = [
    { entity_id: "camera.outdoor", platform: "generic", device_id: "generic" },
    {
      entity_id: "camera.outdoor_internal",
      platform: "mqtt",
      device_id: "real",
    },
    { entity_id: "binary_sensor.outdoor_pet", device_id: "real" },
  ];
  const cameras = discoverCameras(states, entries, []);
  assert.equal(cameras.length, 2);
  assert.deepEqual(cameras[0].aliases, ["camera.outdoor_internal"]);
  assert.equal(
    cameras[0].sensors.find((item) => item.kind === "pet").source,
    "device",
  );
  assert.equal(
    cameras[0].sensors.find((item) => item.kind === "motion").source,
    "name",
  );
  assert.equal(cameras[1].sensors.length, 0);
});

test("a camera wrapper cannot make an unavailable physical source appear online", () => {
  const entries = [
    { entity_id: "camera.room", platform: "generic" },
    { entity_id: "camera.room_internal", platform: "tuya", device_id: "real" },
  ];
  for (const sourceState of [
    "unavailable",
    "unknown",
    "off",
    "idle",
    "streaming",
  ]) {
    const cameras = discoverCameras(
      [
        { ...state("camera.room", "Room Camera"), state: "idle" },
        {
          ...state("camera.room_internal", "Room Camera Internal"),
          state: sourceState,
        },
      ],
      entries,
      [],
      { "camera.room": { enabled: true } },
    );
    assert.equal(cameras.length, 1);
    assert.equal(
      cameras[0].available,
      ["idle", "streaming"].includes(sourceState),
    );
    assert.equal(cameras[0].enabled, true);
    assert.deepEqual(cameras[0].aliases, ["camera.room_internal"]);
  }
  const cameras = discoverCameras(
    [
      { ...state("camera.room", "Room Camera"), state: "unavailable" },
      {
        ...state("camera.room_internal", "Room Camera Internal"),
        state: "idle",
      },
    ],
    entries,
    [],
  );
  assert.equal(cameras[0].available, false);
});

test("battery warming policy uses physical aliases and ignores unassigned sensors", () => {
  const states = [
    state("camera.outdoor", "Outdoor"),
    state("camera.outdoor_internal", "Outdoor Internal"),
    state("camera.desk", "Desk"),
    state("sensor.outdoor_battery", "Battery", "battery"),
    state("sensor.unassigned_battery", "Battery", "battery"),
  ];
  const cameras = discoverCameras(
    states,
    [
      { entity_id: "camera.outdoor", platform: "generic" },
      { entity_id: "camera.outdoor_internal", device_id: "physical" },
      { entity_id: "sensor.outdoor_battery", device_id: "physical" },
    ],
    [],
  );
  assert.equal(
    cameras.find((camera) => camera.id === "camera.outdoor").batteryPowered,
    true,
  );
  assert.equal(
    cameras.find((camera) => camera.id === "camera.desk").batteryPowered,
    false,
  );
});

test("playback provenance follows one registered physical source through an explicit wrapper, never camera names", () => {
  const states = [
    state("camera.garden", "Garden"),
    state("camera.garden_internal", "Garden Internal"),
    state("camera.eufy_t8410c", "Eufy T8410C"),
  ];
  const entities = [
    { entity_id: "camera.garden", platform: "generic" },
    {
      entity_id: "camera.garden_internal",
      platform: "eufy_security",
      device_id: "physical",
    },
  ];
  const cameras = discoverCameras(states, entities, [
    { id: "physical", manufacturer: "Eufy Security", model: "T8410C" },
  ]);
  assert.deepEqual(
    cameras.find((c) => c.id === "camera.garden").playbackSource,
    {
      kind: "camera",
      platform: "eufy_security",
      manufacturer: "Eufy Security",
      model: "T8410C",
    },
  );
  assert.equal(
    cameras.find((c) => c.id === "camera.eufy_t8410c").playbackSource,
    undefined,
  );
});

test("unifies only the camera's matching Matter projection, preserving independent Hue motion", () => {
  const states = [
    state("camera.pigs", "Guinea Pigs Camera"),
    state(
      "binary_sensor.pigs_matter",
      "Guinea Pigs Camera Motion Sensor",
      "motion",
    ),
    state("binary_sensor.pigs_hue", "Guinea Pigs Motion Sensor", "motion"),
    {
      ...state(
        "binary_sensor.pigs_activity",
        "Guinea Pigs Camera Activity",
        "motion",
      ),
      attributes: {
        haus_activity_version: 1,
        haus_camera: "camera.pigs",
        device_class: "motion",
      },
    },
  ];
  const entities = [
    { entity_id: "camera.pigs", device_id: "camera", platform: "mqtt" },
    {
      entity_id: "binary_sensor.pigs_matter",
      device_id: "matter",
      platform: "matter",
    },
    { entity_id: "binary_sensor.pigs_hue", device_id: "hue", platform: "hue" },
  ];
  const devices = [
    { id: "camera", name: "Guinea Pigs Camera", manufacturer: "Aqara" },
    {
      id: "matter",
      name: "Guinea Pigs Camera Motion Sensor",
      manufacturer: "Aqara",
    },
    { id: "hue", name: "Guinea Pigs Motion Sensor", manufacturer: "Signify" },
  ];
  const [camera] = discoverCameras(states, entities, devices);
  assert.equal(
    camera.sensors.find((s) => s.id === "binary_sensor.pigs_matter")
      .cameraNative,
    true,
  );
  assert.equal(
    camera.sensors.find((s) => s.id === "binary_sensor.pigs_hue").cameraNative,
    false,
  );
  assert.equal(
    camera.sensors.find((s) => s.id === "binary_sensor.pigs_hue").independent,
    true,
  );
  assert.equal(
    camera.sensors.find((s) => s.id === "binary_sensor.pigs_matter")
      .independent,
    false,
  );
  assert.ok(!camera.sensors.some((s) => s.id.endsWith("_activity")));
  devices[1].manufacturer = "Another vendor";
  assert.equal(
    discoverCameras(states, entities, devices)[0].sensors.find(
      (s) => s.id === "binary_sensor.pigs_matter",
    ).cameraNative,
    false,
  );
});
