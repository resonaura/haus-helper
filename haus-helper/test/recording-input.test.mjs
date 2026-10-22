import { test } from "node:test";
import assert from "node:assert/strict";
import { directRecordingInput } from "../lib/recording-input.mjs";
import { HaClient } from "../lib/ha-client.mjs";

const camera = {
  id: "camera.garden",
  aliases: ["camera.garden_internal"],
  deviceIds: ["physical"],
};
const state = (id, url) => ({ entity_id: `sensor.${id}`, state: url });
test("explicit local P2P input outranks a legacy URL and never crosses cameras", () => {
  const sources = [
    state("garden_rtsp_stream", "rtsp://192.168.1.2/legacy"),
    state("garden_p2p_rtsp_stream", "rtsp://192.168.1.2/live/garden"),
    state("neighbor_p2p_rtsp_stream", "rtsp://192.168.1.3/live/neighbor"),
  ];
  assert.equal(
    directRecordingInput(camera, sources, []),
    "rtsp://192.168.1.2/live/garden",
  );
  assert.equal(directRecordingInput(camera, [sources[2]], []), undefined);
  assert.equal(
    directRecordingInput(
      camera,
      [state("garden_rtsp_stream_url", "rtsps://garden.local/live")],
      [],
    ),
    "rtsps://garden.local/live",
  );
});
test("shared physical device is authoritative; ambiguity, disabled entries and remote URLs fall back to HA", () => {
  const shared = state("physical_rtsp_stream_url", "rtsp://camera.lan/live");
  const entry = { entity_id: shared.entity_id, device_id: "physical" };
  assert.equal(directRecordingInput(camera, [shared], [entry]), shared.state);
  assert.equal(
    directRecordingInput(camera, [shared], [{ ...entry, disabled_by: "user" }]),
    undefined,
  );
  assert.equal(
    directRecordingInput(
      camera,
      [shared, state("other_rtsp_stream", "rtsp://camera.lan/other")],
      [entry, { entity_id: "sensor.other_rtsp_stream", device_id: "physical" }],
    ),
    undefined,
  );
  for (const url of [
    "https://camera.lan/live",
    "rtsp://8.8.8.8/live",
    "rtsp://169.254.169.254/live",
    "rtsp://camera.example.com/live",
    "rtsp://camera.local/live#fragment",
  ])
    assert.equal(
      directRecordingInput(camera, [state("garden_rtsp_stream", url)], []),
      undefined,
    );
});
test("unavailable or disabled P2P telemetry cannot select a native camera transport", () => {
  const p2p = state("garden_p2p_rtsp_stream", "unavailable");
  const native = state("garden_native_rtsp_stream", "rtsp://camera.lan/native");
  const legacy = state("garden_rtsp_stream", "rtsp://camera.lan/legacy");
  const p2pEntry = { entity_id: p2p.entity_id, device_id: "physical" };
  const nativeEntry = { entity_id: native.entity_id, device_id: "physical" };
  const otherP2p = state("other_p2p_rtsp_stream", "rtsp://camera.lan/other");
  assert.equal(
    directRecordingInput(
      camera,
      [p2p, otherP2p],
      [p2pEntry, { entity_id: otherP2p.entity_id, device_id: "physical" }],
    ),
    undefined,
  );
  assert.equal(
    directRecordingInput(
      camera,
      [p2p, native, legacy],
      [p2pEntry, nativeEntry],
    ),
    undefined,
  );
  assert.equal(
    directRecordingInput(
      camera,
      [native, legacy],
      [{ ...p2pEntry, disabled_by: "user" }, nativeEntry],
    ),
    undefined,
  );
  assert.equal(
    directRecordingInput(
      camera,
      [{ ...p2p, state: "rtsp://camera.lan/p2p" }, native],
      [p2pEntry, nativeEntry],
    ),
    "rtsp://camera.lan/p2p",
  );
});
test("HA credentials are absent from direct input and fallback keeps the authenticated HLS path", async () => {
  const ha = new HaClient({ token: "ha-secret" });
  ha.inputRegistry = {
    states: [
      state("garden_rtsp_stream", "rtsp://user:camera-pass@camera.lan/live"),
    ],
    entities: [],
  };
  ha.stream = async (id) => {
    assert.equal(id, camera.id);
    return "http://ha.local/api/hls/example/index.m3u8";
  };
  const direct = await ha.recordingInput(camera);
  assert.equal(direct.kind, "rtsp");
  assert.deepEqual(direct.inputArguments, ["-rtsp_transport", "tcp"]);
  assert.ok(!JSON.stringify(direct).includes("ha-secret"));
  const fallback = await ha.recordingInput(camera, false);
  assert.equal(fallback.kind, "ha");
  assert.equal(fallback.token, "ha-secret");
  assert.ok(fallback.url.startsWith("http://ha.local/api/hls/"));
});

test("primary recovery discovery never starts HA media when direct telemetry is missing", () => {
  const ha = new HaClient({ token: "ha-secret" });
  ha.stream = () => {
    throw Error("recovery must not warm HA streams");
  };
  assert.equal(ha.primaryRecordingInput(camera), undefined);
  ha.inputRegistry = {
    states: [state("garden_rtsp_stream", "unavailable")],
    entities: [],
  };
  assert.equal(ha.primaryRecordingInput(camera), undefined);
});
