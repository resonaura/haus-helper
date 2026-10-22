import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { directRecordingInput } from "./recording-input.mjs";
export class HaClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.id = 0;
    this.pending = new Map();
    this.connected = false;
    this.stopped = false;
    this.inputRegistry = { states: [], entities: [] };
    this.retry = 0;
  }
  start() {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(this.config.ws, {
      maxPayload: 32 * 1024 * 1024,
    });
    this.socket = socket;
    const timeout = setTimeout(() => socket.terminate(), 15000);
    socket.on("message", (bytes) => {
      let data;
      try {
        data = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      if (data.type === "auth_required")
        socket.send(
          JSON.stringify({ type: "auth", access_token: this.config.token }),
        );
      else if (data.type === "auth_ok") {
        clearTimeout(timeout);
        this.connected = true;
        this.retry = 0;
        void this.request({
          type: "subscribe_events",
          event_type: "state_changed",
        }).catch(() => {});
        for (const event_type of [
          "entity_registry_updated",
          "device_registry_updated",
          "area_registry_updated",
        ])
          void this.request({ type: "subscribe_events", event_type }).catch(
            () => {},
          );
        this.emit("ready");
      } else if (data.type === "auth_invalid") {
        socket.terminate();
        this.emit("status", "Authentication rejected");
      } else if (data.type === "result") {
        const item = this.pending.get(data.id);
        if (!item) return;
        this.pending.delete(data.id);
        clearTimeout(item.timer);
        data.success
          ? item.resolve(data.result)
          : item.reject(new Error(String(data.error?.code || "ha_error")));
      } else if (data.type === "event" && data.event)
        this.emit("event", data.event);
    });
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) socket.terminate();
      else {
        alive = false;
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }
    }, 25000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connected = false;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("ha_disconnected"));
      }
      this.pending.clear();
      this.emit("status", "Reconnecting");
      if (!this.stopped)
        this.reconnect = setTimeout(
          () => this.start(),
          Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5)),
        );
    });
  }
  request(message) {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("ha_disconnected"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ha_timeout"));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ ...message, id }));
    });
  }
  async registry() {
    const [states, entities, devices] = await Promise.all([
      this.request({ type: "get_states" }),
      this.request({ type: "config/entity_registry/list" }),
      this.request({ type: "config/device_registry/list" }),
    ]);
    this.inputRegistry = { states, entities };
    return { states, entities, devices };
  }
  primaryRecordingInput(camera) {
    const direct = directRecordingInput(
      camera,
      this.inputRegistry?.states ?? [],
      this.inputRegistry?.entities ?? [],
    );
    return direct
      ? {
          url: direct,
          kind: "rtsp",
          inputArguments: ["-rtsp_transport", "tcp"],
        }
      : undefined;
  }
  async recordingInput(camera, allowDirect = true) {
    return (
      (allowDirect && this.primaryRecordingInput(camera)) || {
        url: await this.stream(camera.id),
        kind: "ha",
        token: this.config.token,
        inputArguments: ["-live_start_index", "-1", "-re"],
      }
    );
  }
  async stream(cameraId) {
    const result = await this.request({
      type: "camera/stream",
      entity_id: cameraId,
      format: "hls",
    });
    const base = new URL(this.config.base);
    const url = new URL(result.url, base);
    if (
      url.origin !== base.origin ||
      !/^\/api\/hls\/[a-zA-Z0-9_-]+\//.test(url.pathname)
    )
      throw new Error("unsupported_stream_address");
    if (base.pathname !== "/")
      url.pathname = base.pathname.replace(/\/$/, "") + url.pathname;
    return url.href;
  }
  async media(value) {
    const base = new URL(this.config.base),
      url = new URL(value);
    const prefix = base.pathname.replace(/\/$/, "") + "/api/hls/";
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(prefix) ||
      url.username ||
      url.password
    )
      throw new Error("invalid_stream_address");
    return fetch(url, {
      headers: { Authorization: `Bearer ${this.config.token}` },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  }
  async snapshot(cameraId) {
    const result = await fetch(
      `${this.config.base}/api/camera_proxy/${encodeURIComponent(cameraId)}`,
      {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!result.ok) throw new Error("snapshot_unavailable");
    const mime = result.headers.get("content-type")?.split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime))
      throw new Error("invalid_snapshot");
    const buffer = Buffer.from(await result.arrayBuffer());
    if (buffer.length > 6 * 1024 * 1024) throw new Error("snapshot_too_large");
    return { buffer, mime };
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.socket?.terminate();
  }
}
