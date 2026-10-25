/** Supervisor's host/services exposes identity/state, not process resource counters. */
export function homeAssistantServices(value, at) {
  if (!Array.isArray(value?.services))
    return { available: false, source: "unavailable", services: [] };
  const text = (value, max = 240) =>
    typeof value === "string"
      ? value.replace(/[\x00-\x1f]/g, "").slice(0, max)
      : "";
  return {
    available: true,
    source: "supervisor",
    sampledAt: new Date(at).toISOString(),
    cpuPercent: null,
    memoryBytes: null,
    services: value.services
      .slice(0, 512)
      .filter((item) => typeof item?.name === "string" && item.name)
      .map((item) => ({
        id: text(item.name),
        name: text(item.description) || text(item.name),
        status: text(item.state, 40) || "unknown",
        detail: "",
        pid: null,
        cpuPercent: null,
        memoryBytes: null,
        uptimeSeconds: null,
      })),
  };
}
