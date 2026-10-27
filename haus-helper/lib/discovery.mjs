import { isHausActivity } from "./camera-activity.mjs";
const tokens = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(
      (value) =>
        value.length > 1 &&
        ![
          "camera",
          "motion",
          "detected",
          "sensor",
          "detection",
          "person",
          "pet",
          "animal",
          "occupancy",
          "human",
          "movement",
          "vehicle",
          "event",
        ].includes(value),
    );
export function detectionKind(entity) {
  if (isHausActivity(entity)) return undefined;
  const domain = entity.entity_id.split(".")[0];
  if (!["binary_sensor", "event"].includes(domain)) return undefined;
  const text =
    `${entity.entity_id} ${entity.attributes?.friendly_name ?? ""} ${entity.attributes?.device_class ?? ""}`.toLowerCase();
  if (
    /tamper|battery|sound|cry|online|connect|problem|update|privacy/.test(text)
  )
    return undefined;
  if (/doorbell|visitor|ringing/.test(text)) return "doorbell";
  if (/\b(pet|animal|dog|cat)\b/.test(text.replaceAll("_", " "))) return "pet";
  if (/person|human|people/.test(text)) return "person";
  if (/vehicle|car_detection/.test(text)) return "vehicle";
  if (/motion|occupancy|presence|movement/.test(text)) return "motion";
  return undefined;
}
/** A shared device is authoritative. Name matches require a unique winner; rooms alone never bind sensors. */
export function discoverCameras(states, entities, devices, overrides = {}) {
  const registry = new Map(entities.map((entry) => [entry.entity_id, entry]));
  const deviceMap = new Map(devices.map((device) => [device.id, device]));
  const visible = states.filter(
    (state) =>
      !registry.get(state.entity_id)?.disabled_by &&
      !registry.get(state.entity_id)?.hidden_by,
  );
  const allCameras = visible
    .filter((state) => state.entity_id.startsWith("camera."))
    .map((state) => {
      const entry = registry.get(state.entity_id) ?? {};
      const device = deviceMap.get(entry.device_id);
      return {
        id: state.entity_id,
        name:
          state.attributes.friendly_name ??
          device?.name_by_user ??
          device?.name ??
          state.entity_id,
        deviceId: entry.device_id,
        areaId: entry.area_id ?? device?.area_id,
        available: !["unavailable", "unknown", "off"].includes(state.state),
        sensors: [],
        suggested: [],
        enabled: overrides[state.entity_id]?.enabled === true,
        talkback: overrides[state.entity_id]?.talkback,
        motionDetection: overrides[state.entity_id]?.motionDetection ?? {
          enabled: false,
          mode: "objects",
        },
        sensorMode: Array.isArray(overrides[state.entity_id]?.sensorIds)
          ? "manual"
          : "automatic",
        manualSensors: overrides[state.entity_id]?.sensorIds,
      };
    });
  // A Generic/Proxy camera explicitly paired with its `_internal` entity is a
  // presentation wrapper. Keep the stream-capable public entity and inherit its
  // underlying device's detectors instead of buffering the same video twice.
  const aliasOwner = new Map();
  for (const camera of allCameras) {
    if (!camera.id.endsWith("_internal")) continue;
    const publicId = camera.id.slice(0, -9);
    const primary = allCameras.find((item) => item.id === publicId);
    if (
      !primary ||
      !["generic", "proxy", "template"].includes(
        registry.get(publicId)?.platform,
      )
    )
      continue;
    const names = (item) =>
      [...new Set(tokens(item.name).filter((token) => token !== "internal"))]
        .sort()
        .join(" ");
    if (names(primary) === names(camera)) aliasOwner.set(camera.id, publicId);
  }
  const cameras = allCameras.filter((camera) => !aliasOwner.has(camera.id));
  const cameraNative = (camera, sensorDevice) => {
    if (!sensorDevice) return false;
    if (camera.deviceIds?.includes(sensorDevice.id)) return true;
    const normalize = (value) =>
      String(value ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const physical =
      camera.deviceIds
        ?.map((id) => deviceMap.get(id))
        .filter(
          (device) =>
            device?.manufacturer &&
            !["Generic", "Home Assistant"].includes(device.manufacturer),
        ) ?? [];
    return physical.some(
      (device) =>
        normalize(device.manufacturer) ===
          normalize(sensorDevice.manufacturer) &&
        [device.name, device.name_by_user]
          .filter(Boolean)
          .some(
            (name) =>
              normalize(sensorDevice.name_by_user ?? sensorDevice.name) ===
              normalize(`${name} Motion Sensor`),
          ),
    );
  };
  for (const camera of cameras) {
    camera.aliases = [...aliasOwner]
      .filter(([, id]) => id === camera.id)
      .map(([id]) => id);
    // A Generic wrapper may keep serving a generated offline image while its
    // physical source is gone. Do not warm or record that placeholder.
    camera.available &&= camera.aliases.every(
      (id) => allCameras.find((source) => source.id === id)?.available,
    );
    camera.deviceIds = [
      camera.deviceId,
      ...camera.aliases.map((id) => registry.get(id)?.device_id),
    ].filter(Boolean);
    const sources = [camera.id, ...camera.aliases].flatMap((id) => {
      const entry = registry.get(id),
        device = deviceMap.get(entry?.device_id);
      return device &&
        entry &&
        !["generic", "proxy", "template"].includes(entry.platform)
        ? [
            {
              kind: "camera",
              platform: entry.platform,
              manufacturer: device.manufacturer,
              model: device.model,
            },
          ]
        : [];
    });
    // A unique registered physical source supplies identity; names and rooms never confer trust.
    const identities = [
      ...new Map(
        sources.map((source) => [JSON.stringify(source), source]),
      ).values(),
    ];
    camera.playbackSource = identities.length === 1 ? identities[0] : undefined;
    camera.batteryPowered = states.some(
      (sensor) =>
        camera.deviceIds.includes(registry.get(sensor.entity_id)?.device_id) &&
        sensor.attributes?.device_class === "battery",
    );
  }
  for (const state of visible) {
    if (isHausActivity(state, registry.get(state.entity_id))) continue;
    const kind = detectionKind(state);
    if (!kind) continue;
    const sensor = registry.get(state.entity_id) ?? {};
    if (
      sensor.platform === "group" &&
      Array.isArray(state.attributes.entity_id)
    ) {
      const owners = new Set();
      for (const member of state.attributes.entity_id.slice(0, 64)) {
        const memberDevice = deviceMap.get(registry.get(member)?.device_id);
        for (const camera of cameras)
          if (cameraNative(camera, memberDevice)) owners.add(camera.id);
      }
      // A mixed-camera room group is not this camera's physical detector.
      // Explicit manual links below remain the user's choice.
      if (owners.size > 1) continue;
    }
    const device = deviceMap.get(sensor.device_id);
    const areaId = sensor.area_id ?? device?.area_id;
    const own = cameras.filter(
      (camera) =>
        sensor.device_id && camera.deviceIds.includes(sensor.device_id),
    );
    const descriptor = {
      id: state.entity_id,
      name: state.attributes.friendly_name ?? state.entity_id,
      kind,
      active: state.state === "on",
      available: !["unknown", "unavailable"].includes(state.state),
      source: "device",
    };
    if (own.length) {
      for (const camera of own)
        camera.sensors.push({ ...descriptor, cameraNative: true });
      continue;
    }
    const names = tokens(
      state.entity_id + " " + state.attributes.friendly_name,
    );
    const ranked = cameras
      .map((camera) => {
        const cameraTokens = tokens(camera.id + " " + camera.name);
        const shared = new Set(
          cameraTokens.filter((token) => names.includes(token)),
        ).size;
        return {
          camera,
          score:
            shared * 10 -
            (new Set(cameraTokens).size - shared) * 2 +
            (areaId && camera.areaId === areaId ? 2 : 0),
        };
      })
      .filter((item) => item.score >= 6)
      .sort((a, b) => b.score - a.score);
    if (ranked.length && (!ranked[1] || ranked[0].score > ranked[1].score))
      ranked[0].camera.sensors.push({
        ...descriptor,
        source: "name",
        cameraNative: cameraNative(ranked[0].camera, device),
        independent: Boolean(device && !cameraNative(ranked[0].camera, device)),
      });
    else
      for (const { camera } of ranked)
        camera.suggested.push({ ...descriptor, source: "suggestion" });
  }
  const byId = new Map(visible.map((state) => [state.entity_id, state]));
  for (const camera of cameras) {
    if (Array.isArray(camera.manualSensors))
      camera.sensors = camera.manualSensors.flatMap((id) => {
        const state = byId.get(id);
        const kind =
          state &&
          !isHausActivity(state, registry.get(id)) &&
          detectionKind(state);
        return kind
          ? [
              {
                id,
                name: state.attributes.friendly_name ?? id,
                kind,
                active: state.state === "on",
                available: !["unknown", "unavailable"].includes(state.state),
                source: "manual",
                cameraNative: cameraNative(
                  camera,
                  deviceMap.get(registry.get(id)?.device_id),
                ),
                independent: Boolean(
                  deviceMap.get(registry.get(id)?.device_id) &&
                  !cameraNative(
                    camera,
                    deviceMap.get(registry.get(id)?.device_id),
                  ),
                ),
              },
            ]
          : [];
      });
    delete camera.manualSensors;
    // A HA group made solely from this camera's verified native sensors is
    // another projection of that sensor, not another physical motion device.
    for (const sensor of camera.sensors) {
      const members = byId.get(sensor.id)?.attributes?.entity_id;
      if (
        registry.get(sensor.id)?.platform === "group" &&
        Array.isArray(members) &&
        members.length &&
        members.every((id) =>
          camera.sensors.some(
            (source) => source.id === id && source.cameraNative,
          ),
        )
      )
        sensor.cameraNative = true;
    }
  }
  return cameras;
}
export function isDetectionEvent(previous, next) {
  const kind = next && detectionKind(next);
  if (!kind || ["unknown", "unavailable"].includes(next.state)) return false;
  if (next.entity_id.startsWith("event."))
    return Boolean(
      previous &&
      previous.state !== next.state &&
      !["unknown", "unavailable"].includes(previous.state),
    );
  return next.state === "on" && previous?.state !== "on";
}
