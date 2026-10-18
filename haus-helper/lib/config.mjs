import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export const defaults = Object.freeze({
  recording_enabled: true,
  record_audio: true,
  pre_roll_seconds: 8,
  post_roll_seconds: 20,
  max_event_seconds: 300,
  retention_days: 7,
  max_storage_gb: 10,
  max_buffer_gb: 1,
});
export function validateOptions(input = {}) {
  const result = { ...defaults };
  const ranges = {
    pre_roll_seconds: [0, 30],
    post_roll_seconds: [5, 120],
    max_event_seconds: [30, 300],
    retention_days: [1, 90],
    max_storage_gb: [1, 1000],
    max_buffer_gb: [1, 10],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (input[key] !== undefined) {
      if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max)
        throw new Error(`Invalid ${key}`);
      result[key] = input[key];
    }
  }
  for (const key of ["recording_enabled", "record_audio"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean") throw new Error(`Invalid ${key}`);
      result[key] = input[key];
    }
  return result;
}
export async function loadConfig() {
  const data = resolve(process.env.HAUS_DATA || "/data");
  let input = {};
  try {
    input = JSON.parse(await readFile(`${data}/options.json`, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!process.env.SUPERVISOR_TOKEN && !process.env.HAUS_HA_TOKEN)
    throw new Error("Home Assistant authentication is missing");
  const standalone = process.env.HAUS_STANDALONE === "1";
  if (standalone && !process.env.HAUS_API_TOKEN)
    throw new Error("Standalone mode requires HAUS_API_TOKEN");
  const base = new URL(process.env.HAUS_HA_URL || "http://supervisor/core");
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("Invalid Home Assistant address");
  return {
    ...validateOptions(input),
    data,
    media: resolve(process.env.HAUS_MEDIA || "/media/haus"),
    base: base.href.replace(/\/$/, ""),
    ws: process.env.HAUS_HA_URL
      ? base.origin.replace(/^http/, "ws") + "/api/websocket"
      : "ws://supervisor/core/websocket",
    token: process.env.SUPERVISOR_TOKEN || process.env.HAUS_HA_TOKEN,
    standalone,
    apiToken: process.env.HAUS_API_TOKEN,
    port: Number(process.env.PORT || 8099),
  };
}
