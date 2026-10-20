import { test } from "node:test";
import assert from "node:assert/strict";
import { talkbackTarget } from "../lib/talkback.mjs";
test("talkback uses an explicit sensor and never guesses from RTSP", () => {
  const camera = { id: "camera.garden", aliases: ["camera.garden_internal"] };
  assert.equal(
    talkbackTarget(camera, {
      states: [
        {
          entity_id: "sensor.garden_rtsp_stream",
          state: "rtsp://192.168.1.20/live",
        },
      ],
    }),
    null,
  );
  assert.equal(
    talkbackTarget(camera, {
      states: [
        {
          entity_id: "sensor.garden_talkback_rtmp_stream",
          state: "rtmp://192.168.1.20:1935/talk/garden",
        },
      ],
    }),
    "rtmp://192.168.1.20:1935/talk/garden",
  );
  assert.equal(
    talkbackTarget(camera, {
      states: [
        {
          entity_id: "sensor.garden_talkback_rtmp_stream",
          state: "rtmp://example.com/talk/garden",
        },
      ],
    }),
    null,
  );
  assert.equal(
    talkbackTarget(camera, {
      states: [
        {
          entity_id: "sensor.other_talkback_rtmp_stream",
          state: "rtmp://192.168.1.20/talk/other",
        },
      ],
    }),
    null,
  );
});

import { createTalkback } from "../lib/talkback.mjs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
test("transcodes the browser stream only to the discovered talk endpoint and releases it when the client leaves", async (t) => {
  let args;
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.kill = () => {
    killed = true;
    child.exitCode = 0;
    child.emit("close", 0);
    return true;
  };
  const chunks = [];
  child.stdin.on("data", (chunk) => chunks.push(chunk));
  const talk = createTalkback({
    spawnProcess: (command, values) => {
      assert.equal(command, "ffmpeg");
      args = values;
      return child;
    },
  });
  const registry = {
    states: [
      {
        entity_id: "sensor.test_talkback_rtmp_stream",
        state: "rtmp://192.168.1.20:1935/talk/test",
      },
    ],
  };
  const server = createServer((req, res) => {
    void talk
      .stream({ id: "camera.test" }, registry, req, res)
      .catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    talk.stopAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
    method: "POST",
    headers: { "X-Haus-Client": "1", "Content-Type": "audio/webm;codecs=opus" },
    body: Buffer.from([26, 69, 223, 163]),
  });
  assert.equal(response.status, 200);
  assert.equal(args.at(-1), "rtmp://192.168.1.20:1935/talk/test");
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("16000"));
  await response.body.cancel();
  talk.stopAll();
  assert.equal(killed, true);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([26, 69, 223, 163]));
});

// An external DNS name is not private merely because its labels resemble an IP prefix.
test("rejects external DNS names disguised as private IPv4 addresses", () => {
  const camera = { id: "camera.garden" };
  for (const host of [
    "127.example.com",
    "10.example.com",
    "192.168.example.com",
    "172.16.example.com",
  ]) {
    assert.equal(
      talkbackTarget(camera, {
        states: [
          {
            entity_id: "sensor.garden_talkback_rtmp_stream",
            state: `rtmp://${host}/talk/garden`,
          },
        ],
      }),
      null,
    );
  }
  for (const host of [
    "10.1.2.3",
    "172.16.1.3",
    "192.168.1.20",
    "camera.local",
    "camera.lan",
  ]) {
    assert.equal(
      talkbackTarget(camera, {
        states: [
          {
            entity_id: "sensor.garden_talkback_rtmp_stream",
            state: `rtmp://${host}/talk/garden`,
          },
        ],
      }),
      `rtmp://${host}/talk/garden`,
    );
  }
});

test("custom talk sources accept exact local targets or explicitly selected URL entities and fail closed after an entity changes", async () => {
  const { customTalkback, talkbackAddress } =
    await import("../lib/talkback.mjs");
  const registry = {
    states: [
      {
        entity_id: "sensor.voice",
        state: "rtmp://192.168.1.25/custom/microphone",
      },
    ],
  };
  const source = customTalkback({ entityId: "sensor.voice" }, registry);
  assert.equal(
    talkbackTarget({ id: "camera.test", talkback: source }, registry),
    "rtmp://192.168.1.25/custom/microphone",
  );
  assert.equal(
    talkbackTarget(
      { id: "camera.test", talkback: source },
      {
        states: [
          {
            entity_id: "sensor.voice",
            state: "rtmp://public.example/microphone",
          },
        ],
      },
    ),
    null,
  );
  assert.throws(() =>
    customTalkback({ url: "http://192.168.1.1/token" }, registry),
  );
  assert.throws(() =>
    customTalkback({ url: "rtmp://192.168.1.1.evil/talk" }, registry),
  );
  assert.throws(() => customTalkback({ entityId: "sensor.unknown" }, registry));
  assert.throws(() =>
    customTalkback(
      { url: "rtmp://192.168.1.1/talk", entityId: "sensor.voice" },
      registry,
    ),
  );
  assert.equal(
    talkbackAddress("rtmp://[fd00::1]/talk"),
    "rtmp://[fd00::1]/talk",
  );
  assert.equal(customTalkback(null, registry), null);
});
