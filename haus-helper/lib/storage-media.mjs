const transports = new Set([
  "ata",
  "sata",
  "sas",
  "scsi",
  "usb",
  "nvme",
  "mmc",
  "sdio",
  "sd",
  "ieee1394",
  "fc",
  "fcoe",
  "thunderbolt",
  "apple-fabric",
]);
const kinds = new Set([
  "hdd",
  "ssd",
  "solid-state",
  "flash",
  "sd",
  "mmc",
  "optical",
]);
export function sanitizeStorageMedia(value) {
  return {
    ...(transports.has(value?.transport) ? { transport: value.transport } : {}),
    ...(kinds.has(value?.mediaKind) ? { mediaKind: value.mediaKind } : {}),
    ...(typeof value?.removable === "boolean"
      ? { removable: value.removable }
      : {}),
    ...(typeof value?.hotplug === "boolean" ? { hotplug: value.hotplug } : {}),
  };
}

/** Only typed hardware evidence; labels/models never identify media types. */
export function storageMedia({
  transport,
  rotational,
  removable,
  hotplug,
  attributes = {},
  nativeMedia,
} = {}) {
  const bus = String(transport ?? "").toLowerCase();
  const flag = (key) => attributes[key] === "1";
  const sd =
    flag("ID_DRIVE_FLASH_SD") ||
    flag("ID_DRIVE_MEDIA_FLASH_SD") ||
    ["SD", "SDcombo"].includes(attributes.MMC_TYPE) ||
    bus === "sd";
  const mmc =
    attributes.MMC_TYPE === "MMC" ||
    flag("ID_DRIVE_FLASH_MMC") ||
    flag("ID_DRIVE_MEDIA_FLASH_MMC");
  const flash =
    flag("ID_DRIVE_THUMB") ||
    flag("ID_DRIVE_FLASH") ||
    flag("ID_DRIVE_MEDIA_FLASH");
  const mediaKind = sd
    ? "sd"
    : mmc
      ? "mmc"
      : flash
        ? "flash"
        : flag("ID_CDROM")
          ? "optical"
          : nativeMedia === "SSD"
            ? "ssd"
            : nativeMedia === "HDD"
              ? "hdd"
              : rotational === true
                ? "hdd"
                : rotational === false
                  ? ["ata", "sata", "nvme", "sas"].includes(bus)
                    ? "ssd"
                    : "solid-state"
                  : undefined;
  return sanitizeStorageMedia({
    transport: bus,
    mediaKind,
    removable,
    hotplug,
  });
}

export function udevMediaAttributes(value) {
  const allowed = new Set([
    "MMC_TYPE",
    "ID_DRIVE_THUMB",
    "ID_DRIVE_FLASH",
    "ID_DRIVE_MEDIA_FLASH",
    "ID_DRIVE_FLASH_SD",
    "ID_DRIVE_MEDIA_FLASH_SD",
    "ID_DRIVE_FLASH_MMC",
    "ID_DRIVE_MEDIA_FLASH_MMC",
    "ID_CDROM",
  ]);
  return Object.fromEntries(
    String(value)
      .split("\n")
      .flatMap((line) => {
        const match = /^E:([A-Z_]+)=([^\r\n]*)$/.exec(line);
        return match && allowed.has(match[1]) ? [[match[1], match[2]]] : [];
      }),
  );
}
