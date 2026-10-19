import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export const EMPTY_DIGEST =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export function sign(
  key,
  method,
  path,
  digest = EMPTY_DIGEST,
  now = Date.now(),
  nonce = randomBytes(16).toString("hex"),
) {
  const time = String(now);
  const signature = createHmac("sha256", key)
    .update([method, path, time, nonce, digest].join("\n"))
    .digest("hex");
  return {
    "x-haus-time": time,
    "x-haus-nonce": nonce,
    "x-haus-digest": digest,
    "x-haus-signature": signature,
  };
}
export function authenticator(key, clock = () => Date.now()) {
  if (typeof key !== "string" || Buffer.byteLength(key) < 32)
    throw new Error("A unique node key of at least 32 bytes is required");
  const nonces = new Map();
  return (req) => {
    const time = req.headers["x-haus-time"],
      nonce = req.headers["x-haus-nonce"],
      digest = req.headers["x-haus-digest"],
      signature = req.headers["x-haus-signature"];
    const now = clock();
    if (
      !/^\d{13}$/.test(time) ||
      Math.abs(now - Number(time)) > 60000 ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      return false;
    for (const [id, at] of nonces) if (now - at > 65000) nonces.delete(id);
    if (nonces.has(nonce) || nonces.size >= 10000) return false;
    const expected = sign(
      key,
      req.method,
      req.url,
      digest,
      Number(time),
      nonce,
    )["x-haus-signature"];
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      return false;
    nonces.set(nonce, now);
    return true;
  };
}
