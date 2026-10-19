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
