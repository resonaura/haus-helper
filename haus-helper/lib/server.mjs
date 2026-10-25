import { Servers } from "./servers.mjs";
import { rewritePlaylist } from "./warm-streams.mjs";
import { motionSettings } from "./motion-settings.mjs";
import { createTalkback, customTalkback } from "./talkback.mjs";
import { createServer } from "node:http";
import metadata from "../package.json" with { type: "json" };
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { detectionKind } from "./discovery.mjs";
import { parseRange } from "./media.mjs";
import { PlaybackPreparation } from "./playback-preparation.mjs";
const web = join(dirname(fileURLToPath(import.meta.url)), "../web");
const publicCamera = (camera) => {
  if (!camera) return undefined;
  const { talkback, ...visible } = camera;
  return { ...visible, talkbackConfigured: Boolean(talkback) };
};
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
  cluster,
  backups,
  shared,
  warm,
  motion,
  cameraSessions,
  servers = store?.db
    ? new Servers({ config, ha, store, cluster, backups })
    : null,
}) {
  const talkback = createTalkback({ config });
  const preparation = new PlaybackPreparation(recorder);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://haus.invalid");
      const path = url.pathname;
      const address = req.socket.remoteAddress?.replace(/^::ffff:/, "");
      if (path === "/health" && ["127.0.0.1", "::1"].includes(address))
        return json(res, 200, { status: "ok" });
      const sourceMatch =
        /^\/cluster\/source\/([a-f0-9]{48})\/([a-f0-9]{24}(?:\.(?:m3u8|ts|m4s|mp4|aac|key))?)$/.exec(
          path,
        );
      if (warm && sourceMatch && req.method === "GET") {
        const upstream = await warm.source(sourceMatch[1], sourceMatch[2]);
        if (!upstream.response.ok) {
          await upstream.response.body?.cancel();
          return json(res, 503, { error: "source_unavailable" });
        }
        const mime =
          upstream.response.headers.get("content-type") ??
          "application/octet-stream";
        if (/mpegurl/i.test(mime) || upstream.url.pathname.endsWith(".m3u8")) {
          const text = await upstream.response.text();
          if (text.length > 256000) throw new Error("invalid_playlist");
          const body = rewritePlaylist(
            text,
            upstream.url.href,
            (value) =>
              `/cluster/source/${sourceMatch[1]}/${warm.resource(upstream.entry, value)}`,
          );
          return res
            .writeHead(200, {
              "Content-Type": "application/vnd.apple.mpegurl",
              "Cache-Control": "no-store",
            })
            .end(body);
        }
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
        });
        await pipeline(upstream.response.body, res).catch(() => {});
        return;
      }
      const authorized = config.standalone
        ? safeEqual(req.headers.authorization, `Bearer ${config.apiToken}`)
        : address === "172.30.32.2";
      if (!authorized)
        return json(res, 401, { error: "authentication_required" });
      if (
        !config.standalone &&
        req.method !== "GET" &&
        /^\/api\/(cluster|backups|servers)(?:\/|$)/.test(path)
      ) {
        const id = req.headers["x-remote-user-id"];
        let users;
        try {
          users = await ha.request({ type: "config/auth/list" });
        } catch {
          return json(res, 503, {
            error: "administrator_verification_unavailable",
          });
        }
        const user = users.find((user) => user.id === id);
        if (
          !user?.is_active ||
          !(user.is_owner || user.group_ids?.includes("system-admin"))
        )
          return json(res, 403, { error: "administrator_required" });
      }
      if (
        req.method === "GET" &&
        ["/", "/index.html", "/app.js", "/style.css", "/icon.png"].includes(
          path,
        )
      ) {
        const filename = path === "/" ? "index.html" : path.slice(1);
        const type = {
          html: "text/html",
          js: "text/javascript",
          css: "text/css",
          png: "image/png",
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
      if (shared && path === "/api/preferences") {
        if (req.method === "GET") return json(res, 200, shared.get());
        if (req.method === "PATCH") {
          const input = await requestBody(req);
          const result = shared.patch(input.baseRevision, input.patch);
          return json(res, result.conflict ? 409 : 200, result);
        }
      }
      if (servers && path === "/api/servers" && req.method === "GET")
        return json(res, 200, await servers.status());
      if (
        servers &&
        path === "/api/servers/home-assistant" &&
        req.method === "PATCH"
      ) {
        servers.update(await requestBody(req));
        return json(res, 200, await servers.status());
      }
      if (cluster && path === "/api/cluster" && req.method === "GET")
        return json(res, 200, cluster.status());
      if (cluster && path === "/api/cluster/nodes" && req.method === "POST")
        return json(res, 201, await cluster.add(await requestBody(req)));
      const nodeMatch =
        /^\/api\/cluster\/nodes\/([a-f0-9-]{36})(\/remove)?$/.exec(path);
      if (cluster && nodeMatch && ["POST", "PATCH"].includes(req.method)) {
        const input = await requestBody(req);
        return json(
          res,
          200,
          nodeMatch[2] && req.method === "POST"
            ? cluster.remove(nodeMatch[1])
            : await cluster.update(nodeMatch[1], input),
        );
      }
      if (backups && path === "/api/backups" && req.method === "GET")
        return json(res, 200, {
          items: backups.list(),
          busy: backups.busy,
          error: backups.error,
        });
      if (
        backups &&
        path === "/api/backups/recovery" &&
        req.method === "POST"
      ) {
        await requestBody(req);
        return json(res, 200, {
          ...backups.recoveryKit(),
          nodes: cluster?.nodes() ?? [],
        });
      }
      if (backups && path === "/api/backups/create" && req.method === "POST") {
        const input = await requestBody(req);
        if (!["haus", "ha"].includes(input.kind))
          throw new Error("invalid_backup_kind");
        if (
          backups.canSnapshot ? !backups.canSnapshot(input.kind) : backups.busy
        )
          return json(res, 409, { error: "backup_busy" });
        if (input.kind === "ha" && config.standalone)
          return json(res, 409, { error: "supervisor_backups_unavailable" });
        void backups
          .snapshot(input.kind)
          .then(() => cluster?.tick())
          .catch(() => {});
        return json(res, 202, { started: true });
      }
      if (req.method === "GET" && path === "/api/status")
        return json(res, 200, {
          name: "Haus",
          version: metadata.version,
          features: {
            eufyTalkback: true,
            cluster: true,
            sharedPreferences: true,
            previewPreheat: true,
            nvrCameraSessions: !!cameraSessions,
            softwareMotion: !!motion,
            customTalkback: true,
            recordingRepair: true,
            verifiedOriginalPlayback: true,
          },
          connected: ha.connected,
          recordingEnabled: config.recording_enabled,
          storage: {
            ...store.totals(),
            maxBytes:
              config.max_storage_gb > 0
                ? config.max_storage_gb * 1024 ** 3
                : null,
            retentionDays: config.retention_days,
          },
          buffers: recorder.status(),
          processing: recorder.processingStatus?.(),
        });
      if (req.method === "GET" && path === "/api/cameras")
        return json(res, 200, {
          cameras: await Promise.all(
            getRegistry().cameras.map(async (camera) => ({
              ...publicCamera(camera),
              ...(motion ? { motionStatus: motion.status(camera.id) } : {}),
              talkAvailable: await talkback.available(camera, getRegistry()),
            })),
          ),
        });
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
      if (req.method === "GET" && path === "/api/events/calendar") {
        const requestedId = url.searchParams.get("camera_id");
        if (!/^camera\.[a-z0-9_]+$/.test(requestedId ?? ""))
          throw new Error("invalid_camera");
        const boundaries = (url.searchParams.get("boundaries") ?? "")
          .split(",")
          .map(Number);
        if (
          boundaries.length < 2 ||
          boundaries.length > 32 ||
          boundaries.some(
            (at, index) =>
              !Number.isSafeInteger(at) ||
              at < 0 ||
              (index > 0 &&
                (at <= boundaries[index - 1] ||
                  at - boundaries[index - 1] > 48 * 3600000)),
          )
        )
          throw new Error("invalid_calendar");
        const cameraId =
          getRegistry().cameras.find(
            (item) =>
              item.id === requestedId || item.aliases?.includes(requestedId),
          )?.id ?? requestedId;
        return json(res, 200, {
          days: store.recordedDays({ cameraId, boundaries }),
        });
      }
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
        const status = url.searchParams.get("status") || undefined;
        if (
          status &&
          !["ready", "failed", "interrupted", "recording"].includes(status)
        )
          throw new Error("invalid_status");
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
        const direction = url.searchParams.get("direction") ?? "older";
        if (!["older", "newer"].includes(direction))
          throw new Error("invalid_direction");
        const filters = {
          direction,
          cameraId:
            getRegistry().cameras.find(
              (item) =>
                item.id === cameraId || item.aliases?.includes(cameraId),
            )?.id ?? cameraId,
          from: number("from", 0),
          to: number("to", Date.now() + 60000),
          limit: Math.min(200, Math.max(1, number("limit", 60))),
          cursor: url.searchParams.get("cursor") || undefined,
          kind,
          status,
        };
        return json(res, 200, {
          ...store.list(filters),
          availability: store.availability(filters),
        });
      }
      const cameraMatch =
        /^\/api\/cameras\/(camera\.[a-z0-9_]+)(?:\/(record|snapshot|talk|warm|viewer(?:\/close)?))?$/.exec(
          path,
        );
      if (cameraMatch) {
        const requestedId = cameraMatch[1];
        const camera = getRegistry().cameras.find(
          (item) =>
            item.id === requestedId || item.aliases?.includes(requestedId),
        );
        const id = camera?.id;
        if (!camera) return json(res, 404, { error: "camera_not_found" });
        if (
          cameraSessions &&
          req.method === "POST" &&
          cameraMatch[2]?.startsWith("viewer")
        ) {
          const input = await requestBody(req);
          return json(
            res,
            200,
            cameraMatch[2] === "viewer/close"
              ? await cameraSessions.closeViewer(
                  id,
                  input.owner,
                  input.viewerId,
                )
              : await cameraSessions.viewer(
                  camera,
                  input.owner,
                  input.viewerId,
                  input.offer,
                ),
          );
        }
        if (warm && req.method === "POST" && cameraMatch[2] === "warm") {
          const input = await requestBody(req);
          if (typeof input.active !== "boolean")
            throw new Error("invalid_warm_session");
          return json(
            res,
            200,
            await warm.touch(
              camera,
              input.owner,
              input.active,
              input.preview === true,
            ),
          );
        }
        if (req.method === "POST" && cameraMatch[2] === "talk")
          return await talkback.stream(camera, getRegistry(), req, res);
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
          if (body.talkback !== undefined)
            next.talkback = customTalkback(body.talkback, getRegistry());
          if (body.motionDetection !== undefined)
            next.motionDetection = motionSettings(body.motionDetection);
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
          backups?.markChanged();
          await refresh();
          return json(res, 200, {
            camera: publicCamera(
              getRegistry().cameras.find((item) => item.id === id),
            ),
          });
        }
      }
      const liveMatch =
        /^\/api\/cameras\/(camera\.[a-z0-9_]+)\/live\/(index\.m3u8|segment-\d+\.ts)$/.exec(
          path,
        );
      if (warm && liveMatch && req.method === "GET") {
        const entry = warm.entries.get(liveMatch[1]);
        if (!entry?.job) return json(res, 404, { error: "stream_not_ready" });
        const response = await (
          await import("./node-client.mjs")
        ).nodeRequest(
          entry.job.node,
          `/v1/streams/${entry.job.id}/${liveMatch[2]}`,
          { timeout: 15000 },
        );
        if (!response.ok) {
          await response.body?.cancel();
          return json(res, 503, { error: "stream_unavailable" });
        }
        const mime = liveMatch[2].endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t";
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
        });
        await pipeline(response.body, res).catch(() => {});
        return;
      }
      const eventMatch =
        /^\/api\/events\/([a-f0-9-]{36})(?:\/(video|thumbnail|prepare|prepare-next|source|original|repair))?$/.exec(
          path,
        );
      if (
        eventMatch &&
        ((["GET", "HEAD"].includes(req.method) && eventMatch[2] !== "repair") ||
          (req.method === "POST" && eventMatch[2] === "repair"))
      ) {
        const requestAbort = new AbortController();
        const signal = cluster?.abort?.signal
          ? AbortSignal.any([requestAbort.signal, cluster.abort.signal])
          : requestAbort.signal;
        const closeRequest = () => requestAbort.abort();
        const abortResponse = () => res.destroy();
        res.once("close", closeRequest);
        signal.addEventListener("abort", abortResponse, { once: true });
        let releaseEvent;
        try {
          releaseEvent = await store.pinMedia(eventMatch[1], signal);
          const event = store.get(eventMatch[1]);
          if (!event) return json(res, 404, { error: "event_not_found" });
          if (!eventMatch[2]) return json(res, 200, event);
          if (event.status !== "ready")
            return json(res, 409, { error: "video_not_ready" });
          if (eventMatch[2] === "source")
            return json(res, 200, {
              source: (await cluster?.source(event)) ?? null,
            });
          if (["prepare", "prepare-next", "repair"].includes(eventMatch[2])) {
            if (eventMatch[2] === "repair") {
              const body = await requestBody(req);
              if (
                !body ||
                typeof body !== "object" ||
                Array.isArray(body) ||
                Object.keys(body).length
              )
                throw new Error("invalid_repair_request");
            }
            const options = {
              forceCompatibility:
                eventMatch[2] === "repair" ||
                req.headers["x-haus-compatibility-repair"] === "1",
            };
            if (
              eventMatch[2] === "repair" ||
              req.headers["x-haus-async-prepare"] === "1"
            ) {
              const state = preparation.status(
                event,
                eventMatch[2] === "prepare-next" ? 0 : 20,
                options,
              );
              if (state === "preparing")
                return json(res, 202, { status: state, retryAfterMs: 1000 });
              if (state !== "ready")
                return json(res, 503, { error: "preparation_failed" });
              return json(res, 200, store.get(event.id));
            }
            await recorder.preparePlayback(
              event,
              eventMatch[2] === "prepare-next" ? 0 : 20,
              options,
            );
            return json(res, 200, store.get(event.id));
          }
          const original = eventMatch[2] === "original";
          const variant =
            original || !event.playbackBytes ? "original" : "prepared";
          const local =
            variant === "original" ? event.localOriginal : event.localPlayback;
          const knownArchive =
            (original || eventMatch[2] === "video") &&
            local &&
            store.db
              .prepare(
                "SELECT 1 FROM event_archive a JOIN event_archive_locations l USING(event_id,variant,digest,version) WHERE a.event_id=? AND a.variant=? AND a.version=? LIMIT 1",
              )
              .get(
                event.id,
                variant,
                variant === "prepared" ? event.playbackVersion : 0,
              );
          const missingLocal =
            knownArchive &&
            (await stat(
              store.path(
                event.id,
                variant === "prepared" ? "playback.mp4" : "mp4",
              ),
            ).then(
              () => false,
              (error) => error.code === "ENOENT",
            ));
          if (missingLocal) store.setLocal(event.id, variant, false);
          if (
            (original || eventMatch[2] === "video") &&
            (!local || missingLocal) &&
            cluster?.archiveMedia
          ) {
            const archived = await cluster.archiveMedia(
              event,
              variant,
              req.headers.range,
              signal,
              req.method,
            );
            if (!archived)
              return json(res, 503, { error: "archived_media_unavailable" });
            try {
              const remote = archived.response;
              const headers = {
                "Content-Type": "video/mp4",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=3600",
              };
              for (const key of [
                "content-length",
                "content-range",
                "accept-ranges",
              ])
                if (remote.headers.get(key))
                  headers[key] = remote.headers.get(key);
              res.writeHead(remote.status, headers);
              if (req.method === "HEAD") {
                await remote.body?.cancel();
                res.end();
              } else {
                res.flushHeaders();
                await pipeline(remote.body, res).catch(() => {});
              }
              return;
            } finally {
              archived.release();
            }
          }
          const type = original || eventMatch[2] === "video" ? "mp4" : "jpg";
          const file =
            type === "mp4" && !original && recorder.preparePlayback
              ? await recorder.preparePlayback(event)
              : store.path(event.id, type);
          if (type === "mp4" && !original && cluster && req.method === "GET") {
            const remote = await cluster.media(
              store.get(event.id),
              req.headers.range,
              signal,
            );
            if (remote) {
              const headers = {
                "Content-Type": "video/mp4",
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=3600",
              };
              for (const key of [
                "content-length",
                "content-range",
                "accept-ranges",
              ])
                if (remote.headers.get(key))
                  headers[key] = remote.headers.get(key);
              res.writeHead(remote.status, headers);
              await pipeline(remote.body, res).catch(() => {});
              return;
            }
          }
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
        } finally {
          releaseEvent?.();
          res.off("close", closeRequest);
          signal.removeEventListener("abort", abortResponse);
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      const message = String(error.message);
      if (message === "archived_original_required_for_repair")
        return json(res, 503, { error: message });
      if (message === "recording_storage_limit")
        return json(res, 409, { error: message });
      const client =
        /^(invalid_|json_required|body_too_large|recording_disabled)/.test(
          message,
        );
      json(res, client ? 400 : 503, {
        error: client ? message : "service_temporarily_unavailable",
      });
    }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  server.on("close", talkback.stopAll);
  server.on("close", () => preparation.clear());
  server.on("close", () => servers?.telemetry?.stop());
  return server;
}
