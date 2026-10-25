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

test("sums installed SMBIOS module capacities and ignores empty slots", () => {
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

test("reads nominal RAM from ARM device-tree banks when SMBIOS is absent", async () => {
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
