import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { HostServiceCounters } from "../lib/host-service-counters.mjs";

function fixture() {
  let at = 1000,
    cpu = 90071992547409930n,
    missing = false;
  const calls = [],
    connection = new EventEmitter();
  connection.stream = new EventEmitter();
  connection.stream.destroy = () => {
    connection.stream.emit("close");
  };
  const bus = {
    connection,
    cookies: {},
    serial: 1,
    invoke(message, callback) {
      message.serial = this.serial++;
      this.cookies[message.serial] = callback;
      calls.push(message);
      queueMicrotask(() => {
        if (!this.cookies[message.serial]) return;
        delete this.cookies[message.serial];
        if (message.member === "ListUnits")
          return callback(null, [
            [
              "fixture.service",
              "Fixture",
              "loaded",
              "active",
              "running",
              "",
              "/org/freedesktop/systemd1/unit/fixture_2eservice",
            ],
            [
              "stopped.service",
              "Stopped",
              "loaded",
              "inactive",
              "dead",
              "",
              "/org/freedesktop/systemd1/unit/stopped_2eservice",
            ],
            [
              "ignored.socket",
              "Socket",
              "loaded",
              "active",
              "running",
              "",
              "/org/freedesktop/systemd1/unit/socket",
            ],
            [
              "private.service",
              "Private",
              "loaded",
              "active",
              "running",
              "",
              "/arbitrary/path",
            ],
          ]);
        const name = message.body[1];
        const value =
          name === "CPUUsageNSec"
            ? cpu
            : name === "MainPID"
              ? 20n
              : missing
                ? 18446744073709551615n
                : 1048576n;
        callback(null, [[{ type: "t" }], [{ toString: () => String(value) }]]);
      });
    },
  };
  const reader = new HostServiceCounters({ factory: () => bus, now: () => at });
  return {
    reader,
    bus,
    calls,
    set: (time, value, unknown = false) => {
      at = time;
      cpu = value;
      missing = unknown;
    },
  };
}

test("host D-Bus counters use exact 64-bit deltas and an allowlist of public reads", async () => {
  const f = fixture();
  const first = await f.reader.collect();
  assert.equal(first.services.length, 2);
  assert.equal(first.services[0].cpuPercent, null);
  assert.equal(first.memoryBytes, 1048576);
  f.set(2000, 90071992647409930n);
  const next = await f.reader.collect();
  assert.equal(next.services[0].cpuPercent, 10);
  assert.equal(next.cpuPercentBasis, "core");
  assert.equal(next.services[0].pid, 20);
  assert.ok(
    f.calls.every((call) => ["ListUnits", "Get"].includes(call.member)),
  );
  assert.ok(
    f.calls
      .filter((call) => call.member === "Get")
      .every((call) =>
        ["CPUUsageNSec", "MemoryCurrent", "MainPID"].includes(call.body[1]),
      ),
  );
  f.set(3000, 2n, true);
  const reset = await f.reader.collect();
  assert.equal(reset.services[0].cpuPercent, null);
  assert.equal(reset.services[0].memoryBytes, null);
  f.reader.stop();
});

test("concurrent polls coalesce, snapshots expire, and stop cancels the connection", async () => {
  const f = fixture();
  const a = f.reader.collect(),
    b = f.reader.collect();
  assert.equal(a, b);
  await a;
  assert.equal(f.calls.filter((call) => call.member === "ListUnits").length, 1);
  assert.equal(f.reader.snapshot().available, true);
  f.set(40000, 3n);
  assert.equal(f.reader.snapshot(), null);
  f.reader.stop();
  assert.equal(await f.reader.collect(), null);
  assert.equal(f.reader.pending.size, 0);
});

test("missing or denied host bus stays unavailable without crashing or retrying each poll", async () => {
  let creations = 0;
  const reader = new HostServiceCounters({
    factory: () => {
      creations++;
      const connection = new EventEmitter();
      connection.stream = { destroy() {} };
      return {
        cookies: {},
        connection,
        invoke() {
          queueMicrotask(() => connection.emit("error", Error("denied")));
        },
      };
    },
  });
  assert.equal(await reader.collect(), null);
  assert.equal(reader.pending.size, 0);
  assert.equal(await reader.collect(), null);
  assert.equal(creations, 1);
  reader.stop();
});

test("an exited one-shot with no remaining cgroup has zero current resource use", async () => {
  const f = fixture();
  const original = f.bus.invoke;
  f.bus.invoke = function (message, callback) {
    if (message.member === "ListUnits")
      return queueMicrotask(() =>
        callback(null, [
          [
            "oneshot.service",
            "Finished task",
            "loaded",
            "active",
            "exited",
            "",
            "/org/freedesktop/systemd1/unit/oneshot_2eservice",
          ],
        ]),
      );
    if (message.body[1] === "MainPID")
      return queueMicrotask(() => callback(null, [[{ type: "u" }], [0]]));
    if (message.body[1] === "ControlGroup")
      return queueMicrotask(() => callback(null, [[{ type: "s" }], [""]]));
    return original.call(this, message, (error, value) =>
      callback(
        error,
        message.body[1] === "MemoryCurrent"
          ? [[{ type: "t" }], ["18446744073709551615"]]
          : value,
      ),
    );
  };
  const report = await f.reader.collect();
  assert.equal(report.memoryBytes, 0);
  assert.equal(report.cpuPercent, 0);
  f.reader.stop();
});

test("a connection that never completes its handshake is closed instead of accumulating queued requests", async () => {
  const connection = new EventEmitter();
  let destroyed = false;
  connection.stream = {
    destroy() {
      destroyed = true;
    },
  };
  const bus = {
    cookies: {},
    connection,
    invoke(message, callback) {
      message.serial = 1;
      this.cookies[1] = callback;
    },
  };
  const reader = new HostServiceCounters({ factory: () => bus });
  assert.equal(await reader.collect(), null);
  assert.equal(destroyed, true);
  assert.equal(reader.pending.size, 0);
  assert.equal(Object.keys(bus.cookies).length, 0);
  reader.stop();
});
