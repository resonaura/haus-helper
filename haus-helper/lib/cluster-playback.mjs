import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as pause } from "node:timers/promises";
import { fileDigest } from "./backups.mjs";
import { nodeRequest, nodeJson } from "./node-client.mjs";
import { probe } from "./media.mjs";
import { resolve } from "node:path";

export function playbackCandidates(cluster) {
  if (cluster.stopped) return [];
  return cluster
    .nodes()
    .filter((node) => {
      const health = cluster.health.get(node.id),
        remote = health?.remote;
      return (
        node.enabled &&
        node.roles.includes("stream") &&
        health?.online &&
        Date.now() - health.lastSeen < 60000 &&
        !cluster.playbackNodes.has(node.id) &&
        remote?.playback?.profile === 1 &&
        remote.playback.max > remote.playback.active &&
        remote.resources?.cpus >= 1 &&
        remote.resources.memoryBytes >= 768 * 1024 ** 2 &&
        !remote.resources.pressured
      );
    })
    .sort(
      (a, b) =>
        cluster.health.get(a.id).remote.resources.cpu -
        cluster.health.get(b.id).remote.resources.cpu,
    );
}

/** Upload an original just in time when necessary; the helper remains authoritative. */
export async function prepareClusterPlayback(
  cluster,
  event,
  { output, audioTrimSeconds = 0, signal },
) {
  const abort = AbortSignal.any([
    cluster.abort.signal,
    ...(signal ? [signal] : []),
  ]);
  const eligible = playbackCandidates(cluster);
  if (!eligible.length || cluster.stopped) return false;
  const file = cluster.store.path(event.id);
  if (resolve(output) === resolve(file))
    throw new Error("invalid_playback_output");
  const sourceInfo = await stat(file);
  if (!sourceInfo.size || sourceInfo.size > 512 * 1024 ** 2) return false;
  const digest = await fileDigest(file);
  const candidates = eligible
    .sort((a, b) => {
      const present = (node) =>
        Boolean(
          cluster.store.db
            .prepare(
              "SELECT 1 FROM cluster_locations WHERE node_id=? AND digest=? AND kind='media'",
            )
            .get(node.id, digest),
        );
      return Number(present(b)) - Number(present(a));
    })
    .slice(0, 2);
  for (const node of candidates) {
    if (cluster.playbackNodes.has(node.id)) continue;
    cluster.playbackNodes.add(node.id);
    let releaseSource;
    let id,
      outputCreated = false,
      complete = false;
    try {
      releaseSource = await cluster.pinBlob(node.id, digest);
      abort.throwIfAborted();
      const head = await nodeRequest(node, `/v1/blobs/${digest}`, {
        method: "HEAD",
        signal: abort,
        timeout: 5000,
      });
      const exists = head.ok;
      await head.body?.cancel();
      if (!exists) {
        const storage = cluster.health.get(node.id)?.remote?.storage;
        const available =
          storage?.availableBytes ??
          storage?.maxBytes -
            storage?.usedBytes -
            (storage?.reservedBytes ?? 0);
        if (Number.isFinite(available) && available < sourceInfo.size)
          throw new Error("storage_full");
        const uploaded = await nodeRequest(node, `/v1/blobs/${digest}`, {
          method: "PUT",
          file,
          digest,
          length: sourceInfo.size,
          signal: abort,
          timeout: 120000,
        });
        if (!uploaded.ok) {
          await uploaded.body?.cancel();
          throw new Error("source_upload_failed");
        }
        await uploaded.body?.cancel();
        // The node returns 201 only when this request created the immutable blob;
        // 200 means a concurrent/pre-existing owner won the atomic insertion.
        if (uploaded.status === 201)
          cluster.notePlaybackUpload(node.id, digest);
      }
      const source = await nodeRequest(node, `/v1/blobs/${digest}`, {
        method: "HEAD",
        signal: abort,
        timeout: 10000,
      });
      await source.body?.cancel();
      if (
        source.status !== 200 ||
        Number(source.headers.get("content-length")) !== sourceInfo.size
      )
        continue;
      let result = await nodeJson(node, "/v1/playback", {
        method: "POST",
        // Learn the accepted job ID even if playback is cancelled while this
        // bounded registration is in flight, so finally can stop its encoder.
        timeout: 15000,
        data: { digest, profile: 1, audioTrimSeconds },
      });
      if (typeof result.id !== "string" || !/^[a-f0-9-]{36}$/.test(result.id))
        throw new Error("invalid_playback_job");
      id = result.id;
      abort.throwIfAborted();
      const deadline =
        performance.now() +
        Math.min(240000, Math.max(60000, (Number(event.duration) || 0) * 3000));
      while (result.status === "preparing" && performance.now() < deadline) {
        await pause(1000, undefined, { signal: abort });
        if (
          !cluster
            .nodes()
            .some((current) => current.id === node.id && current.enabled)
        )
          throw new Error("playback_node_disabled");
        result = await nodeJson(node, `/v1/playback/${id}`, {
          signal: abort,
          timeout: 15000,
        });
      }
      if (
        result.id !== id ||
        result.status !== "ready" ||
        result.profile !== 1 ||
        !Number.isSafeInteger(result.bytes) ||
        result.bytes <= 0 ||
        result.bytes > 256 * 1024 ** 2 ||
        typeof result.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(result.digest) ||
        !Number.isFinite(result.duration) ||
        result.duration <= 0 ||
        typeof result.audio !== "boolean"
      )
        throw new Error("invalid_prepared_media");
      const response = await nodeRequest(node, `/v1/playback/${id}/media`, {
        signal: abort,
        timeout: 120000,
      });
      if (
        response.status !== 200 ||
        Number(response.headers.get("content-length")) !== result.bytes
      ) {
        await response.body?.cancel();
        throw new Error("invalid_prepared_media");
      }
      let bytes = 0;
      const hash = createHash("sha256");
      const verify = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > result.bytes)
            return callback(new Error("invalid_prepared_media"));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const writer = createWriteStream(output, { flags: "wx", mode: 0o600 });
      writer.once("open", () => {
        outputCreated = true;
      });
      await pipeline(Readable.fromWeb(response.body), verify, writer);
      if (bytes !== result.bytes || hash.digest("hex") !== result.digest)
        throw new Error("digest_mismatch");
      const info = await probe(output);
      abort.throwIfAborted();
      if (
        info.codec !== "h264" ||
        info.audio !== result.audio ||
        Math.abs(info.duration - result.duration) > 0.5
      )
        throw new Error("invalid_prepared_media");
      complete = true;
      return true;
    } catch {
      abort.throwIfAborted();
      // If a worker accepted a task but failed, local processing remains the
      // bounded fallback; do not repeat a long conversion on every other node.
      if (id) return false;
    } finally {
      if (!complete && outputCreated) await unlink(output).catch(() => {});
      if (id)
        await nodeRequest(node, `/v1/playback/${id}`, {
          method: "DELETE",
          timeout: 5000,
        })
          .then((response) => response.body?.cancel())
          .catch(() => {});
      releaseSource?.();
      cluster.playbackNodes.delete(node.id);
    }
  }
  return false;
}
