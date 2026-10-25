import test from "node:test";
import assert from "node:assert/strict";
import {
  deviceTreeInstalledMemory,
  linuxInstalledMemory,
  parseDmiInstalledMemory,
} from "../lib/host-memory.mjs";

function memoryDevice(size, length = 32) {
  const raw = Buffer.alloc(length);
  raw[0] = 17;
  raw[1] = length;
  raw.writeUInt16LE(size, 12);
  return raw;
}

function cell(value) {
  const raw = Buffer.alloc(4);
  raw.writeUInt32BE(value);
  return raw;
}

function cell64(value) {
  const raw = Buffer.alloc(8);
  raw.writeBigUInt64BE(BigInt(value));
  return raw;
}

test("sums installed SMBIOS memory module capacities and ignores empty slots", () => {
  assert.equal(
    parseDmiInstalledMemory([
      memoryDevice(8192),
      memoryDevice(8192),
      memoryDevice(0),
    ]),
    16 * 1024 ** 3,
  );
  assert.equal(parseDmiInstalledMemory([memoryDevice(0)]), null);
  assert.equal(parseDmiInstalledMemory([memoryDevice(0xffff)]), null);
});

test("reads nominal memory from ARM device-tree banks when SMBIOS is absent", async () => {
  const root = "/fixture/tree";
  const values = new Map([
    [`${root}/#address-cells`, cell(2)],
    [`${root}/#size-cells`, cell(2)],
    [`${root}/memory@0/reg`, Buffer.concat([cell64(0), cell64(4 * 1024 ** 3)])],
    [
      `${root}/memory@100000000/reg`,
      Buffer.concat([cell64(4 * 1024 ** 3), cell64(2 * 1024 ** 3)]),
    ],
  ]);
  const list = async (path) =>
    path === root
      ? ["#address-cells", "#size-cells", "memory@0", "memory@100000000"]
      : [];
  const read = async (path) => {
    if (!values.has(path)) throw new Error("not found");
    return values.get(path);
  };
  assert.equal(
    await deviceTreeInstalledMemory({ root, list, read }),
    6 * 1024 ** 3,
  );
  assert.equal(await linuxInstalledMemory({ list, read }), null);
});

test("Raspberry Pi nominal RAM comes from the documented board revision, never usable MemTotal", async () => {
  const { raspberryInstalledMemory } = await import("../lib/host-memory.mjs");
  assert.equal(
    raspberryInstalledMemory("Hardware : BCM2835\nRevision : c03112\n"),
    4 * 1024 ** 3,
  );
  assert.equal(
    raspberryInstalledMemory(
      "Model : Raspberry Pi 5 Model B\nRevision : e04171\n",
    ),
    16 * 1024 ** 3,
  );
  assert.equal(raspberryInstalledMemory("Revision : c03112\n"), null);
  assert.equal(
    raspberryInstalledMemory("Model : Raspberry Pi\nRevision : f04171\n"),
    null,
  );
  assert.equal(
    await linuxInstalledMemory({
      list: async () => [],
      read: async (path) =>
        path === "/proc/cpuinfo"
          ? "Hardware : BCM2835\nRevision : d03114\n"
          : Promise.reject(Error("missing")),
    }),
    8 * 1024 ** 3,
  );
});

test("restricted DMI can use a fresh boot-bound sanitized hardware probe; stale and partial data remain unknown", async () => {
  const at = Date.now();
  let record = {
    version: 1,
    installedBytes: 16 * 1024 ** 3,
    bootId: "boot",
    sampledAt: new Date(at).toISOString(),
  };
  const read = async (path) =>
    path === "/fixture/memory"
      ? JSON.stringify(record)
      : path === "/proc/sys/kernel/random/boot_id"
        ? "boot\n"
        : Promise.reject(Error("denied"));
  const options = {
    read,
    list: async () => [],
    hardwareFile: "/fixture/memory",
    now: () => at,
  };
  assert.equal(await linuxInstalledMemory(options), 16 * 1024 ** 3);
  record = { ...record, bootId: "other" };
  assert.equal(await linuxInstalledMemory(options), null);
  record = {
    ...record,
    bootId: "boot",
    sampledAt: new Date(at - 120001).toISOString(),
  };
  assert.equal(await linuxInstalledMemory(options), null);
  assert.equal(
    await linuxInstalledMemory({
      ...options,
      list: async (path) =>
        path === "/sys/firmware/dmi/entries" ? ["17-0", "17-1"] : [],
      read: async (path) =>
        path.endsWith("17-0/raw")
          ? memoryDevice(8192)
          : Promise.reject(Error("denied")),
    }),
    null,
  );
});
