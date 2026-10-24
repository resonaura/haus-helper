import { readFile } from "node:fs/promises";
const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/[\x00-\x1f]/g, "")
        .trim()
        .slice(0, 180)
    : "";

/** Render nodes identify GPU adapters; display-only DRM cards are not GPUs. */
export async function homeAssistantGraphics(
  hardware,
  { read = readFile, now = Date.now } = {},
) {
  if (!Array.isArray(hardware?.devices))
    return { available: false, source: "unavailable", adapters: [] };
  const nodes = [
    ...new Map(
      hardware.devices
        .filter(
          (d) =>
            d?.subsystem === "drm" && /^renderD\d{1,5}$/.test(d.name ?? ""),
        )
        .map((d) => [d.name, d]),
    ).values(),
  ].slice(0, 16);
  const adapters = await Promise.all(
    nodes.map(async (node) => {
      const event = await read(
        `/sys/class/drm/${node.name}/device/uevent`,
        "utf8",
      ).catch(() => "");
      const fields = Object.fromEntries(
        String(event)
          .split("\n")
          .flatMap((line) => {
            const match = /^(DRIVER|OF_COMPATIBLE_0)=([^\r\n]*)$/.exec(line);
            return match ? [[match[1], text(match[2])]] : [];
          }),
      );
      const driver = fields.DRIVER || null;
      return {
        id: "ha-gpu:" + node.name,
        name:
          text(node.attributes?.ID_MODEL_FROM_DATABASE) ||
          fields.OF_COMPATIBLE_0 ||
          (driver ? driver.toUpperCase() + " graphics" : "Graphics processor"),
        vendor: text(node.attributes?.ID_VENDOR_FROM_DATABASE) || null,
        driver,
        kind: null,
        memoryBytes: null,
      };
    }),
  );
  return {
    available: true,
    source: "supervisor-drm",
    sampledAt: new Date(now()).toISOString(),
    adapters,
  };
}
