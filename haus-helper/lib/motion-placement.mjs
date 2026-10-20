const fraction = (value, fallback = 0) =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** Compare actual pressure and reserved analysis slots, not the host's CPU count. */
export function analysisLoad(remote, assigned = 0) {
  const detectors = remote.detectors;
  const reserved =
    Math.max(assigned, detectors.active ?? 0) / Math.max(1, detectors.max);
  const resources = remote.resources ?? {};
  const cpu = fraction(resources.cpu, 0.5);
  const memory =
    resources.memoryBytes > 0
      ? fraction(resources.memoryUsedBytes / resources.memoryBytes, 0.5)
      : 0.5;
  const streams =
    remote.streams?.max > 0
      ? fraction(remote.streams.active / remote.streams.max)
      : 0;
  return (
    Math.max(cpu, memory, reserved) + (cpu + memory + reserved + streams) * 0.15
  );
}

export function analysisCandidates(nodes, health, jobs, cooldowns, now) {
  const assignments = new Map();
  for (const job of jobs.values())
    if (job.node)
      assignments.set(job.node.id, (assignments.get(job.node.id) ?? 0) + 1);
  return nodes
    .filter((node) => {
      const status = health.get(node.id),
        remote = status?.remote;
      const detectors = remote?.detectors;
      return (
        node.enabled &&
        node.roles.includes("stream") &&
        status?.online &&
        detectors?.supported &&
        remote.relayOrigin &&
        !remote.resources?.pressured &&
        Number.isFinite(detectors.max) &&
        detectors.max > 0 &&
        (cooldowns.get(node.id) ?? 0) <= now &&
        Math.max(assignments.get(node.id) ?? 0, detectors.active ?? 0) <
          detectors.max
      );
    })
    .sort((a, b) => {
      const remoteA = health.get(a.id).remote,
        remoteB = health.get(b.id).remote;
      return (
        analysisLoad(remoteA, assignments.get(a.id)) -
          analysisLoad(remoteB, assignments.get(b.id)) ||
        remoteB.detectors.max - remoteA.detectors.max ||
        a.id.localeCompare(b.id)
      );
    });
}
