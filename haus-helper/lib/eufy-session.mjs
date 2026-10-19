import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
export class EufySession extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.pending = new Map();
  }
  async connect() {
    this.socket = new WebSocket(this.url, { maxPayload: 8 * 1024 ** 2 });
    const socket = this.socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("eufy_timeout")), 10000);
      const finish = (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      socket.on("error", () => finish(new Error("eufy_unavailable")));
      socket.on("close", () => {
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("eufy_disconnected"));
        }
        this.pending.clear();
        this.emit("disconnected");
        finish(new Error("eufy_disconnected"));
      });
      socket.on("message", (bytes) => {
        let message;
        try {
          message = JSON.parse(bytes.toString());
        } catch {
          return;
        }
        if (message.type === "version") {
          const version = Math.min(21, message.maxSchemaVersion ?? 13);
          if (version < (message.minSchemaVersion ?? 13) || version < 13)
            return finish(new Error("eufy_schema_unsupported"));
          void this.command("set_api_schema", { schemaVersion: version })
            .then(() => this.command("start_listening"))
            .then(() => finish())
            .catch(finish);
        } else if (message.type === "event")
          this.emit("device-event", message.event);
        else if (message.messageId && this.pending.has(message.messageId)) {
          const item = this.pending.get(message.messageId);
          this.pending.delete(message.messageId);
          clearTimeout(item.timer);
          message.success === false
            ? item.reject(new Error("eufy_command_failed"))
            : item.resolve(message.result ?? {});
        }
      });
    });
  }
  command(command, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("eufy_disconnected"));
    const messageId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error("eufy_timeout"));
      }, 10000);
      this.pending.set(messageId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ messageId, command, ...params }));
    });
  }
  wait(serial, event) {
    let listener, timer;
    const promise = new Promise((resolve, reject) => {
      listener = (message) => {
        if (message?.serialNumber === serial && message.event === event) {
          clearTimeout(timer);
          this.off("device-event", listener);
          resolve();
        }
      };
      this.on("device-event", listener);
      timer = setTimeout(() => {
        this.off("device-event", listener);
        reject(new Error("eufy_event_timeout"));
      }, 10000);
    });
    promise.catch(() => {});
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        this.off("device-event", listener);
      },
    };
  }
  close() {
    this.socket?.terminate();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("eufy_disconnected"));
    }
    this.pending.clear();
    this.removeAllListeners("device-event");
  }
}
export function eufySerial(camera, registry) {
  const ids = new Set([camera.deviceId, ...(camera.deviceIds ?? [])]);
  const serials = new Set(
    (registry.devices ?? [])
      .filter((device) => ids.has(device.id))
      .flatMap((device) =>
        (device.identifiers ?? [])
          .filter(([domain]) => /eufy/i.test(domain))
          .map(([, value]) => value),
      )
      .filter(
        (value) =>
          typeof value === "string" && /^[a-zA-Z0-9_-]{8,40}$/.test(value),
      ),
  );
  return serials.size === 1 ? [...serials][0] : null;
}
