import { readFile, readdir, statfs } from "node:fs/promises";
import { homeAssistantDisks } from "./host-disks.mjs";
import { homeAssistantGraphics } from "./host-gpus.mjs";
import { linuxInstalledMemory } from "./host-memory.mjs";

const nullableNumber = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, fallback = null) =>
  typeof value === "string" ? value.slice(0, 240) : fallback;
const armCpuParts = new Map([
  ["0xb76", "ARM1176JZF-S"],
  ["0xc07", "Cortex-A7"],
  ["0xc0f", "Cortex-A15"],
  ["0xd03", "Cortex-A53"],
  ["0xd04", "Cortex-A35"],
  ["0xd05", "Cortex-A55"],
  ["0xd07", "Cortex-A57"],
  ["0xd08", "Cortex-A72"],
  ["0xd09", "Cortex-A73"],
  ["0xd0a", "Cortex-A75"],
  ["0xd0b", "Cortex-A76"],
  ["0xd0c", "Neoverse N1"],
  ["0xd0d", "Cortex-A77"],
  ["0xd41", "Cortex-A78"],
  ["0xd44", "Cortex-X1"],
  ["0xd46", "Cortex-A510"],
  ["0xd47", "Cortex-A710"],
  ["0xd48", "Cortex-X2"],
  ["0xd49", "Neoverse N2"],
  ["0xd4d", "Cortex-A715"],
  ["0xd4e", "Cortex-X3"],
  ["0xd80", "Cortex-A520"],
  ["0xd81", "Cortex-A720"],
  ["0xd82", "Cortex-X4"],
]);
const unavailable = () => ({
  available: false,
  source: "unavailable",
  containers: [],
});

/** Resolve ARM core names from the architected implementer/part fields in procfs. */
export function parseHostCpuModel(cpuinfo) {
  if (typeof cpuinfo !== "string" || !cpuinfo.trim()) return null;
  const modelName = text(
    /^(?:model name)\s*:\s*(.+)$/im.exec(cpuinfo)?.[1],
  )?.trim();
  if (modelName && !/^ARMv\d+\s+Processor\b/i.test(modelName)) return modelName;

  const parts = new Set();
  for (const block of cpuinfo.split(/(?=^processor\s*:\s*\d+)/m)) {
    const implementer = /^CPU implementer\s*:\s*(0x[\da-f]+)\s*$/im
      .exec(block)?.[1]
      ?.toLowerCase();
    const part = /^CPU part\s*:\s*(0x[\da-f]+)\s*$/im
      .exec(block)?.[1]
      ?.toLowerCase();
    if (implementer === "0x41" && part && armCpuParts.has(part))
      parts.add(armCpuParts.get(part));
  }
  if (parts.size) return `ARM ${[...parts].join(" + ")}`;

  const hardware = text(
    /^(?:Hardware)\s*:\s*(.+)$/im.exec(cpuinfo)?.[1],
  )?.trim();
  return (
    hardware ||
    modelName ||
    text(/^Processor\s*:\s*(.+)$/im.exec(cpuinfo)?.[1])?.trim() ||
    null
  );
}

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
  constructor(
    config,
    {
      fetcher = fetch,
      read = readFile,
      list = readdir,
      filesystem = statfs,
    } = {},
  ) {
    Object.assign(this, { config, fetcher, read, list, filesystem });
    this.appStats = new Map();
    this.cpuSamples = new Map();
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
    const stats =
      (await this.supervisor(`${path}?one_shot=true`)) ??
      (Date.now() < this.deadline ? await this.supervisor(path) : null);
    if (!stats) return null;
    // Supervisor one-shot samples expose cumulative counters but no measurement
    // window. Calculate Docker's per-core percentage across our bounded polls.
    const previous = this.cpuSamples.get(path);
    const at = Date.now();
    const usage = nullableNumber(stats.cpu_usage);
    const system = nullableNumber(stats.cpu_system_usage);
    const cores = nullableNumber(stats.online_cpus);
    let percent = nullableNumber(stats.cpu_percent);
    if (
      percent === null &&
      previous &&
      at - previous.at <= 60000 &&
      usage !== null &&
      system !== null &&
      cores > 0 &&
      usage >= previous.usage &&
      system > previous.system
    )
      percent = Math.min(
        cores * 100,
        ((usage - previous.usage) / (system - previous.system)) * cores * 100,
      );
    if (usage !== null && system !== null)
      this.cpuSamples.set(path, { usage, system, at });
    else this.cpuSamples.delete(path);
    return { ...stats, cpu_percent: percent };
  }
  async collect(at, inventory = false) {
    if (this.value && !this.config.standalone && !inventory) {
      if (!this.inventoryRefresh && at - this.inventoryAt >= 10000)
        this.inventoryRefresh = this.collect(at, true)
          .catch(() => {})
          .finally(() => {
            this.inventoryRefresh = undefined;
          });
      const [stat, meminfo, uptime, loadavg] = await Promise.all(
        ["stat", "meminfo", "uptime", "loadavg"].map((name) =>
          this.read(`/proc/${name}`, "utf8").catch(() => null),
        ),
      );
      if (!stat || !meminfo) return this.value;
      const proc = parseHostProc(stat, meminfo, uptime ?? "");
      let usage = null;
      if (
        this.previousCpu &&
        proc.cpuTimes &&
        proc.cpuTimes.total > this.previousCpu.total
      )
        usage = Math.max(
          0,
          Math.min(
            1,
            1 -
              (proc.cpuTimes.idle - this.previousCpu.idle) /
                (proc.cpuTimes.total - this.previousCpu.total),
          ),
        );
      this.previousCpu = proc.cpuTimes;
      this.latestProcAt = at;
      this.value = {
        ...this.value,
        sampledAt: new Date(at).toISOString(),
        uptimeSeconds: proc.uptimeSeconds,
        cpu: {
          ...this.value.cpu,
          usage,
          logicalCores: proc.logicalCores,
          loadAverage: loadavg
            ? loadavg
                .trim()
                .split(/\s+/)
                .slice(0, 3)
                .map(Number)
                .filter(Number.isFinite)
            : [],
        },
        memory: {
          ...proc.memory,
          installedBytes: this.value.memory.installedBytes,
        },
        swap: proc.swap,
      };
      return this.value;
    }
    this.inventoryAt = at;
    this.deadline = Date.now() + 2500;
    const [
      info,
      core,
      stats,
      apps,
      diskInfo,
      files,
      hardware,
      mountinfo,
      mediaFilesystem,
    ] = await Promise.all([
      this.supervisor("/host/info"),
      this.supervisor("/core/info"),
      this.stats("/core/stats"),
      this.supervisor("/addons"),
      this.supervisor("/host/disks"),
      this.config.standalone
        ? null
        : Promise.all(
            ["stat", "meminfo", "uptime", "cpuinfo", "loadavg"].map((name) =>
              this.read(`/proc/${name}`, "utf8").catch(() => null),
            ),
          ),
      this.supervisor("/hardware/info"),
      this.read("/proc/self/mountinfo", "utf8").catch(() => ""),
      this.filesystem(this.config.media).catch(() => null),
    ]);
    const proc =
      files?.[0] && files?.[1]
        ? parseHostProc(files[0], files[1], files[2] ?? "")
        : null;
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
    if (this.latestProcAt === undefined || at >= this.latestProcAt) {
      this.previousCpu = proc?.cpuTimes;
      this.latestProcAt = at;
    }
    const disks = homeAssistantDisks({
      hardware,
      diskInfo,
      hostInfo: info,
      media: this.config.media,
      mountinfo,
      mediaFilesystem,
    });
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
    for (const path of this.cpuSamples.keys())
      if (path !== "/core/stats" && !current.has(path.split("/")[2]))
        this.cpuSamples.delete(path);
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
    if (this.graphicsAt === undefined || at - this.graphicsAt >= 60000) {
      this.graphicsAt = at;
      this.graphics = await homeAssistantGraphics(hardware, {
        read: this.read,
        now: () => at,
      });
    }
    if (
      this.installedMemoryAt === undefined ||
      at - this.installedMemoryAt >= 60000
    ) {
      this.installedMemoryAt = at;
      this.installedMemory = await linuxInstalledMemory({
        list: this.list,
        read: this.read,
      });
    }
    const host = {
      sampledAt: new Date(at).toISOString(),
      scope: "host",
      source: files ? "linux-proc-and-supervisor" : "supervisor",
      hostname: text(info?.hostname),
      platform: text(info?.operating_system),
      osName: text(info?.operating_system),
      gpus: this.graphics,
      release: text(info?.kernel),
      arch: text(core?.arch),
      uptimeSeconds: proc?.uptimeSeconds ?? boot,
      cpu: {
        model: parseHostCpuModel(files?.[3]),
        logicalCores: proc?.logicalCores ?? null,
        usage: cpuUsage,
        loadAverage: files?.[4]
          ? files[4]
              .trim()
              .split(/\s+/)
              .slice(0, 3)
              .map(Number)
              .filter(Number.isFinite)
          : [],
      },
      memory: {
        ...(proc?.memory ?? {
          totalBytes: null,
          availableBytes: null,
          usedBytes: null,
        }),
        installedBytes: nullableNumber(this.installedMemory),
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
    if (inventory && this.value && Date.parse(this.value.sampledAt) >= at) {
      const latest = this.value;
      host.sampledAt = latest.sampledAt;
      host.cpu = {
        ...host.cpu,
        usage: latest.cpu.usage,
        loadAverage: latest.cpu.loadAverage,
      };
      host.memory = {
        ...latest.memory,
        installedBytes:
          host.memory.installedBytes ?? latest.memory.installedBytes,
      };
      host.swap = latest.swap;
      host.uptimeSeconds = latest.uptimeSeconds;
    }
    this.value = host;
    return host;
  }
}
