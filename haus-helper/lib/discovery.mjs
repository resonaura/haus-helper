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
        enabled: overrides[state.entity_id]?.enabled !== false,
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
  for (const camera of cameras) {
    camera.aliases = [...aliasOwner]
      .filter(([, id]) => id === camera.id)
      .map(([id]) => id);
    camera.deviceIds = [
      camera.deviceId,
      ...camera.aliases.map((id) => registry.get(id)?.device_id),
    ].filter(Boolean);
  }
  for (const state of visible) {
    const kind = detectionKind(state);
    if (!kind) continue;
    const sensor = registry.get(state.entity_id) ?? {};
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
      source: "device",
    };
    if (own.length) {
      for (const camera of own) camera.sensors.push({ ...descriptor });
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
      ranked[0].camera.sensors.push({ ...descriptor, source: "name" });
    else
      for (const { camera } of ranked)
        camera.suggested.push({ ...descriptor, source: "suggestion" });
  }
  const byId = new Map(visible.map((state) => [state.entity_id, state]));
  for (const camera of cameras) {
    if (Array.isArray(camera.manualSensors))
      camera.sensors = camera.manualSensors.flatMap((id) => {
        const state = byId.get(id);
        const kind = state && detectionKind(state);
        return kind
          ? [
              {
                id,
                name: state.attributes.friendly_name ?? id,
                kind,
                active: state.state === "on",
                source: "manual",
              },
            ]
          : [];
      });
    delete camera.manualSensors;
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
