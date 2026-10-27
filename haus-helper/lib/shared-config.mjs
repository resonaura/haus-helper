import { randomUUID } from "node:crypto";
const keys = new Set([
  "favorites",
  "hiddenApp",
  "hiddenHome",
  "unhiddenApp",
  "deviceOrder",
  "autoGroupLights",
  "disabledLightGroups",
  "roomIcons",
  "serverDevices",
]);
export class SharedConfig {
  constructor(store, onChange = () => {}) {
    this.listeners = new Set();
    this.store = store;
    this.onChange = onChange;
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS shared_config (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get() {
    const row = this.store.db
      .prepare("SELECT * FROM shared_config WHERE id=1")
      .get();
    return row
      ? {
          revision: row.revision,
          value: JSON.parse(row.value),
          updatedAt: row.updated_at,
        }
      : { revision: "0", value: {}, updatedAt: 0 };
  }
  patch(baseRevision, patch) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Array.isArray(patch) ||
      Object.keys(patch).some((key) => !keys.has(key)) ||
      Buffer.byteLength(JSON.stringify(patch)) > 500000
    )
      throw new Error("invalid_shared_config");
    const current = this.get();
    if (current.revision !== baseRevision)
      return { conflict: true, ...current };
    const next = {
      revision: randomUUID(),
      value: { ...current.value, ...patch },
      updatedAt: Date.now(),
    };
    this.store.db
      .prepare(
        "INSERT INTO shared_config(id,revision,value,updated_at)VALUES(1,?,?,?) ON CONFLICT(id)DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(next.revision, JSON.stringify(next.value), next.updatedAt);
    this.onChange();
    for (const listener of this.listeners) listener();
    return next;
  }
}
