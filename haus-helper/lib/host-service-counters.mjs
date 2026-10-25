import dbus from "@homebridge/dbus-native";

const destination = "org.freedesktop.systemd1";
const prefix = "/org/freedesktop/systemd1/unit/";
const active = (row) =>
  ["active", "activating", "reloading"].includes(row.status);
const clean = (value) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f]/g, "").slice(0, 240)
    : "";
const integer = (value) => {
  try {
    if (value === null || value === undefined || !/^\d+$/.test(String(value)))
      return null;
    const result = BigInt(String(value));
    return result >= 0n && result < 18446744073709551615n ? result : null;
  } catch {
    return null;
  }
};
const numeric = (value) =>
  value !== null && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : null;

/** Only public unit identity/state and explicitly named accounting properties are read. */
export class HostServiceCounters {
  constructor({
    factory = () =>
      dbus.createClient({
        busAddress: "unix:path=/run/dbus/system_bus_socket",
        ReturnLongjs: true,
      }),
    now = Date.now,
  } = {}) {
    this.factory = factory;
    this.now = now;
    this.previous = new Map();
    this.pending = new Set();
    this.nextConnectAt = 0;
    this.stopped = false;
  }
  disconnect() {
    const bus = this.bus;
    this.bus = null;
    this.nextConnectAt = this.now() + 30000;
    for (const finish of [...this.pending])
      finish(Error("host_bus_disconnected"));
    bus?.connection.stream?.destroy();
  }
  stop() {
    this.stopped = true;
    this.disconnect();
  }
  request(path, iface, member, signature, body) {
    if (this.stopped || this.now() < this.nextConnectAt)
      return Promise.reject(Error("host_bus_unavailable"));
    if (!this.bus) {
      this.bus = this.factory();
      const bus = this.bus;
      const failed = () => {
        if (this.bus === bus) this.disconnect();
      };
      bus.connection.on("error", failed);
      bus.connection.on("end", failed);
      bus.connection.stream?.on("close", failed);
      bus.on?.("error", failed);
    }
    const bus = this.bus;
    return new Promise((resolve, reject) => {
      let finished = false;
      const message = {
        destination,
        path,
        interface: iface,
        member,
        ...(signature ? { signature, body } : {}),
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pending.delete(finish);
        if (message.serial) delete bus.cookies[message.serial];
        error ? reject(Error("host_bus_read_failed")) : resolve(value);
      };
      const timer = setTimeout(() => {
        finish(Error("host_bus_timeout"));
        if (bus.connection.state !== "connected" && this.bus === bus)
          this.disconnect();
      }, 600);
      this.pending.add(finish);
      try {
        bus.invoke(message, finish);
      } catch (error) {
        finish(error);
      }
    });
  }
  async property(path, name) {
    try {
      const variant = await this.request(
        path,
        "org.freedesktop.DBus.Properties",
        "Get",
        "ss",
        ["org.freedesktop.systemd1.Service", name],
      );
      const value = variant?.[1]?.[0];
      return name === "ControlGroup"
        ? typeof value === "string"
          ? value
          : null
        : integer(value);
    } catch {
      return null;
    }
  }
  collect() {
    if (this.loading) return this.loading;
    if (this.stopped) return Promise.resolve(null);
    if (this.at !== undefined && this.now() - this.at < 1000)
      return Promise.resolve(this.value ?? null);
    this.at = this.now();
    this.loading = this.sample()
      .catch(() => null)
      .then((value) => {
        if (value) this.value = value;
        return value;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }
  snapshot() {
    void this.collect();
    return this.value && this.now() - Date.parse(this.value.sampledAt) <= 30000
      ? this.value
      : null;
  }
  async sample() {
    const listed = await this.request(
      "/org/freedesktop/systemd1",
      destination + ".Manager",
      "ListUnits",
    );
    if (!Array.isArray(listed)) throw Error("invalid_host_units");
    const started = this.now();
    const rows = listed
      .slice(0, 4096)
      .filter(
        (row) =>
          Array.isArray(row) &&
          typeof row[0] === "string" &&
          row[0].endsWith(".service") &&
          row[2] !== "not-found" &&
          typeof row[6] === "string" &&
          row[6].startsWith(prefix) &&
          /^\/[a-zA-Z0-9_/]+$/.test(row[6]),
      )
      .slice(0, 512);
    const services = new Array(rows.length),
      previous = new Map();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, rows.length) }, async () => {
        while (cursor < rows.length && !this.stopped) {
          const index = cursor++,
            row = rows[index];
          const service = {
            id: clean(row[0]),
            name: clean(row[1]) || clean(row[0]),
            status: clean(row[3]),
            detail: clean(row[4]),
            pid: null,
            cpuPercent: null,
            memoryBytes: null,
            uptimeSeconds: null,
          };
          services[index] = service;
          if (!active(service) || this.now() - started >= 1500) continue;
          const [cpu, memory, rawPid] = await Promise.all(
            ["CPUUsageNSec", "MemoryCurrent", "MainPID"].map((name) =>
              this.property(row[6], name),
            ),
          );
          const at = this.now(),
            pid = numeric(rawPid),
            prior = this.previous.get(service.id);
          service.pid = pid > 0 ? pid : null;
          service.memoryBytes = numeric(memory);
          // RemainAfterExit keeps one-shot units active after all their work
          // has finished. An empty cgroup confirms no current resource owner.
          const emptyGroup =
            pid === 0 &&
            service.detail === "exited" &&
            (await this.property(row[6], "ControlGroup")) === "";
          if (emptyGroup) service.memoryBytes = 0;
          if (
            cpu !== null &&
            prior?.cpu !== null &&
            prior?.cpu !== undefined &&
            prior.pid === pid &&
            at > prior.at &&
            at - prior.at <= 30000 &&
            cpu >= prior.cpu
          )
            service.cpuPercent =
              Number(cpu - prior.cpu) / ((at - prior.at) * 10000);
          if (emptyGroup) service.cpuPercent = 0;
          previous.set(service.id, { cpu, pid, at });
        }
      }),
    );
    this.previous = previous;
    const units = services.filter(Boolean),
      running = units.filter(active);
    const sum = (key) =>
      running.every((row) => row[key] !== null)
        ? running.reduce((value, row) => value + row[key], 0)
        : null;
    return {
      available: true,
      source: "systemd-dbus",
      cpuPercentBasis: "core",
      sampledAt: new Date(this.now()).toISOString(),
      services: units,
      cpuPercent: sum("cpuPercent"),
      memoryBytes: sum("memoryBytes"),
    };
  }
}
