const rows = (value) => (Array.isArray(value) ? value : []);
const text = (value, fallback = null) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, 160) || fallback
    : fallback;
const count = (value) =>
  value !== null &&
  value !== undefined &&
  String(value).trim() !== "" &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : null;
const path = (value) =>
  typeof value === "string" && /^\/dev\/[a-zA-Z0-9_./-]{1,120}$/.test(value)
    ? value
    : null;
const role = (name, type) => {
  if (String(type).toLowerCase() === "c12a7328-f81f-11d2-ba4b-00a0c93ec93b")
    return "efi";
  return {
    "hassos-boot": "boot",
    "hassos-bootstate": "boot-state",
    "hassos-data": "data",
    "hassos-overlay": "overlay",
    "hassos-system0": "system",
    "hassos-system1": "system",
    "hassos-kernel0": "kernel",
    "hassos-kernel1": "kernel",
  }[name];
};
const mountPaths = (value) =>
  rows(value)
    .filter((x) => typeof x === "string" && x.startsWith("/"))
    .slice(0, 16)
    .map((x) => text(x));
const majorMinor = (device) => {
  const a = device?.attributes;
  return /^\d+$/.test(a?.MAJOR ?? "") && /^\d+$/.test(a?.MINOR ?? "")
    ? `${a.MAJOR}:${a.MINOR}`
    : null;
};
function mountedDevice(mountinfo, directory) {
  if (typeof directory !== "string" || !directory.startsWith("/")) return null;
  return (
    String(mountinfo)
      .split("\n")
      .slice(0, 4096)
      .flatMap((line) => {
        const parts = line.split(" ");
        const mount = parts[4]?.replace(/\\([0-7]{3})/g, (_m, value) =>
          String.fromCharCode(parseInt(value, 8)),
        );
        return mount &&
          /^\d+:\d+$/.test(parts[2]) &&
          (mount === "/" ||
            directory === mount ||
            directory.startsWith(mount + "/"))
          ? [{ device: parts[2], length: mount.length }]
          : [];
      })
      .sort((a, b) => b.length - a.length)[0]?.device ?? null
  );
}

/** Join UDisks filesystem inventory to udev's actual partition/parent metadata. */
export function homeAssistantDisks({
  hardware,
  diskInfo,
  hostInfo,
  media,
  mountinfo,
  mediaFilesystem,
}) {
  const devices = rows(hardware?.devices)
    .filter((d) => d?.subsystem === "block")
    .slice(0, 256);
  const byPath = new Map(
    devices.filter((d) => path(d.dev_path)).map((d) => [d.dev_path, d]),
  );
  const roots = new Map(
    devices
      .filter((d) => d.attributes?.DEVTYPE === "disk" && majorMinor(d))
      .map((d) => [majorMinor(d), d]),
  );
  const output = new Map();
  const dataDevice = mountedDevice(mountinfo, media);
  for (const drive of rows(hardware?.drives).slice(0, 32)) {
    const filesystems = rows(drive?.filesystems).slice(0, 128);
    const parents = new Set(
      filesystems.flatMap((fs) => {
        const device = byPath.get(fs.device);
        const parent =
          roots.get(device?.attributes?.ID_PART_ENTRY_DISK) ??
          (device?.attributes?.DEVTYPE === "disk" ? device : null);
        return parent ? [parent] : [];
      }),
    );
    if (parents.size !== 1) continue;
    const parent = [...parents][0],
      id = `ha-disk:${parent.dev_path}`;
    const physical = /^(?:sdio|usb|ata|sata|scsi|nvme|mmc)$/i.test(
      drive.connection_bus ?? "",
    )
      ? true
      : /virtual|virtio|qemu|vmware/i.test(drive.model ?? "")
        ? false
        : null;
    output.set(id, {
      id,
      name: text(drive.model, parent.name || "Disk"),
      kind: "disk",
      type: "disk",
      physical,
      parentId: null,
      parentIds: [],
      device: parent.dev_path,
      mountpoint: null,
      mountpoints: [],
      filesystem: null,
      totalBytes: count(drive.size),
      usedBytes: null,
      availableBytes: null,
      scope: "host",
    });
    const partitions = devices
      .filter(
        (d) =>
          d.attributes?.DEVTYPE === "partition" &&
          d.attributes.ID_PART_ENTRY_DISK === majorMinor(parent),
      )
      .sort(
        (a, b) =>
          (count(a.attributes.ID_PART_ENTRY_NUMBER) ?? Infinity) -
          (count(b.attributes.ID_PART_ENTRY_NUMBER) ?? Infinity),
      );
    for (const part of partitions) {
      if (output.size >= 128) break;
      const attrs = part.attributes,
        partId = `ha-partition:${part.dev_path}`;
      const fs = filesystems.find((fs) => fs.device === part.dev_path);
      const name = text(
        attrs.ID_FS_LABEL || attrs.ID_PART_ENTRY_NAME || fs?.name,
        part.name || "Partition",
      );
      const sectors = count(attrs.ID_PART_ENTRY_SIZE);
      const mounts = mountPaths(fs?.mount_points);
      const partitionRole = role(
        attrs.ID_PART_ENTRY_NAME,
        attrs.ID_PART_ENTRY_TYPE,
      );
      output.set(partId, {
        id: partId,
        name,
        kind: "volume",
        type: "partition",
        physical: false,
        parentId: id,
        parentIds: [id],
        device: part.dev_path,
        partitionNumber: count(attrs.ID_PART_ENTRY_NUMBER),
        ...(partitionRole ? { partitionRole } : {}),
        mountpoint: mounts[0] ?? null,
        mountpoints: mounts,
        filesystem: text(attrs.ID_FS_TYPE),
        totalBytes:
          sectors !== null && Number.isSafeInteger(sectors * 512)
            ? sectors * 512
            : count(fs?.size),
        usedBytes: null,
        availableBytes: null,
        scope: "host",
      });
      if (dataDevice && majorMinor(part) === dataDevice && mediaFilesystem) {
        const { blocks, bfree, bavail, bsize } = mediaFilesystem;
        const total = count(Number(blocks) * Number(bsize));
        const free = count(Number(bfree) * Number(bsize)),
          available = count(Number(bavail) * Number(bsize));
        if (total > 0 && free !== null && available !== null) {
          const volumeId = `ha-volume:${part.dev_path}`;
          output.set(volumeId, {
            id: volumeId,
            name: "Home Assistant data",
            kind: "volume",
            type: "volume",
            physical: false,
            parentId: partId,
            parentIds: [partId],
            device: part.dev_path,
            mountpoint: mounts[0] ?? null,
            mountpoints: mounts,
            filesystem: text(attrs.ID_FS_TYPE),
            totalBytes: total,
            usedBytes: Math.max(0, total - free),
            availableBytes: available,
            scope: "host",
          });
        }
      }
    }
  }
  if (output.size) return [...output.values()].slice(0, 128);
  // Older Supervisors may only expose the simpler disk list. Preserve it
  // without inventing partitions for an unavailable hardware capability.
  for (const disk of rows(diskInfo?.disks).slice(0, 32)) {
    const id = text(disk.id ?? disk.name);
    if (!id) continue;
    output.set(id, {
      id,
      name: text(disk.model ?? disk.name, "Disk"),
      kind: "disk",
      type: "disk",
      physical: null,
      parentId: null,
      mountpoint: null,
      filesystem: null,
      totalBytes: count(disk.size),
      usedBytes: null,
      availableBytes: null,
      scope: "host",
    });
    for (const part of rows(disk.partitions).slice(0, 32)) {
      const partId = text(part.uuid ?? part.device, `${id}-volume`);
      output.set(partId, {
        id: partId,
        name: text(part.label ?? part.device, "Volume"),
        kind: "volume",
        type: "partition",
        physical: false,
        parentId: id,
        mountpoint: null,
        filesystem: text(part.filesystem),
        totalBytes: count(part.size),
        usedBytes: null,
        availableBytes: null,
        scope: "host",
      });
    }
  }
  if (Number.isFinite(hostInfo?.disk_total))
    output.set("ha-data", {
      id: "ha-data",
      name: "Home Assistant data",
      kind: "volume",
      type: "volume",
      physical: false,
      parentId: null,
      mountpoint: null,
      filesystem: null,
      totalBytes: Math.round(hostInfo.disk_total * 1024 ** 3),
      usedBytes: Number.isFinite(hostInfo.disk_used)
        ? Math.round(hostInfo.disk_used * 1024 ** 3)
        : null,
      availableBytes: Number.isFinite(hostInfo.disk_free)
        ? Math.round(hostInfo.disk_free * 1024 ** 3)
        : null,
      scope: "host",
    });
  return [...output.values()].slice(0, 128);
}
