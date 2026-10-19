import { setTimeout as sleep } from "node:timers/promises";
/** Correlate a background backup by its unique name using only backup-role endpoints. */
export async function supervisorBackup(
  supervisor,
  input,
  { signal, pollMs = 5000, timeoutMs = 1800000 } = {},
) {
  const abort = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  const read = async (response) => {
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("supervisor_backup_failed");
    }
  };
  const created = await read(
    await supervisor("/backups/new/partial", {
      method: "POST",
      body: JSON.stringify({ ...input, background: true }),
      signal: abort,
    }),
  );
  if (created.result === "error") throw new Error("supervisor_backup_failed");
  const valid = (slug) =>
    typeof slug === "string" && /^[a-zA-Z0-9_-]+$/.test(slug);
  const immediate = created.data?.slug ?? created.slug;
  if (valid(immediate)) return immediate;
  // Some Supervisor/proxy versions return 202/204 without a JSON body. A unique
  // name still identifies this exact request; never submit a second backup while waiting.
  for (;;) {
    abort.throwIfAborted();
    const info = await read(
      await supervisor("/backups/info", { signal: abort }),
    );
    const backups = info.data?.backups ?? info.backups ?? [];
    const match = backups.find(
      (item) => item.name === input.name && valid(item.slug),
    );
    if (match) return match.slug;
    await sleep(pollMs, undefined, { signal: abort });
  }
}
