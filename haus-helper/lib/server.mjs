import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { detectionKind } from "./discovery.mjs";
import { parseRange } from "./media.mjs";
const web = join(dirname(fileURLToPath(import.meta.url)), "../web");
const safeEqual = (a, b) => {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
};
const json = (res, status, value) =>
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    })
    .end(JSON.stringify(value));
export async function requestBody(req) {
  if (
    !String(req.headers["content-type"]).startsWith("application/json") ||
    req.headers["x-haus-client"] !== "1"
  )
    throw new Error("json_required");
  let text = "";
  for await (const bytes of req) {
    text += bytes;
    if (Buffer.byteLength(text) > 65536) throw new Error("body_too_large");
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}
export function createApi({
  config,
  ha,
  store,
  recorder,
  getRegistry,
  refresh,
}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://haus.invalid");
      const path = url.pathname;
      const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (path === "/health" && ["127.0.0.1", "::1"].includes(address))
        return json(res, 200, { status: "ok" });
      const authorized = config.standalone
        ? safeEqual(req.headers.authorization, `Bearer ${config.apiToken}`)
        : address === "172.30.32.2";
      if (!authorized)
        return json(res, 401, { error: "authentication_required" });
      if (
        req.method === "GET" &&
        ["/", "/index.html", "/app.js", "/style.css", "/icon.svg"].includes(
          path,
        )
      ) {
        const filename = path === "/" ? "index.html" : path.slice(1);
        const type = {
          html: "text/html",
          js: "text/javascript",
          css: "text/css",
          svg: "image/svg+xml",
        }[filename.split(".").at(-1)];
        const bytes = await readFile(join(web, filename));
        res
          .writeHead(200, {
            "Content-Type": `${type}; charset=utf-8`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-cache",
          })
          .end(bytes);
        return;
      }
      if (req.method === "GET" && path === "/api/status")
        return json(res, 200, {
          name: "Haus",
          version: "0.1.0",
          connected: ha.connected,
          recordingEnabled: config.recording_enabled,
          storage: {
            ...store.totals(),
            maxBytes: config.max_storage_gb * 1024 ** 3,
            retentionDays: config.retention_days,
          },
          buffers: recorder.status(),
        });
      if (req.method === "GET" && path === "/api/cameras")
        return json(res, 200, { cameras: getRegistry().cameras });
      if (req.method === "GET" && path === "/api/detectors")
        return json(res, 200, {
          detectors: getRegistry()
            .states.filter((state) => detectionKind(state))
            .map((state) => ({
              id: state.entity_id,
              name: state.attributes.friendly_name ?? state.entity_id,
              kind: detectionKind(state),
            })),
        });
      if (req.method === "GET" && path === "/api/events") {
        const cameraId = url.searchParams.get("camera_id") || undefined;
        if (cameraId && !/^camera\.[a-z0-9_]+$/.test(cameraId))
          throw new Error("invalid_camera");
        const number = (key, fallback) => {
          const raw = url.searchParams.get(key);
          const value = raw === null ? fallback : Number(raw);
          if (!Number.isSafeInteger(value) || value < 0)
            throw new Error("invalid_filter");
          return value;
        };
        const kind = url.searchParams.get("kind") || undefined;
        if (
          kind &&
          ![
            "motion",
            "person",
            "pet",
            "vehicle",
            "doorbell",
            "manual",
          ].includes(kind)
        )
          throw new Error("invalid_kind");
        return json(
          res,
          200,
          store.list({
            cameraId,
            from: number("from", 0),
            to: number("to", Date.now() + 60000),
            limit: Math.min(200, Math.max(1, number("limit", 60))),
            cursor: url.searchParams.get("cursor") || undefined,
            kind,
          }),
        );
      }
      const cameraMatch =
        /^\/api\/cameras\/(camera\.[a-z0-9_]+)(?:\/(record|snapshot))?$/.exec(
          path,
        );
      if (cameraMatch) {
        const id = cameraMatch[1];
        const camera = getRegistry().cameras.find((item) => item.id === id);
        if (!camera) return json(res, 404, { error: "camera_not_found" });
        if (req.method === "GET" && cameraMatch[2] === "snapshot") {
          const image = await ha.snapshot(id);
          return res
            .writeHead(200, {
              "Content-Type": image.mime,
              "Cache-Control": "no-store",
            })
            .end(image.buffer);
        }
        if (req.method === "POST" && cameraMatch[2] === "record") {
          await requestBody(req);
          return json(res, 201, recorder.trigger(id));
        }
        if (req.method === "PATCH" && !cameraMatch[2]) {
          const body = await requestBody(req);
          const old = store.overrides()[id] ?? {};
          const next = { ...old };
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== "boolean")
              throw new Error("invalid_enabled");
            next.enabled = body.enabled;
          }
          if (body.sensorIds !== undefined) {
            if (body.sensorIds === null) delete next.sensorIds;
            else {
              if (
                !Array.isArray(body.sensorIds) ||
                body.sensorIds.length > 64 ||
                body.sensorIds.some(
                  (sensor) =>
                    !getRegistry().states.some(
                      (state) =>
                        state.entity_id === sensor && detectionKind(state),
                    ),
                )
              )
                throw new Error("invalid_detectors");
              next.sensorIds = [...new Set(body.sensorIds)];
            }
          }
          store.setCamera(id, next);
          await refresh();
          return json(res, 200, {
            camera: getRegistry().cameras.find((item) => item.id === id),
          });
        }
      }
      const eventMatch =
        /^\/api\/events\/([a-f0-9-]{36})(?:\/(video|thumbnail))?$/.exec(path);
      if (eventMatch && ["GET", "HEAD"].includes(req.method)) {
        const event = store.get(eventMatch[1]);
        if (!event) return json(res, 404, { error: "event_not_found" });
        if (!eventMatch[2]) return json(res, 200, event);
        if (event.status !== "ready")
          return json(res, 409, { error: "video_not_ready" });
        const type = eventMatch[2] === "video" ? "mp4" : "jpg";
        const file = store.path(event.id, type);
        let info;
        try {
          info = await stat(file);
        } catch {
          return json(res, 404, { error: "media_not_found" });
        }
        let range;
        try {
          range = parseRange(req.headers.range, info.size);
        } catch {
          return res
            .writeHead(416, { "Content-Range": `bytes */${info.size}` })
            .end();
        }
        const headers = {
          "Content-Type": type === "mp4" ? "video/mp4" : "image/jpeg",
          "Content-Length": range.end - range.start + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        };
        if (range.partial)
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${info.size}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        if (req.method === "HEAD") return res.end();
        await pipeline(
          createReadStream(file, { start: range.start, end: range.end }),
          res,
        ).catch(() => {});
        return;
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const message = String(error.message);
      const client =
        /^(invalid_|json_required|body_too_large|recording_disabled)/.test(
          message,
        );
      json(res, client ? 400 : 503, {
        error: client ? message : "service_temporarily_unavailable",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
