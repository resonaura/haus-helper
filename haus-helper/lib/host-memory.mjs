import { readdir, readFile } from "node:fs/promises";

const safeSize = (value) =>
  Number.isSafeInteger(value) && value > 0 ? value : null;

/** Sum reported SMBIOS Type 17 module capacities without exposing module IDs. */
export function parseDmiInstalledMemory(entries) {
  let foundDevice = false;
  let totalBytes = 0;
  for (const raw of entries) {
    if (!Buffer.isBuffer(raw) || raw[0] !== 17 || raw[1] < 14) continue;
    foundDevice = true;
    const size = raw.readUInt16LE(12);
    if (size === 0) continue;
    if (size === 0xffff) return null;
    if (size === 0x7fff) {
      if (raw[1] < 32) return null;
      const extendedMegabytes = raw.readUInt32LE(28) & 0x7fffffff;
      if (!extendedMegabytes) return null;
      totalBytes += extendedMegabytes * 1024 ** 2;
      continue;
    }
    totalBytes +=
      (size & 0x8000 ? size & 0x7fff : size) *
      (size & 0x8000 ? 1024 : 1024 ** 2);
  }
  return foundDevice ? safeSize(totalBytes) : null;
}

/** Raspberry Pi's documented new-style board revision encodes fitted RAM. */
export function raspberryInstalledMemory(cpuinfo) {
  if (
    !/^(?:Model\s*:\s*Raspberry Pi|Hardware\s*:\s*BCM\d+)/im.test(
      String(cpuinfo),
    )
  )
    return null;
  const revision = /^Revision\s*:\s*([a-f\d]{6,8})\s*$/im.exec(cpuinfo)?.[1];
  if (!revision) return null;
  const code = Number.parseInt(revision, 16);
  if (!(code & (1 << 23))) return null;
  const size = (code >>> 20) & 7;
  return size <= 6 ? 256 * 1024 ** 2 * 2 ** size : null;
}

async function readDeviceTreeCell(read, path) {
  try {
    const value = await read(path);
    return Buffer.isBuffer(value) && value.length >= 4
      ? value.readUInt32BE(0)
      : null;
  } catch {
    return null;
  }
}

/** Read physical memory banks from the device tree on systems without SMBIOS. */
export async function deviceTreeInstalledMemory({
  list = readdir,
  read = readFile,
  root = "/sys/firmware/devicetree/base",
} = {}) {
  const [names, addressCells, sizeCells] = await Promise.all([
    list(root).catch(() => []),
    readDeviceTreeCell(read, `${root}/#address-cells`),
    readDeviceTreeCell(read, `${root}/#size-cells`),
  ]);
  if (
    !Number.isInteger(addressCells) ||
    addressCells < 1 ||
    addressCells > 2 ||
    !Number.isInteger(sizeCells) ||
    sizeCells < 1 ||
    sizeCells > 2
  )
    return null;

  let total = 0n;
  for (const name of names) {
    if (!/^memory(?:@|$)/i.test(name)) continue;
    let reg;
    try {
      reg = await read(`${root}/${name}/reg`);
    } catch {
      continue;
    }
    const cells = addressCells + sizeCells,
      tupleBytes = cells * 4;
    if (!Buffer.isBuffer(reg) || !reg.length || reg.length % tupleBytes)
      continue;
    for (let offset = 0; offset < reg.length; offset += tupleBytes) {
      let size = 0n;
      for (let index = 0; index < sizeCells; index++)
        size =
          (size << 32n) |
          BigInt(reg.readUInt32BE(offset + (addressCells + index) * 4));
      total += size;
    }
  }
  return total > 0n && total <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(total)
    : null;
}

export async function linuxInstalledMemory({
  list = readdir,
  read = readFile,
  hardwareFile = "/var/lib/haus-host-telemetry/installed-memory.json",
  now = Date.now,
} = {}) {
  try {
    const entries = await list("/sys/firmware/dmi/entries");
    const devices = entries
      .filter((name) => /^17-[\da-f]+$/i.test(name))
      .slice(0, 128);
    if (devices.length) {
      const raw = await Promise.all(
        devices.map((name) =>
          read(`/sys/firmware/dmi/entries/${name}/raw`).catch(() => null),
        ),
      );
      const total = raw.every(Buffer.isBuffer)
        ? parseDmiInstalledMemory(raw)
        : null;
      if (total !== null) return total;
    }
  } catch {
    /* ARM systems commonly have no SMBIOS table. */
  }
  const pi = raspberryInstalledMemory(
    await read("/proc/cpuinfo", "utf8").catch(() => ""),
  );
  if (pi !== null) return pi;
  const tree = await deviceTreeInstalledMemory({ list, read });
  if (tree !== null) return tree;
  if (hardwareFile) {
    try {
      const [bytes, boot] = await Promise.all([
        read(hardwareFile, "utf8"),
        read("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      if (bytes.length > 1024) return null;
      const value = JSON.parse(bytes);
      const age = now() - Date.parse(value.sampledAt);
      if (
        value.version === 1 &&
        value.bootId === boot.trim() &&
        age >= -5000 &&
        age <= 120000
      )
        return safeSize(value.installedBytes);
    } catch {
      /* A privileged probe is optional; never estimate fitted DIMMs. */
    }
  }
  return null;
}
