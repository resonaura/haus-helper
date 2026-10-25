import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  symlink,
  rm,
  open,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  StorageUsage,
  nodeStorageCategory,
  addStorageRole,
} from "../lib/storage-usage.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "haus-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("measures sparse allocation, deduplicates hard links and does not follow links outside managed roots", async (t) => {
  const root = await fixture(t),
    data = join(root, "data");
  await mkdir(data);
  const file = join(data, "original"),
    copy = join(data, "prepared");
  const handle = await open(file, "w");
  await handle.truncate(10 * 1024 ** 2);
  await handle.close();
  await link(file, copy);
  await writeFile(join(root, "private"), "must-not-count-or-read");
  await symlink(join(root, "private"), join(data, "external"));
  const scanner = new StorageUsage({
    roots: [{ id: "data", path: data }],
    classify: () => (_root, name) => name,
  });
  const value = await scanner.collect();
  assert.equal(value.complete, true);
  assert.equal(value.files, 1);
  assert.equal(value.duplicateFiles, 1);
  assert.equal(value.skippedLinks, 1);
  assert.equal(value.logicalBytes, 10 * 1024 ** 2);
  assert.equal(value.allocatedBytes, (await lstat(file)).blocks * 512);
  assert.equal(value.categories[0].id, "shared");
  assert.equal(JSON.stringify(value).includes("private"), false);
});
test("nested roots keep their classifier, scans coalesce and cached status never blocks the resource response", async (t) => {
  const root = await fixture(t),
    media = join(root, "media");
  await mkdir(media);
  await writeFile(join(media, "clip"), "123");
  let at = 1000,
    classifications = 0;
  const scanner = new StorageUsage({
    roots: [
      { id: "media", path: media },
      { id: "data", path: root },
    ],
    now: () => at,
    classify: () => {
      classifications++;
      return (id) => id;
    },
  });
  assert.equal(scanner.status(), null);
  scanner.status();
  await scanner.loading;
  assert.equal(classifications, 1);
  assert.equal(scanner.status().categories[0].id, "media");
  assert.equal(scanner.status().logicalBytes, 3);
  at += 30001;
  scanner.status();
  await scanner.loading;
  assert.equal(classifications, 2);
  await scanner.stop();
  at += 30001;
  scanner.status();
  assert.equal(scanner.loading, undefined);
});
test("bounded and unreadable scans are explicitly partial; missing allocation is never logical bytes in disguise", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "a"), "abc");
  await writeFile(join(root, "b"), "def");
  const base = {
    roots: [{ id: "data", path: root }],
    classify: () => () => "other",
  };
  assert.equal(
    (await new StorageUsage({ ...base, maxEntries: 1 }).collect()).complete,
    false,
  );
  const scanner = new StorageUsage({
    ...base,
    inspect: async (path, options) => {
      if (path.endsWith("b"))
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      const info = await lstat(path, options);
      info.blocks = undefined;
      return info;
    },
  });
  const value = await scanner.collect();
  assert.equal(value.complete, false);
  assert.equal(value.logicalBytes, 3);
  assert.equal(value.allocatedBytes, null);
});
test("classifies only confirmed blob roles and separates active capture from pre-event data", () => {
  const id = "a".repeat(64),
    roles = new Map();
  assert.equal(nodeStorageCategory(`blobs/${id}`, roles), "other-media");
  addStorageRole(roles, id, "originals");
  assert.equal(nodeStorageCategory(`blobs/${id}`, roles), "originals");
  addStorageRole(roles, id, "prepared");
  assert.equal(nodeStorageCategory(`blobs/${id}`, roles), "shared");
  assert.equal(
    nodeStorageCategory("camera-sessions/session/event-id/part.ts"),
    "capture",
  );
  assert.equal(
    nodeStorageCategory("camera-sessions/session/part.ts"),
    "prebuffer",
  );
  assert.equal(nodeStorageCategory("recordings.sqlite-wal"), "databases");
  assert.equal(nodeStorageCategory("blobs/.partial-x"), "temporary");
});
