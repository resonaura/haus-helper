import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { Store } from "../lib/store.mjs";
import { Backups } from "../lib/backups.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-backups-")),
    media = join(root, "media");
  await mkdir(media);
  const store = new Store(join(root, "haus.sqlite"), media);
  const backups = new Backups({ data: root, standalone: true }, store);
  await backups.initialize();
  t.after(async () => {
    await backups.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, backups };
}
test("ring pruning keeps 24 configuration snapshots and 7 HA backups; only Haus-owned slugs are deleted", async (t) => {
  const { store, backups } = await fixture(t);
  const deleted = [];
  backups.config.standalone = false;
  backups.supervisor = async (path, init) => {
    assert.equal(init.method, "DELETE");
    deleted.push(path);
    return new Response("{}");
  };
  for (let i = 0; i < 33; i++) {
    const kind = i < 25 ? "haus" : "ha",
      digest = i.toString(16).padStart(64, "0");
    await writeFile(backups.path(digest), "encrypted-fixture");
    store.db
      .prepare(
        "INSERT INTO haus_backups(digest,kind,created_at,bytes,ha_slug)VALUES(?,?,?,?,?)",
      )
      .run(digest, kind, i, 17, kind === "ha" ? "owned-" + i : null);
  }
  await backups.prune();
  assert.equal(backups.list().filter((b) => b.kind === "haus").length, 24);
  assert.equal(backups.list().filter((b) => b.kind === "ha").length, 7);
  assert.deepEqual(deleted, ["/backups/owned-25"]);
});
test("hot backup hook captures a consistent committed database while the live WAL stays open", async (t) => {
  const { root, store } = await fixture(t);
  const first = store.create("camera.fixture", "motion", 1000, 2000);
  const run = (arg) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["lib/backup-hook.mjs", arg], {
        env: { ...process.env, HAUS_DATA: root },
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("hook failed")),
      );
    });
  await run("pre");
  const snapshot = new Store(
    join(root, "restore", "haus.sqlite"),
    join(root, "media"),
  );
  assert.equal(snapshot.get(first.id).cameraId, "camera.fixture");
  snapshot.close();
  store.create("camera.fixture", "motion", 3000, 4000);
  await run("post");
  await assert.rejects(() => stat(join(root, "restore")));
  assert.equal(store.list().events.length, 2);
});

test("failed automatic backups retain exponential cooldown across restarts; manual success clears it", async (t) => {
  const { backups, store, root } = await fixture(t);
  await backups.snapshot("haus");
  backups.config.standalone = false;
  backups.config.ha_backups_enabled = true;
  let calls = 0;
  backups.supervisor = async () => {
    calls++;
    throw new Error("supervisor_busy");
  };
  const before = Date.now();
  await assert.rejects(() => backups.snapshot("ha"), /supervisor_busy/);
  const retry = () =>
    store.db.prepare("SELECT * FROM haus_backup_retries WHERE kind='ha'").get();
  assert.equal(retry().failures, 1);
  assert.ok(retry().next_at >= before + 300000);
  await backups.tick();
  await backups.tick();
  assert.equal(
    calls,
    1,
    "15-second maintenance ticks must not hammer Supervisor",
  );
  const resumed = new Backups(
    { data: root, standalone: false, ha_backups_enabled: true },
    store,
  );
  await resumed.initialize();
  resumed.supervisor = backups.supervisor;
  await resumed.tick();
  assert.equal(calls, 1, "restarting the helper must retain the cooldown");
  store.db
    .prepare("UPDATE haus_backup_retries SET next_at=0 WHERE kind='ha'")
    .run();
  await assert.rejects(() => resumed.tick(), /supervisor_busy/);
  assert.equal(calls, 2);
  assert.equal(retry().failures, 2);
  assert.ok(retry().next_at >= Date.now() + 599000);
  resumed.supervisor = async (path, init) => {
    if (init?.method === "POST")
      return Response.json({
        result: "ok",
        data: { slug: "owned-retry-fixture" },
      });
    return new Response("synthetic-ha-archive");
  };
  await resumed.snapshot("ha"); // An explicit retry remains available during automatic cooldown.
  assert.equal(retry(), undefined);
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.list().filter((item) => item.kind === "ha").length, 1);
  await resumed.stop();
});
