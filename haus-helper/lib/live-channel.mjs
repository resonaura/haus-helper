import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

/** Ingress-authenticated invalidations, independent of the HA event socket. No commands or credentials. */
export function liveChannel(
  server,
  { authorize, shared, ha, sources, heartbeatMs = 5000 },
) {
  const hub = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const instance = randomUUID();
  let sequence = 0;
  const state = (topic = "home") => ({
    protocol: 1,
    instance,
    sequence: ++sequence,
    topic,
    revision: shared?.get().revision ?? "0",
    connected: Boolean(ha.connected),
    ...(sources ? { sources: sources() } : {}),
  });
  const send = (socket, value) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 65536) return socket.terminate();
    socket.send(JSON.stringify(value));
  };
  const publish = (topic) => {
    const value = state(topic);
    for (const socket of hub.clients) send(socket, value);
  };
  server.on("upgrade", (req, socket, head) => {
    if (
      req.url !== "/api/live" ||
      req.headers["x-haus-client"] !== "1" ||
      !authorize(req) ||
      hub.clients.size >= 32
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    hub.handleUpgrade(req, socket, head, (client) =>
      hub.emit("connection", client),
    );
  });
  hub.on("connection", (socket) => {
    socket.alive = true;
    socket.on("pong", () => {
      socket.alive = true;
    });
    socket.on("message", () => socket.close(1008, "Read-only channel"));
    socket.on("error", () => {});
    send(socket, state());
  });
  const stopShared = shared?.subscribe(() => publish("preferences"));
  const ready = () => publish("home");
  ha.on?.("ready", ready);
  ha.on?.("status", ready);
  const timer = setInterval(() => {
    for (const socket of hub.clients) {
      if (!socket.alive) socket.terminate();
      else {
        socket.alive = false;
        socket.ping();
      }
    }
    publish("heartbeat");
  }, heartbeatMs);
  timer.unref();
  server.on("close", () => {
    clearInterval(timer);
    stopShared?.();
    ha.off?.("ready", ready);
    ha.off?.("status", ready);
    for (const socket of hub.clients) socket.terminate();
    hub.close();
  });
  return { publish };
}
