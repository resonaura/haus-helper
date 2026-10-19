import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createEufyTalkback } from "../lib/eufy-talkback.mjs";
import { eufySerial } from "../lib/eufy-session.mjs";
const serial = "T1234567890123456",
  camera = { id: "camera.eufy", deviceId: "device" },
  registry = {
    devices: [{ id: "device", identifiers: [["eufy_security", serial]] }],
  };
test("Eufy identity comes from the same registered device, never a room/name guess", () => {
  assert.equal(eufySerial(camera, registry), serial);
  assert.equal(eufySerial({ id: "camera.eufy" }, registry), null);
  assert.equal(
    eufySerial(
      { ...camera, deviceIds: ["device", "other"] },
      {
        devices: [
          ...registry.devices,
          {
            id: "other",
            identifiers: [["eufy_security", "T9999999999999999"]],
          },
        ],
      },
    ),
    null,
  );
});
for (const alreadyLive of [false, true])
  test(`Eufy waits for confirmed talkback and ${alreadyLive ? "preserves an existing" : "cleans up its own"} livestream`, async (t) => {
    const messages = [];
    const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => ws.once("listening", r));
    ws.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "version",
          minSchemaVersion: 13,
          maxSchemaVersion: 21,
        }),
      );
      socket.on("message", (raw) => {
        const input = JSON.parse(raw);
        messages.push(input);
        const result =
          input.command === "device.has_command"
            ? { exists: true }
            : input.command === "device.is_livestreaming"
              ? { livestreaming: alreadyLive }
              : input.command === "device.is_talkback_ongoing"
                ? { talkbackOngoing: false }
                : {};
        socket.send(
          JSON.stringify({
            type: "result",
            messageId: input.messageId,
            success: true,
            result,
          }),
        );
        if (
          ["device.start_livestream", "device.start_talkback"].includes(
            input.command,
          )
        )
          setTimeout(
            () =>
              socket.send(
                JSON.stringify({
                  type: "event",
                  event: {
                    serialNumber: serial,
                    event:
                      input.command === "device.start_livestream"
                        ? "livestream started"
                        : "talkback started",
                  },
                }),
              ),
            5,
          );
      });
    });
    let args;
    const talk = createEufyTalkback(
      { eufy_ws_url: `ws://127.0.0.1:${ws.address().port}` },
      {
        spawnProcess: (command, values) => {
          args = values;
          const child = new EventEmitter();
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.exitCode = null;
          child.kill = () => {
            child.exitCode = 0;
            return true;
          };
          child.stdin.resume();
          child.stdin.on("finish", () =>
            child.stdout.end(Buffer.from([255, 241, 1, 2])),
          );
          return child;
        },
      },
    );
    const http = createServer(
      (req, res) =>
        void talk.stream(camera, registry, req, res).catch(() => res.destroy()),
    );
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    t.after(async () => {
      talk.stopAll();
      http.closeAllConnections();
      await new Promise((r) => http.close(r));
      for (const client of ws.clients) client.terminate();
      await new Promise((r) => ws.close(r));
    });
    const response = await fetch(`http://127.0.0.1:${http.address().port}`, {
      method: "POST",
      body: Buffer.from("synthetic-input"),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const commands = messages.map((m) => m.command);
    assert.ok(commands.includes("device.start_talkback"));
    assert.ok(commands.includes("device.stop_talkback"));
    assert.equal(commands.includes("device.start_livestream"), !alreadyLive);
    assert.equal(commands.includes("device.stop_livestream"), !alreadyLive);
    assert.ok(
      commands.indexOf("device.talkback_audio_data") >
        commands.indexOf("device.start_talkback"),
    );
    assert.ok(args.includes("adts"));
    assert.ok(args.includes("16000"));
  });
