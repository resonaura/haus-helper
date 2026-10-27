import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { createApi } from "../lib/server.mjs";
import { Store } from "../lib/store.mjs";
import { SharedConfig } from "../lib/shared-config.mjs";

test("authenticated clients receive immediate revisions and HA outages without losing the home channel", async () => {
  const store = new Store(":memory:", "/tmp");
  const shared = new SharedConfig(store),
    ha = Object.assign(new EventEmitter(), { connected: true });
  const server = createApi({
    config: { standalone: true, apiToken: "fixture" },
    ha,
    store,
    shared,
    recorder: {},
    getRegistry: () => ({ cameras: [] }),
    servers: null,
  });
  const clients = [];
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/api/live`;
  const open = async (token = "fixture") => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}`, "X-Haus-Client": "1" },
    });
    clients.push(socket);
    const [, message] = await Promise.all([
      once(socket, "open"),
      once(socket, "message"),
    ]);
    return { socket, initial: JSON.parse(message[0]) };
  };
  try {
    const [a, b] = await Promise.all([open(), open()]);
    assert.equal(a.initial.revision, "0");
    assert.equal(a.initial.instance, b.initial.instance);
    const updates = clients.map((socket) => once(socket, "message"));
    const saved = shared.patch("0", { favorites: ["light.narnia"] });
    for (const pending of updates) {
      const value = JSON.parse((await pending)[0]);
      assert.equal(value.revision, saved.revision);
      assert.equal(value.topic, "preferences");
      assert.ok(!JSON.stringify(value).includes("light.narnia"));
    }
    const outage = once(a.socket, "message");
    ha.connected = false;
    ha.emit("status", "Reconnecting");
    assert.equal(JSON.parse((await outage)[0]).connected, false);
    assert.equal(a.socket.readyState, WebSocket.OPEN);
    const changedOffline = once(a.socket, "message");
    shared.patch(saved.revision, { roomIcons: { narnia: "moon" } });
    assert.equal(JSON.parse((await changedOffline)[0]).topic, "preferences");
    const closed = once(a.socket, "close");
    a.socket.send(JSON.stringify({ type: "command" }));
    assert.equal((await closed)[0], 1008);
    await assert.rejects(open("wrong"));
  } finally {
    for (const socket of clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});
