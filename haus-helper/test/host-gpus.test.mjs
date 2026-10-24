import test from "node:test";
import assert from "node:assert/strict";
import { homeAssistantGraphics } from "../lib/host-gpus.mjs";

test("HA lists unique render adapters, excluding display cards and private udev identifiers", async () => {
  const devices = [
    { subsystem: "drm", name: "card0" },
    {
      subsystem: "drm",
      name: "renderD128",
      attributes: { ID_SERIAL: "private" },
    },
    { subsystem: "drm", name: "renderD128" },
    { subsystem: "drm", name: "renderD129" },
    { subsystem: "drm", name: "../../private" },
  ];
  const paths = [];
  const report = await homeAssistantGraphics(
    { devices },
    {
      read: async (path) => {
        paths.push(path);
        return path.includes("128")
          ? "DRIVER=v3d\nOF_COMPATIBLE_0=brcm,bcm2711-v3d\nSERIAL=private"
          : "DRIVER=other";
      },
    },
  );
  assert.equal(report.adapters.length, 2);
  assert.equal(report.adapters[0].name, "brcm,bcm2711-v3d");
  assert.equal(report.adapters[0].driver, "v3d");
  assert.ok(
    report.adapters.every((g) => g.memoryBytes === null && g.kind === null),
  );
  assert.ok(!JSON.stringify(report).includes("private"));
  assert.deepEqual(paths, [
    "/sys/class/drm/renderD128/device/uevent",
    "/sys/class/drm/renderD129/device/uevent",
  ]);
});
test("missing hardware capability stays unavailable; blocked sysfs preserves a reported adapter without invented specs", async () => {
  assert.equal((await homeAssistantGraphics(null)).available, false);
  const result = await homeAssistantGraphics(
    { devices: [{ subsystem: "drm", name: "renderD128" }] },
    {
      read: async () => {
        throw Error("Denied");
      },
    },
  );
  assert.equal(result.available, true);
  assert.equal(result.adapters[0].name, "Graphics processor");
  assert.equal(result.adapters[0].driver, null);
});
