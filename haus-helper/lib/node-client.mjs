import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { sign, EMPTY_DIGEST } from "./cluster-auth.mjs";
const privateAddress = (ip) =>
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
  ip === "::1" ||
  /^(fc|fd)[a-f0-9:]+$/i.test(ip);
export function nodeAddress(value, allowHttp = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_node_address");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.hostname === "169.254.169.254" ||
    (url.protocol === "http:" && !allowHttp)
  )
    throw new Error("invalid_node_address");
  return url.origin;
}
export async function nodeRequest(
  node,
  path,
  {
    method = "GET",
    data,
    file,
    digest = EMPTY_DIGEST,
    length,
    signal,
    headers = {},
    timeout = 60000,
    headerTimeout,
  } = {},
) {
  const origin = nodeAddress(node.url, node.allowHttp);
  const url = new URL(origin);
  const target = new URL(path, origin);
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !privateAddress(item.address))
    )
      throw new Error("invalid_private_node_address");
    target.hostname = addresses[0].address.includes(":")
      ? `[${addresses[0].address}]`
      : addresses[0].address;
    headers = { ...headers, Host: url.host };
  }
  let body;
  if (data !== undefined) {
    body = JSON.stringify(data);
    digest = createHash("sha256").update(body).digest("hex");
  }
  if (file) body = Readable.toWeb(createReadStream(file));
  signal?.throwIfAborted();
  const headersDeadline = new AbortController();
  const timer = headerTimeout
    ? setTimeout(() => headersDeadline.abort(), headerTimeout)
    : undefined;
  try {
    return await fetch(target, {
      method,
      body,
      duplex: body ? "half" : undefined,
      headers: {
        ...sign(node.key, method, path, digest),
        ...headers,
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(file ? { "Content-Length": String(length) } : {}),
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(timeout),
        headersDeadline.signal,
        ...(signal ? [signal] : []),
      ]),
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}
export async function nodeJson(node, path, options) {
  const response = await nodeRequest(node, path, options);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401
        ? "invalid_node_key_or_clock"
        : `Node returned ${response.status}`,
    );
  }
  const text = await response.text();
  if (text.length > 1000000) throw new Error("invalid_node_response");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_node_response");
  }
}
