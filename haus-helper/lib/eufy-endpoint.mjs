import { isIP } from "node:net";
/** Supervisor is the authority for the installed app's address; no credentials leave the helper. */
export function eufyEndpoint(
  config,
  { fetchRequest = fetch, now = () => Date.now() } = {},
) {
  let cached,
    until = 0,
    pending;
  return async () => {
    if (config.eufy_ws_url) return config.eufy_ws_url;
    if (config.standalone || !config.token) return undefined;
    if (until > now()) return cached;
    if (pending) return pending;
    pending = (async () => {
      const get = async (path) => {
        const response = await fetchRequest(`http://supervisor${path}`, {
          headers: { Authorization: `Bearer ${config.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("eufy_discovery_unavailable");
        return (await response.json()).data;
      };
      cached = undefined;
      try {
        // The backup role permits */info but intentionally cannot enumerate /addons.
        const list = await get("/supervisor/info");
        const apps = (list?.addons ?? []).filter(
          (app) =>
            /(?:^|_)eufy_security_ws$/.test(app.slug) &&
            app.state === "started",
        );
        if (apps.length !== 1) return;
        const info = await get(`/addons/${apps[0].slug}/info`);
        const host = info.ip_address;
        const privateHost =
          isIP(host) === 4 &&
          /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
        const port = Number(info.options?.port ?? 3000);
        if (privateHost && Number.isInteger(port) && port > 0 && port <= 65535)
          cached = `ws://${host}:${port}/`;
      } catch {
        /* An explicit endpoint remains available for external installations. */
      } finally {
        until = now() + 60000;
      }
      return cached;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
