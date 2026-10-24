import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  stat,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { Store } from "../lib/store.mjs";
import { Backups, unseal } from "../lib/backups.mjs";
import { SharedConfig } from "../lib/shared-config.mjs";
import { CATALOG_SNAPSHOT, restoreCatalog } from "../lib/catalog-backup.mjs";
import { promisify } from "node:util";
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
test("encrypted configuration snapshots preserve server names and room assignments", async (t) => {
  const { root, store, backups } = await fixture(t);
  const shared = new SharedConfig(store);
  const saved = shared.patch("0", {
    favorites: ["light.narnia"],
    serverDevices: {
      "home-assistant": { areaId: "narnia" },
      "node-miku": { name: "Miku", areaId: "narnia" },
      "node-laptop": { name: "Black Laptop", areaId: "narnia" },
    },
  });
  const backup = await backups.snapshot("haus");
  const restoredDirectory = join(root, "recovered");
  await mkdir(restoredDirectory);
  const archive = join(restoredDirectory, "haus.tar.gz");
  const metadata = await unseal(
    backups.path(backup.digest),
    archive,
    backups.key,
  );
  assert.equal(metadata.kind, "haus");
  await promisify(execFile)("tar", ["-xzf", archive, "-C", restoredDirectory]);
  const restored = new Store(
    join(restoredDirectory, "haus.sqlite"),
    join(root, "media"),
  );
  try {
    assert.deepEqual(new SharedConfig(restored).get(), saved);
  } finally {
    restored.close();
  }
});

test("configuration and HA snapshots run independently with one bounded task per kind", async (t) => {
  const { backups } = await fixture(t);
  backups.config.standalone = false;
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const downloading = new Promise((resolve) => {
    entered = resolve;
  });
  backups.supervisor = async (_path, init) => {
    if (init?.method === "POST")
      return Response.json({
        result: "ok",
        data: { slug: "owned-parallel-ha" },
      });
    entered();
    await gate;
    return new Response("ha-fixture");
  };
  const slow = backups.snapshot("ha");
  try {
    await downloading;
    const config = backups.snapshot("haus");
    await assert.rejects(backups.snapshot("haus"), /backup_busy/);
    await assert.rejects(backups.snapshot("ha"), /backup_busy/);
    const result = await config;
    assert.equal(result.kind, "haus");
    assert.equal(backups.busy, true);
    assert.equal(backups.canSnapshot("haus"), true);
    assert.equal(backups.canSnapshot("ha"), false);
  } finally {
    release();
    await slow;
  }
  assert.equal(backups.busy, false);
  assert.equal(backups.list().length, 2);
});

test("a successful configuration snapshot cannot hide an independent HA backup failure", async (t) => {
  const { backups } = await fixture(t);
  backups.config.standalone = false;
  backups.supervisor = async () => {
    throw Error("supervisor_busy");
  };
  await assert.rejects(backups.snapshot("ha"), /supervisor_busy/);
  const failure = backups.error;
  assert.match(failure, /Home Assistant backup/);
  await backups.snapshot("haus");
  assert.equal(backups.error, failure);
});

test("slow HA retention cannot hold configuration snapshot completion", async (t) => {
  const { backups, store } = await fixture(t);
  backups.config.standalone = false;
  for (let i = 0; i < 8; i++) {
    const digest = i.toString(16).padStart(64, "0");
    await writeFile(backups.path(digest), "fixture");
    store.db
      .prepare(
        "INSERT INTO haus_backups(digest,kind,created_at,bytes,ha_slug)VALUES(?,?,?,?,?)",
      )
      .run(digest, "ha", i, 7, "owned-" + i);
  }
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const deleting = new Promise((resolve) => {
    entered = resolve;
  });
  backups.supervisor = async (_path, init) => {
    assert.equal(init.method, "DELETE");
    entered();
    await gate;
    return new Response("{}");
  };
  const retention = backups.prune("ha");
  try {
    await deleting;
    const result = await backups.snapshot("haus");
    assert.equal(result.kind, "haus");
  } finally {
    release();
    await retention;
  }
  assert.equal(backups.list().filter((i) => i.kind === "ha").length, 7);
});
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
test("Supervisor hot backup exclusions preserve a restorable catalog while the live WAL stays open", async (t) => {
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
  const preferences = new SharedConfig(store).patch("0", {
    favorites: ["light.narnia"],
  });
  await run("pre");
  store.create("camera.fixture", "motion", 3000, 4000);
  const archiveDirectory = await mkdtemp(join(tmpdir(), "haus-supervisor-"));
  t.after(() => rm(archiveDirectory, { recursive: true, force: true }));
  const archive = join(archiveDirectory, "addon.tar.gz");
  const config = await readFile(
    new URL("../config.yaml", import.meta.url),
    "utf8",
  );
  const exclusions = config
    .match(/backup_exclude:\n((?:  - .*\n)+)/)[1]
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line.trim().slice(2)));
  await promisify(execFile)("tar", [
    "-czf",
    archive,
    ...exclusions.map((pattern) => "--exclude=" + pattern),
    "-C",
    root,
    ".",
  ]);
  const names = (
    await promisify(execFile)("tar", ["-tf", archive])
  ).stdout.split("\n");
  assert.ok(names.includes("./restore/" + CATALOG_SNAPSHOT));
  assert.ok(!names.some((name) => /^\.\/haus\.sqlite/.test(name)));
  const restoredRoot = join(root, "recovered");
  await mkdir(restoredRoot);
  await promisify(execFile)("tar", ["-xzf", archive, "-C", restoredRoot]);
  assert.equal(await restoreCatalog(restoredRoot), true);
  const restored = new Store(
    join(restoredRoot, "haus.sqlite"),
    join(root, "media"),
  );
  try {
    assert.equal(restored.get(first.id).cameraId, "camera.fixture");
    assert.equal(restored.list().events.length, 1);
    assert.deepEqual(new SharedConfig(restored).get(), preferences);
    restored.create("camera.fixture", "motion", 5000, 6000);
    assert.equal(await restoreCatalog(restoredRoot), false);
    assert.equal(restored.list().events.length, 2);
  } finally {
    restored.close();
  }
  await run("post");
  await assert.rejects(() => stat(join(root, "restore")));
  assert.equal(store.list().events.length, 2);
});

test("catalog restoration accepts legacy snapshots and never invents an absent backup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "haus-legacy-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await restoreCatalog(root), false);
  await mkdir(join(root, "restore"));
  const source = join(root, "restore", "haus.sqlite");
  await writeFile(source, "legacy catalog");
  assert.equal(await restoreCatalog(root), true);
  assert.equal(
    await readFile(join(root, "haus.sqlite"), "utf8"),
    "legacy catalog",
  );
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
