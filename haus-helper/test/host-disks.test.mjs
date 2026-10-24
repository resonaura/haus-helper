import test from "node:test";
import assert from "node:assert/strict";
import { homeAssistantDisks } from "../lib/host-disks.mjs";

const fixture = () => ({
  hardware: {
    drives: [
      {
        model: "SD128",
        size: 128000000000,
        connection_bus: "sdio",
        serial: "private",
        filesystems: [
          {
            device: "/dev/mmcblk0p1",
            name: "hassos-boot",
            size: 33554432,
            mount_points: ["/mnt/boot"],
          },
          {
            device: "/dev/mmcblk0p8",
            name: "hassos-data",
            size: 127000000000,
            mount_points: ["/mnt/data", "/var/lib/docker"],
          },
        ],
      },
    ],
    devices: [
      {
        subsystem: "block",
        name: "mmcblk0",
        dev_path: "/dev/mmcblk0",
        attributes: {
          DEVTYPE: "disk",
          MAJOR: "179",
          MINOR: "0",
          ID_SERIAL: "private",
        },
      },
      ...[
        {
          n: 1,
          name: "hassos-boot",
          fs: "vfat",
          type: "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
          sectors: "65536",
        },
        { n: 6, name: "hassos-bootstate", sectors: "16384" },
        { n: 8, name: "hassos-data", fs: "ext4", sectors: "248000000" },
      ].map((p) => ({
        subsystem: "block",
        name: `mmcblk0p${p.n}`,
        dev_path: `/dev/mmcblk0p${p.n}`,
        attributes: {
          DEVTYPE: "partition",
          MAJOR: "179",
          MINOR: String(p.n),
          ID_PART_ENTRY_DISK: "179:0",
          ID_PART_ENTRY_NUMBER: String(p.n),
          ID_PART_ENTRY_NAME: p.name,
          ID_PART_ENTRY_SIZE: p.sectors,
          ID_PART_ENTRY_TYPE: p.type,
          ID_FS_TYPE: p.fs,
          ID_SERIAL: "private",
        },
      })),
    ],
  },
  hostInfo: { disk_total: 120, disk_used: 60, disk_free: 60 },
  media: "/media/haus",
  mountinfo:
    "1 0 0:1 / / rw - overlay overlay rw\n2 1 179:8 /media /media rw - ext4 /dev/mmcblk0p8 rw\n",
  mediaFilesystem: { blocks: 10000, bfree: 4000, bavail: 3500, bsize: 4096 },
});

test("joins real udev parents with HA hardware filesystems and retains non-filesystem boot-state partitions", () => {
  const disks = homeAssistantDisks(fixture());
  assert.equal(disks.filter((d) => d.type === "disk").length, 1);
  assert.equal(disks[0].physical, true);
  assert.equal(disks[0].totalBytes, 128000000000);
  const efi = disks.find((d) => d.name === "hassos-boot");
  assert.equal(efi.partitionRole, "efi");
  assert.equal(efi.filesystem, "vfat");
  assert.equal(efi.mountpoint, "/mnt/boot");
  assert.equal(efi.partitionNumber, 1);
  assert.equal(efi.totalBytes, 33554432);
  const bootState = disks.find((d) => d.partitionRole === "boot-state");
  assert.equal(bootState.totalBytes, 8388608);
  assert.equal(bootState.filesystem, null);
  assert.equal(bootState.usedBytes, null);
  const data = disks.find((d) => d.type === "volume");
  assert.equal(data.parentId, "ha-partition:/dev/mmcblk0p8");
  assert.equal(data.totalBytes, 40960000);
  assert.equal(data.usedBytes, 24576000);
  assert.equal(data.availableBytes, 14336000);
  assert.deepEqual(data.mountpoints, ["/mnt/data", "/var/lib/docker"]);
  assert.equal(
    disks.some((d) => d.id === "ha-data"),
    false,
  );
  assert.ok(!JSON.stringify(disks).includes("private"));
});

test("never attaches rounded host data usage or a different mount's filesystem statistics to a partition", () => {
  const input = fixture();
  input.mountinfo += "3 1 8:17 / /media/haus rw - ext4 /dev/sdb1 rw\n";
  const disks = homeAssistantDisks(input);
  assert.equal(
    disks.some((d) => d.type === "volume"),
    false,
  );
  assert.ok(disks.every((d) => d.usedBytes === null));
  input.mountinfo = "";
  assert.ok(homeAssistantDisks(input).every((d) => d.usedBytes === null));
});

test("preserves separate physical devices and refuses ambiguous shared-drive associations", () => {
  const input = fixture();
  input.hardware.devices.push(
    {
      subsystem: "block",
      name: "sda",
      dev_path: "/dev/sda",
      attributes: { DEVTYPE: "disk", MAJOR: "8", MINOR: "0" },
    },
    {
      subsystem: "block",
      name: "sda1",
      dev_path: "/dev/sda1",
      attributes: {
        DEVTYPE: "partition",
        MAJOR: "8",
        MINOR: "1",
        ID_PART_ENTRY_DISK: "8:0",
        ID_PART_ENTRY_NUMBER: "1",
        ID_PART_ENTRY_SIZE: "1000",
      },
    },
  );
  input.hardware.drives.push({
    model: "External SSD",
    size: 1000000,
    connection_bus: "usb",
    filesystems: [{ device: "/dev/sda1" }],
  });
  assert.equal(
    homeAssistantDisks(input).filter((d) => d.type === "disk").length,
    2,
  );
  input.hardware.drives[0].filesystems.push({ device: "/dev/sda1" });
  assert.equal(
    homeAssistantDisks(input).filter((d) => d.type === "disk").length,
    1,
  );
});

test("older/denied hardware capability retains the actual fallback without inventing missing layouts or unknown usage", () => {
  const disks = homeAssistantDisks({
    hardware: null,
    diskInfo: {
      disks: [
        {
          id: "disk",
          size: 1000,
          partitions: [{ device: "/dev/sda1", size: 900, label: "Data" }],
        },
      ],
    },
    hostInfo: { disk_total: 100, disk_free: 0 },
  });
  assert.equal(disks[0].physical, null);
  assert.equal(disks[1].parentId, "disk");
  assert.equal(disks[1].filesystem, null);
  assert.equal(disks[2].usedBytes, null);
  assert.equal(disks[2].availableBytes, 0);
  assert.deepEqual(homeAssistantDisks({}), []);
  const input = fixture();
  input.hardware.devices[1].attributes.ID_PART_ENTRY_SIZE = "not-a-number";
  assert.equal(
    homeAssistantDisks(input).find((d) => d.partitionRole === "efi").totalBytes,
    33554432,
  );
});
