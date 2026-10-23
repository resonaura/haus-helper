import { CameraAvailability } from "./camera-availability.mjs";
import { RecentPlayback } from "./recent-playback.mjs";
import { WarmStreams } from "./warm-streams.mjs";
import { NvrCameraSessions } from "./nvr-camera-sessions.mjs";
import { Motion } from "./motion.mjs";
import { SharedConfig } from "./shared-config.mjs";
import { Backups } from "./backups.mjs";
import { Cluster } from "./cluster.mjs";
import { copyFile } from "node:fs/promises";
import { constants } from "node:fs";
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
try {
  await copyFile(
    join(config.data, "restore", "haus.sqlite"),
    join(config.data, "haus.sqlite"),
    constants.COPYFILE_EXCL,
  );
} catch (error) {
  if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
}
const store = new Store(join(config.data, "haus.sqlite"), config.media);
const ha = new HaClient(config);
const backups = new Backups(config, store);
await backups.initialize();
const shared = new SharedConfig(store, () => backups.markChanged());
const cluster = new Cluster(store, backups);
cluster.enableRecordingCache(config);
let registry = { states: [], entities: [], devices: [], cameras: [] };
let refreshing;
let dirty = false;
const cameraSessions = new NvrCameraSessions({ config, store, cluster, registry: () => registry });
const recorder = new Recorder(config, ha, store, undefined, {
  prepareRemote: (event, options) => cluster.preparePlayback(event, options),
  capture: cameraSessions,
});
const availability = new CameraAvailability();
const recentPlayback = new RecentPlayback(store, recorder, cluster);
const warm = new WarmStreams(ha, recorder, cluster, { sessions: cameraSessions });
const motion = new Motion({ ha, recorder, cluster, warm, config });
await motion.initialize();
const observeAvailability = () => {
  const at = Date.now();
  for (const camera of registry.cameras) {
    const state = registry.states.find(
      (item) => item.entity_id === camera.id,
    )?.state;
    store.observeAvailability(
      camera.id,
      !ha.connected
        ? "unknown"
        : camera.available
          ? "online"
          : !state || state === "unknown"
            ? "unknown"
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
  availability.apply(registry.cameras, registry.states, recorder.buffers);
  recorder.sync(registry.cameras);
  warm.sync(registry.cameras);
  motion.sync(registry.cameras);
  observeAvailability();
  if (config.recording_enabled)
    for (const camera of registry.cameras) {
      if (camera.available && camera.enabled && !recorder.active.has(camera.id))
        for (const sensor of camera.sensors.filter((item) => item.active)) {
          try {
            recorder.trigger(camera.id, sensor.kind, sensor.id);
          } catch {
            /* Recording budgets can pause new events without blocking discovery. */
          }
        }
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
  if (id.startsWith("camera."))
    availability.apply(registry.cameras, registry.states, recorder.buffers);
  for (const camera of registry.cameras) {
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
    warm.sync(registry.cameras);
    motion.sync(registry.cameras);
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
  cluster,
  backups,
  shared,
  warm,
  motion,
  cameraSessions,
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
  () =>
    void store
      .prune(config)
      .then(() => cluster.recordingCache.trim())
      .catch(() => {}),
  60000,
);
const maintenance = setInterval(
  () => void backups.tick().catch(() => {}),
  15000,
);
const distribution = setInterval(
  () =>
    void (async () => {
      await cluster.tick();
      await recentPlayback.tick();
    })().catch(() => {}),
  10000,
);
// Distribution can spend several seconds verifying/archive-copying media.  Keep
// the inexpensive admission check independent so an idle capable NVR can take
// the next old clip shortly after it finishes the previous one.  The worker
// itself still admits only one job and rejects pressured or undersized nodes.
const recentPreparation = setInterval(
  () => void recentPlayback.tick().catch(() => {}),
  2000,
);
const warming = setInterval(() => void warm.tick().catch(() => {}), 4000);
const detection = setInterval(() => void motion.tick().catch(() => {}), 4000);
const availabilityHeartbeat = setInterval(() => {
  if (availability.apply(registry.cameras, registry.states, recorder.buffers)) {
    recorder.sync(registry.cameras);
    warm.sync(registry.cameras);
    motion.sync(registry.cameras);
  }
  observeAvailability();
}, 2000);
let stopping = false;
async function stop() {
  clearInterval(retention);
  if (stopping) return;
  stopping = true;
  clearInterval(warming);
  clearInterval(detection);
  await motion.stop();
  await warm.stop();
  clearInterval(maintenance);
  clearInterval(distribution);
  clearInterval(recentPreparation);
  await cluster.stop();
  clearInterval(availabilityHeartbeat);
  clearInterval(retry);
  ha.stop();
  server.close();
  server.closeIdleConnections();
  await backups.stop();
  await recorder.stop();
  await cameraSessions.stop();
  store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
