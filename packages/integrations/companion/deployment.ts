import type { IncomingMessage } from "node:http";

export interface Ao3ProxyDeployment {
  /** Explicit HTTPS origin served by the local TLS reverse proxy. No path prefix. */
  publicOrigin: string;
  /** Exact loopback peer, never an address learned from an HTTP header. */
  trustedProxyAddress: "127.0.0.1" | "::1";
}
export function normalizeAo3PublicOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0" ||
    value !== url.origin
  )
    throw new Error(
      "AO3 public origin must be a canonical HTTPS origin without credentials, path, query or fragment.",
    );
  return url.origin;
}
export function validateAo3Origin(value: string): string {
  if (["capacitor://localhost", "tauri://localhost"].includes(value))
    return value;
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    value !== url.origin ||
    url.port === "0"
  )
    throw new Error(
      "Configure explicit Avid origins without paths or wildcards.",
    );
  return value;
}
/** Fail closed before pairing, request-body parsing, or any request to AO3. */
export function createAo3AccessPolicy(
  origins: string[],
  proxy?: Ao3ProxyDeployment,
) {
  if (!origins.length || origins.length > 32)
    throw new Error("Configure between 1 and 32 explicit Avid origins.");
  const allowed = new Set(origins.map(validateAo3Origin));
  const publicHost = proxy
    ? new URL(normalizeAo3PublicOrigin(proxy.publicOrigin)).host
    : undefined;
  if (proxy && !["127.0.0.1", "::1"].includes(proxy.trustedProxyAddress))
    throw new Error(
      "The trusted AO3 reverse proxy must be an explicit loopback address.",
    );
  return (request: IncomingMessage): string => {
    const remote = request.socket.remoteAddress?.replace(/^::ffff:/, ""),
      host = request.headers.host ?? "";
    if (proxy) {
      if (
        remote !== proxy.trustedProxyAddress ||
        host !== publicHost ||
        request.headers["x-forwarded-host"] !== publicHost ||
        request.headers["x-forwarded-proto"] !== "https" ||
        request.headers.forwarded !== undefined
      )
        throw new Error(
          "The request did not arrive through the configured HTTPS reverse proxy.",
        );
    } else {
      const localHost =
        /^(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})$/.exec(host);
      if (
        !["127.0.0.1", "::1"].includes(remote ?? "") ||
        !localHost ||
        Number(localHost[2]) !== request.socket.localPort ||
        request.headers["x-forwarded-host"] !== undefined ||
        request.headers["x-forwarded-proto"] !== undefined ||
        request.headers.forwarded !== undefined
      )
        throw new Error(
          "Only direct loopback connections are accepted unless HTTPS deployment is explicitly configured.",
        );
    }
    const origin = request.headers.origin;
    if (!origin || !allowed.has(origin))
      throw new Error("This Avid origin is not allowed by the companion.");
    return origin;
  };
}
