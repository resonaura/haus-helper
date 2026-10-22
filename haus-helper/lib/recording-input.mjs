import { isIP } from "node:net";

/** Only explicit stream telemetry for this camera may select a LAN source. */
export function directRecordingInput(camera, states, entities) {
  const entries = new Map(entities.map((entry) => [entry.entity_id, entry]));
  const stems = [camera.id, ...(camera.aliases ?? [])].map((id) =>
    id.split(".")[1].replace(/_internal$/, ""),
  );
  const devices = new Set(
    [camera.deviceId, ...(camera.deviceIds ?? [])].filter(Boolean),
  );
  const associated = (id) =>
    stems.some(
      (stem) =>
        id === `sensor.${stem}_p2p_rtsp_stream` ||
        id === `sensor.${stem}_rtsp_stream` ||
        id === `sensor.${stem}_rtsp_stream_url`,
    ) || devices.has(entries.get(id)?.device_id);
  // An unavailable or disabled P2P endpoint is not permission to change the
  // camera transport. HA fallback preserves its configured integration path.
  const p2p = [...states, ...entities].filter(
    (entry) =>
      /^sensor\..*_p2p_rtsp_stream$/.test(entry.entity_id) &&
      associated(entry.entity_id),
  );
  const exactP2p = p2p.filter((entry) =>
    stems.some((stem) => entry.entity_id === `sensor.${stem}_p2p_rtsp_stream`),
  );
  const p2pSources = new Set(
    (exactP2p.length ? exactP2p : p2p).map((entry) => entry.entity_id),
  );
  const candidates = states.filter((state) => {
    const entry = entries.get(state.entity_id);
    return (
      !entry?.disabled_by &&
      /^sensor\..*_rtsp_stream(?:_url)?$/.test(state.entity_id) &&
      (!p2pSources.size || p2pSources.has(state.entity_id)) &&
      associated(state.entity_id)
    );
  });
  let best = 0;
  const urls = new Set();
  for (const state of candidates) {
    try {
      const url = new URL(state.state);
      const host = url.hostname.toLowerCase();
      const local =
        (isIP(host) === 4 &&
          /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) ||
        host === "localhost" ||
        host.endsWith(".local") ||
        host.endsWith(".lan");
      if (
        ["rtsp:", "rtsps:"].includes(url.protocol) &&
        local &&
        !url.hash &&
        url.href.length <= 2048
      ) {
        const score = stems.some(
          (stem) => state.entity_id === `sensor.${stem}_p2p_rtsp_stream`,
        )
          ? 3
          : stems.some((stem) =>
                ["_rtsp_stream", "_rtsp_stream_url"].some(
                  (suffix) => state.entity_id === `sensor.${stem}${suffix}`,
                ),
              )
            ? 2
            : 1;
        if (score > best) urls.clear();
        if (score >= best) urls.add(url.href);
        best = Math.max(best, score);
      }
    } catch {}
  }
  // Ambiguous stream telemetry is left to HA, never guessed from room names.
  return urls.size === 1 ? [...urls][0] : undefined;
}
