import { test } from "node:test";
import assert from "node:assert/strict";
import { supervisorBackup } from "../lib/supervisor-backup.mjs";
test("background backup polls for its unique name, ignoring other archives and never duplicating POST", async () => {
  let posts = 0,
    polls = 0;
  const result = await supervisorBackup(
    async (path, init) => {
      if (init.method === "POST") {
        posts++;
        assert.equal(path, "/backups/new/partial");
        assert.equal(JSON.parse(init.body).background, true);
        return Response.json({ result: "ok", data: { job_id: "fixture" } });
      }
      assert.equal(path, "/backups/info");
      polls++;
      return Response.json({
        data: {
          backups: [
            { name: "someone else's backup", slug: "other" },
            ...(polls > 1
              ? [{ name: "owned unique backup", slug: "owned" }]
              : []),
          ],
        },
      });
    },
    { name: "owned unique backup" },
    { pollMs: 1 },
  );
  assert.equal(result, "owned");
  assert.equal(posts, 1);
  assert.equal(polls, 2);
});
test("empty accepted responses and immediate completed results are supported", async () => {
  for (const status of [202, 204]) {
    const result = await supervisorBackup(
      async (_path, init) =>
        init.method === "POST"
          ? new Response(null, { status })
          : Response.json({
              data: { backups: [{ name: "owned", slug: "abc123" }] },
            }),
      { name: "owned" },
      { pollMs: 1 },
    );
    assert.equal(result, "abc123");
  }
  assert.equal(
    await supervisorBackup(
      async () => Response.json({ result: "ok", data: { slug: "completed" } }),
      { name: "owned" },
    ),
    "completed",
  );
});
test("cancelled or failed jobs do not retry creating an archive", async () => {
  let posts = 0;
  const controller = new AbortController();
  await assert.rejects(
    () =>
      supervisorBackup(
        async (_path, init) => {
          if (init.method === "POST") {
            posts++;
            return Response.json({ result: "ok", data: { job_id: "fixture" } });
          }
          controller.abort();
          return Response.json({ data: { backups: [] } });
        },
        { name: "owned" },
        { signal: controller.signal, pollMs: 1 },
      ),
    /abort/i,
  );
  assert.equal(posts, 1);
  await assert.rejects(
    () =>
      supervisorBackup(async () => Response.json({ result: "error" }), {
        name: "owned",
      }),
    /supervisor_backup_failed/,
  );
});
