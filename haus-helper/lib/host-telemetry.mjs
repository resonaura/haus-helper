import { readFile } from "node:fs/promises";

const nullableNumber = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, fallback = null) =>
  typeof value === "string" ? value.slice(0, 240) : fallback;
const unavailable = () => ({
  available: false,
  source: "unavailable",
  containers: [],
});

/** Linux's CPU and memory proc counters describe the kernel host, not this container's limits. */
export function parseHostProc(stat, meminfo, uptime) {
  const times = /^cpu\s+([\d\s]+)$/m
    .exec(stat)?.[1]
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .map(Number);
  const fields = Object.fromEntries(
    [...meminfo.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)].map((m) => [
      m[1],
      Number(m[2]) * 1024,
    ]),
  );
  const total = fields.MemTotal;
  const available =
    fields.MemAvailable ?? fields.MemFree + fields.Buffers + fields.Cached;
  return {
    cpuTimes:
      times?.length === 8 && times.every(Number.isFinite)
        ? { total: times.reduce((a, b) => a + b, 0), idle: times[3] + times[4] }
        : null,
    logicalCores: [...stat.matchAll(/^cpu\d+\s/gm)].length || null,
    memory: {
      totalBytes: nullableNumber(total),
      availableBytes: nullableNumber(available),
      usedBytes: nullableNumber(total - available),
    },
    swap: {
      supported: Number.isFinite(fields.SwapTotal),
      totalBytes: nullableNumber(fields.SwapTotal),
      usedBytes: nullableNumber(fields.SwapTotal - fields.SwapFree),
    },
    uptimeSeconds: nullableNumber(Number(uptime.trim().split(/\s/)[0])),
  };
}

const container = (id, name, info, stats, state = "running") => ({
  id,
  name: text(name, id),
  image: text(info?.image),
  state: text(state, "unknown"),
  status: text(state, "unknown"),
  cpuPercent: nullableNumber(stats?.cpu_percent),
  memoryUsedBytes: nullableNumber(stats?.memory_usage),
  memoryLimitBytes: nullableNumber(stats?.memory_limit),
});

export class HostTelemetry {
  constructor(config, { fetcher = fetch, read = readFile } = {}) {
    Object.assign(this, { config, fetcher, read });
    this.appStats = new Map();
    this.appCursor = 0;
  }
  async supervisor(path) {
    if (this.config.standalone) return null;
    try {
      const response = await this.fetcher(`http://supervisor${path}`, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(1500, (this.deadline ?? Infinity) - Date.now())),
        ),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const body = await response.text();
      if (body.length > 1000000) return null;
      const value = JSON.parse(body);
      return value.result === "ok" ? value.data : null;
    } catch {
      return null;
    }
  }
  async stats(path) {
    return (
      (await this.supervisor(`${path}?one_shot=true`)) ??
      (Date.now() < this.deadline ? await this.supervisor(path) : null)
    );
  }
  async collect(at) {
    this.deadline = Date.now() + 2500;
    const [info, core, stats, apps, diskInfo, files] = await Promise.all([
      this.supervisor("/host/info"),
      this.supervisor("/core/info"),
      this.stats("/core/stats"),
      this.supervisor("/addons"),
      this.supervisor("/host/disks"),
      this.config.standalone
        ? null
        : Promise.all(
            ["stat", "meminfo", "uptime", "cpuinfo", "loadavg"].map((name) =>
              this.read(`/proc/${name}`, "utf8"),
            ),
          ).catch(() => null),
    ]);
    const proc = files ? parseHostProc(...files) : null;
    let cpuUsage = null;
    if (
      this.previousCpu &&
      proc?.cpuTimes &&
      proc.cpuTimes.total > this.previousCpu.total
    )
      cpuUsage = Math.max(
        0,
        Math.min(
          1,
          1 -
            (proc.cpuTimes.idle - this.previousCpu.idle) /
              (proc.cpuTimes.total - this.previousCpu.total),
        ),
      );
    this.previousCpu = proc?.cpuTimes;
    const disks = [];
    if (Number.isFinite(info?.disk_total))
      disks.push({
        id: "ha-data",
        name: "Home Assistant data",
        kind: "volume",
        parentId: null,
        mountpoint: null,
        filesystem: null,
        totalBytes: Math.round(info.disk_total * 1024 ** 3),
        usedBytes: Number.isFinite(info.disk_used)
          ? Math.round(info.disk_used * 1024 ** 3)
          : null,
        availableBytes: Number.isFinite(info.disk_free)
          ? Math.round(info.disk_free * 1024 ** 3)
          : null,
        scope: "host",
      });
    for (const disk of (diskInfo?.disks ?? []).slice(0, 32)) {
      const id = text(disk.id ?? disk.name);
      if (!id) continue;
      disks.push({
        id,
        name: text(disk.model ?? disk.name, "Disk"),
        kind: "disk",
        parentId: null,
        mountpoint: null,
        filesystem: null,
        totalBytes: nullableNumber(disk.size),
        usedBytes: null,
        availableBytes: null,
        scope: "host",
      });
      for (const part of (disk.partitions ?? []).slice(0, 32))
        disks.push({
          id: text(part.uuid ?? part.device, `${id}-volume`),
          name: text(part.label ?? part.device, "Volume"),
          kind: "volume",
          parentId: id,
          mountpoint: null,
          filesystem: text(part.filesystem),
          totalBytes: nullableNumber(part.size),
          usedBytes: null,
          availableBytes: null,
          scope: "host",
        });
    }
    const containers = core
      ? [
          container(
            "home-assistant-core",
            "Home Assistant",
            core,
            stats,
            stats ? "running" : "unknown",
          ),
        ]
      : [];
    const list = (apps?.addons ?? [])
      .slice(0, 64)
      .filter(
        (app) =>
          typeof app.slug === "string" && /^[a-zA-Z0-9_-]+$/.test(app.slug),
      );
    const current = new Set(list.map((app) => app.slug));
    for (const id of this.appStats.keys())
      if (!current.has(id)) this.appStats.delete(id);
    const cursor = this.appCursor % Math.max(1, list.length);
    const ordered = [...list.slice(cursor), ...list.slice(0, cursor)];
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ordered.length) }, async () => {
        while (index < ordered.length && Date.now() < this.deadline) {
          const app = ordered[index++];
          if (app.state !== "started") continue;
          const usage = await this.stats(`/addons/${app.slug}/stats`);
          if (usage)
            this.appStats.set(app.slug, { sampledAt: at, data: usage });
        }
      }),
    );
    this.appCursor = (cursor + index) % Math.max(1, list.length);
    for (const app of list) {
      const cached = this.appStats.get(app.slug);
      const usage =
        app.state === "started" && cached && at - cached.sampledAt < 30000
          ? cached.data
          : null;
      containers.push({
        ...container(app.slug, app.name, app, usage, app.state),
        sampledAt: usage ? new Date(cached.sampledAt).toISOString() : null,
      });
    }
    const boot =
      info?.boot_timestamp > 0
        ? Math.max(0, at / 1000 - info.boot_timestamp / 1000000)
        : null;
    const host = {
      sampledAt: new Date(at).toISOString(),
      scope: "host",
      source: files ? "linux-proc-and-supervisor" : "supervisor",
      hostname: text(info?.hostname),
      platform: text(info?.operating_system),
      release: text(info?.kernel),
      arch: text(core?.arch),
      uptimeSeconds: proc?.uptimeSeconds ?? boot,
      cpu: {
        model: files
          ? text(/^(?:model name|Hardware)\s*:\s*(.+)$/m.exec(files[3])?.[1])
          : null,
        logicalCores: proc?.logicalCores ?? null,
        usage: cpuUsage,
        loadAverage: files
          ? files[4]
              .trim()
              .split(/\s+/)
              .slice(0, 3)
              .map(Number)
              .filter(Number.isFinite)
          : [],
      },
      memory: proc?.memory ?? {
        totalBytes: null,
        availableBytes: null,
        usedBytes: null,
      },
      swap: proc?.swap ?? {
        supported: false,
        totalBytes: null,
        usedBytes: null,
      },
      disks,
      docker:
        core || apps
          ? {
              available: true,
              source: "supervisor",
              containers: containers.sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
              scope: "managed-containers",
            }
          : unavailable(),
      pm2: { available: false, source: "unavailable", processes: [] },
    };
    return host;
  }
}
