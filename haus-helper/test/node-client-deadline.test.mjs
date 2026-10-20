import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { nodeRequest } from "../lib/node-client.mjs";

test("media header deadline releases an unresponsive node but allows a slow body once headers arrive", async (t) => {
  const timers = [];
  const server = createServer((req, res) => {
    if (req.url === "/stuck") return;
    res.writeHead(200, { "Content-Length": 4 });
    res.flushHeaders();
    timers.push(setTimeout(() => res.end("clip"), 600));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    timers.forEach(clearTimeout);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const node = {
    url: `http://127.0.0.1:${server.address().port}`,
    key: "fixture-only-header-deadline-key",
    allowHttp: true,
  };
  await assert.rejects(
    nodeRequest(node, "/stuck", {
      headerTimeout: 300,
      timeout: 2000,
    }),
    { name: "AbortError" },
  );
  const response = await nodeRequest(node, "/body", {
    headerTimeout: 300,
    timeout: 2000,
  });
  assert.equal(await response.text(), "clip");
});
