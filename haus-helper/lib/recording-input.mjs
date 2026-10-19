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
  const candidates = states.filter((state) => {
    const entry = entries.get(state.entity_id);
    return (
      !entry?.disabled_by &&
      /^sensor\..*_rtsp_stream(?:_url)?$/.test(state.entity_id) &&
      (stems.some(
        (stem) =>
          state.entity_id === `sensor.${stem}_p2p_rtsp_stream` ||
          state.entity_id === `sensor.${stem}_rtsp_stream` ||
          state.entity_id === `sensor.${stem}_rtsp_stream_url`,
      ) ||
        (entry?.device_id && devices.has(entry.device_id)))
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
