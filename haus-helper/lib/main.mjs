import { join } from "node:path";
import { loadConfig } from "./config.mjs";
import { HaClient } from "./ha-client.mjs";
import { Store, prepareDirectories } from "./store.mjs";
import { Recorder } from "./recorder.mjs";
import {
  discoverCameras,
  isDetectionEvent,
  detectionKind,
} from "./discovery.mjs";
import { createApi } from "./server.mjs";
const config = await loadConfig();
await prepareDirectories(config);
const store = new Store(join(config.data, "haus.sqlite"), config.media);
const ha = new HaClient(config);
let registry = { states: [], entities: [], devices: [], cameras: [] };
let refreshing;
let dirty = false;
const recorder = new Recorder(config, ha, store);
const observeAvailability = () => {
  const at = Date.now();
  for (const camera of registry.cameras) {
    const state = registry.states.find(
      (item) => item.entity_id === camera.id,
    )?.state;
    store.observeAvailability(
      camera.id,
      !ha.connected || !state || state === "unknown"
        ? "unknown"
        : camera.available
          ? "online"
          : "offline",
      at,
    );
  }
};
const apply = () => {
  registry.cameras = discoverCameras(
    registry.states,
    registry.entities,
    registry.devices,
    store.overrides(),
  );
  recorder.sync(registry.cameras);
  observeAvailability();
  if (config.recording_enabled)
    for (const camera of registry.cameras) {
      if (camera.available && camera.enabled && !recorder.active.has(camera.id))
        for (const sensor of camera.sensors.filter((item) => item.active))
          recorder.trigger(camera.id, sensor.kind, sensor.id);
    }
};
const refresh = async () => {
  if (refreshing) {
    dirty = true;
    await refreshing;
    return;
  }
  refreshing = (async () => {
    do {
      dirty = false;
      const result = await ha.registry();
      registry = { ...result, cameras: [] };
      apply();
    } while (dirty);
  })().finally(() => {
    refreshing = undefined;
  });
  await refreshing;
};
ha.on("ready", () => {
  void refresh().catch(() =>
    console.warn("Camera discovery will retry after reconnection"),
  );
});
ha.on("status", () => {
  if (!ha.connected) observeAvailability();
});
ha.on("event", (event) => {
  if (event.event_type.endsWith("_registry_updated")) {
    void refresh().catch(() => {});
    return;
  }
  if (event.event_type !== "state_changed") return;
  const next = event.data.new_state;
  const previous = event.data.old_state;
  const id = event.data.entity_id;
  registry.states = next
    ? registry.states.some((state) => state.entity_id === id)
      ? registry.states.map((state) => (state.entity_id === id ? next : state))
      : [...registry.states, next]
    : registry.states.filter((state) => state.entity_id !== id);
  for (const camera of registry.cameras) {
    if (camera.id === id) {
      camera.available =
        next && !["unavailable", "unknown", "off"].includes(next.state);
    }
    for (const sensor of camera.sensors)
      if (sensor.id === id) sensor.active = next?.state === "on";
    if (
      camera.enabled &&
      camera.available &&
      next &&
      isDetectionEvent(previous, next) &&
      camera.sensors.some((sensor) => sensor.id === id)
    ) {
      try {
        recorder.trigger(camera.id, detectionKind(next), id);
      } catch {}
    }
  }
  if (id.startsWith("camera.")) {
    recorder.sync(registry.cameras);
    observeAvailability();
  }
});
const server = createApi({
  config,
  ha,
  store,
  recorder,
  getRegistry: () => registry,
  refresh,
});
await recorder.initialize();
ha.start();
server.listen(config.port, "0.0.0.0", () =>
  console.log(`Haus is listening on ${config.port}; recordings remain local`),
);
const retry = setInterval(() => {
  if (ha.connected) void refresh().catch(() => {});
}, 60000);
const retention = setInterval(
  () => void store.prune(config).catch(() => {}),
  60000,
);
const availabilityHeartbeat = setInterval(observeAvailability, 10000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(retention);
  clearInterval(availabilityHeartbeat);
  clearInterval(retry);
  ha.stop();
  server.close();
  server.closeIdleConnections();
  await recorder.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
