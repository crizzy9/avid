import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAo3AccessPolicy,
  type Ao3ProxyDeployment,
} from "./deployment.ts";

const AO3 = "https://archiveofourown.org";
const MAX_HTML = 8 * 1024 * 1024;
const MAX_EPUB = 64 * 1024 * 1024;
const decode = (value: string) =>
  value.replace(
    /&(?:amp|quot|apos|lt|gt|#39);/g,
    (entity) =>
      ({
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&#39;": "'",
        "&lt;": "<",
        "&gt;": ">",
      })[entity]!,
  );
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
      match[1].toLowerCase(),
      decode(match[3]),
    ]),
  );
}
function csrf(html: string): string {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const attrs = attributes(tag);
    if (attrs.name === "authenticity_token" && attrs.value) return attrs.value;
  }
  throw new ConnectorError(
    "AO3 did not provide its expected sign-in form. Open AO3 in your browser to resolve any service challenge.",
    422,
  );
}
function signedInUser(html: string): string | null {
  const greeting = [...html.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)].find(
    (match) => attributes(match[1]).id === "greeting",
  )?.[2];
  if (!greeting) return null;
  for (const tag of greeting.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attributes(tag).href;
    if (!href) continue;
    const match = /^\/users\/([^/?#]+)$/.exec(href);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}
export class ConnectorError extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 502, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
class CookieJar {
  private cookies = new Map<
    string,
    { value: string; path: string; expires: number }
  >();
  receive(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...parts] = header.split(";");
      const equals = pair.indexOf("=");
      if (equals < 1) continue;
      const name = pair.slice(0, equals).trim(),
        value = pair.slice(equals + 1);
      const attrs = new Map(
        parts.map((part) => {
          const [key, ...rest] = part.trim().split("=");
          return [key.toLowerCase(), rest.join("=")];
        }),
      );
      const domain = attrs.get("domain")?.replace(/^\./, "").toLowerCase();
      if (domain && domain !== "archiveofourown.org") continue;
      const maxAge = attrs.get("max-age");
      const expires =
        maxAge !== undefined
          ? Date.now() + Number(maxAge) * 1000
          : Date.parse(attrs.get("expires") ?? "") || Infinity;
      if (!value || expires <= Date.now()) this.cookies.delete(name);
      else
        this.cookies.set(name, {
          value,
          path: attrs.get("path") ?? "/",
          expires,
        });
    }
  }
  header(path: string) {
    return [...this.cookies]
      .filter(
        ([, cookie]) =>
          cookie.expires > Date.now() &&
          (path === cookie.path ||
            path.startsWith(
              cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
            )),
      )
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; ");
  }
}
type ActiveSession = {
  id: string;
  username: string;
  jar: CookieJar;
  downloads: Set<string>;
  touched: number;
};
type UpstreamPage = { url: string; html: string };
async function boundedBody(
  response: Response,
  maximum: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectorError(
      "AO3 response exceeds this connector’s size limit.",
      413,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum)
        throw new ConnectorError(
          "AO3 response exceeds this connector’s size limit.",
          413,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Separate in-memory AO3 sessions. This service has no BookOrbit transport or credentials. */
export class Ao3SessionService {
  private sessions = new Map<string, ActiveSession>();
  private transport: typeof fetch;
  private minimumInterval: number;
  private lastRequest = 0;
  private blockedUntil = 0;
  private signingIn = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    options: { fetch?: typeof fetch; minimumIntervalMs?: number } = {},
  ) {
    this.transport = options.fetch ?? fetch;
    this.minimumInterval = options.minimumIntervalMs ?? 1500;
  }
  private upstream(
    jar: CookieJar,
    path: string,
    init: RequestInit = {},
    maximum = MAX_HTML,
  ): Promise<{ url: string; body: Uint8Array }> {
    const run = async () => {
      if (this.blockedUntil > Date.now())
        throw new ConnectorError(
          "AO3 asked this connector to wait before another request.",
          429,
          Math.ceil((this.blockedUntil - Date.now()) / 1000),
        );
      let url = new URL(path, AO3),
        method = init.method ?? "GET",
        body = init.body;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (url.origin !== AO3 || url.username || url.password)
          throw new ConnectorError(
            "AO3 redirected outside the allowed archive origin.",
            422,
          );
        const delay = Math.max(
          0,
          this.lastRequest + this.minimumInterval - Date.now(),
        );
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        this.lastRequest = Date.now();
        const response = await this.transport(url.href, {
          method,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: maximum === MAX_EPUB ? "application/epub+zip" : "text/html",
            "User-Agent": "Avid/0.1 (user-initiated AO3 reader connector)",
            Cookie: jar.header(url.pathname),
            ...(method === "POST"
              ? {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Origin: AO3,
                  Referer: `${AO3}/users/login`,
                }
              : {}),
          },
        });
        jar.receive(response);
        if (response.status === 429 || response.status === 503) {
          const header = response.headers.get("retry-after") ?? "";
          const seconds = /^\d+$/.test(header)
            ? Number(header)
            : Math.ceil((Date.parse(header) - Date.now()) / 1000);
          const retryAfter = Math.min(
            86_400,
            Math.max(60, Number.isFinite(seconds) ? seconds : 60),
          );
          this.blockedUntil = Date.now() + retryAfter * 1000;
          await response.body?.cancel();
          throw new ConnectorError(
            "AO3 is rate limiting or temporarily unavailable. Retry later.",
            429,
            retryAfter,
          );
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location)
            throw new ConnectorError("AO3 returned an incomplete redirect.");
          const next = new URL(location, url);
          if (next.origin !== AO3)
            throw new ConnectorError(
              "AO3 redirected outside the allowed archive origin.",
              422,
            );
          // Never resend a password to a redirect target, including another AO3 path.
          if (method === "POST" && [307, 308].includes(response.status))
            throw new ConnectorError(
              "Unexpected AO3 sign-in redirect. Sign in in your browser first.",
              422,
            );
          url = next;
          method = "GET";
          body = undefined;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ConnectorError(
            response.status === 401
              ? "AO3 session expired. Connect again."
              : `AO3 returned HTTP ${response.status}.`,
            response.status === 401 ? 401 : 502,
          );
        }
        return { url: url.href, body: await boundedBody(response, maximum) };
      }
      throw new ConnectorError("AO3 returned too many redirects.");
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
  async login(
    login: string,
    password: string,
  ): Promise<{ sessionId: string; username: string }> {
    this.expire();
    if (
      !login.trim() ||
      !password ||
      login.length > 254 ||
      password.length > 1024
    )
      throw new ConnectorError(
        "Enter your AO3 username or email and password.",
        400,
      );
    if (this.sessions.size + this.signingIn >= 4)
      throw new ConnectorError(
        "Disconnect an existing companion session before connecting another account.",
        429,
      );
    this.signingIn++;
    try {
      const jar = new CookieJar();
      const form = await this.upstream(jar, "/users/login");
      const token = csrf(new TextDecoder().decode(form.body));
      const body = new URLSearchParams({
        authenticity_token: token,
        "user[login]": login.trim(),
        "user[password]": password,
        "user[remember_me]": "0",
      });
      const result = await this.upstream(jar, "/users/login", {
        method: "POST",
        body,
      });
      const username = signedInUser(new TextDecoder().decode(result.body));
      if (!username)
        throw new ConnectorError(
          "AO3 sign-in was not confirmed. Check credentials or resolve any AO3 challenge in your browser.",
          401,
        );
      const id = randomBytes(32).toString("hex");
      this.sessions.set(id, {
        id,
        username,
        jar,
        downloads: new Set(),
        touched: Date.now(),
      });
      return { sessionId: id, username };
    } finally {
      this.signingIn--;
    }
  }
  private expire() {
    for (const [id, session] of this.sessions)
      if (Date.now() - session.touched > 2 * 60 * 60 * 1000)
        this.sessions.delete(id);
  }
  private session(id: string): ActiveSession {
    this.expire();
    const session = this.sessions.get(id);
    if (!session)
      throw new ConnectorError(
        "AO3 companion session expired. Connect again.",
        401,
      );
    session.touched = Date.now();
    return session;
  }
  disconnect(id: string) {
    this.sessions.delete(id);
  }
  async page(id: string, path: string): Promise<UpstreamPage> {
    const session = this.session(id),
      url = new URL(path, AO3);
    const subscriptions =
      url.pathname ===
        `/users/${encodeURIComponent(session.username)}/subscriptions` &&
      url.searchParams.get("type") === "works" &&
      [...url.searchParams.keys()].every((key) =>
        ["type", "page"].includes(key),
      ) &&
      /^[1-9]\d{0,3}$/.test(url.searchParams.get("page") ?? "1");
    const work =
      (/^\/works\/[1-9]\d*\/navigate$/.test(url.pathname) && !url.search) ||
      (/^\/works\/[1-9]\d*$/.test(url.pathname) &&
        url.search === "?view_full_work=true");
    if (
      url.origin !== AO3 ||
      url.username ||
      url.password ||
      url.hash ||
      !(subscriptions || work)
    )
      throw new ConnectorError(
        "That AO3 page is outside the connector’s allowed routes.",
        400,
      );
    let response: { url: string; body: Uint8Array };
    try {
      response = await this.upstream(session.jar, url.href);
    } catch (error) {
      if (error instanceof ConnectorError && error.status === 401)
        this.disconnect(id);
      throw error;
    }
    const html = new TextDecoder().decode(response.body);
    if (signedInUser(html) !== session.username) {
      this.disconnect(id);
      throw new ConnectorError(
        "AO3 session expired or changed account. Connect again.",
        401,
      );
    }
    // Downloads are authorized only after appearing in an authenticated work page.
    for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
      const href = attributes(tag).href;
      if (!href) continue;
      const link = new URL(href, AO3);
      if (
        link.origin === AO3 &&
        /^\/downloads\/[1-9]\d*\/[^/]+\.epub$/.test(link.pathname) &&
        session.downloads.size < 2000
      )
        session.downloads.add(link.href);
    }
    return { url: response.url, html };
  }
  async epub(id: string, path: string): Promise<Uint8Array> {
    const session = this.session(id),
      url = new URL(path, AO3);
    if (!session.downloads.has(url.href))
      throw new ConnectorError(
        "Check this followed work before downloading its observed EPUB link.",
        400,
      );
    const result = await this.upstream(session.jar, url.href, {}, MAX_EPUB);
    if (result.body[0] !== 0x50 || result.body[1] !== 0x4b)
      throw new ConnectorError(
        "AO3 did not return an EPUB. Its download may be unavailable or the session may have expired.",
        422,
      );
    return result.body;
  }
}

async function bodyJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new ConnectorError("JSON is required.", 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new ConnectorError("Request is too large.", 413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected object.");
    return value as Record<string, unknown>;
  } catch {
    throw new ConnectorError("Invalid JSON.", 400);
  }
}
/** Loopback/proxy, explicit origin and pairing checks happen before any upstream request. */
export function createAo3Companion(options: {
  pairingToken: string;
  origins: string[];
  service?: Ao3SessionService;
  proxy?: Ao3ProxyDeployment;
}) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.pairingToken))
    throw new Error(
      "Use a random pairing credential of at least 32 characters.",
    );
  const service = options.service ?? new Ao3SessionService();
  const access = createAo3AccessPolicy(options.origins, options.proxy);
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      const send = (status: number, value: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      try {
        let origin: string;
        try {
          origin = access(request);
        } catch (error) {
          throw new ConnectorError(
            error instanceof Error
              ? error.message
              : "Companion access was rejected.",
            403,
          );
        }
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        if (request.method === "OPTIONS") {
          response.setHeader(
            "Access-Control-Allow-Methods",
            "GET,POST,DELETE,OPTIONS",
          );
          response.setHeader(
            "Access-Control-Allow-Headers",
            "Authorization,Content-Type,X-Avid-AO3-Session",
          );
          if (
            request.headers["access-control-request-private-network"] === "true"
          )
            response.setHeader("Access-Control-Allow-Private-Network", "true");
          response.statusCode = 204;
          response.end();
          return;
        }
        const supplied = Buffer.from(request.headers.authorization ?? ""),
          expected = Buffer.from(`Bearer ${options.pairingToken}`);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new ConnectorError(
            "Enter the pairing code configured for your AO3 companion.",
            401,
          );
        if (!request.url?.startsWith("/") || request.url.startsWith("//"))
          throw new ConnectorError("Invalid companion request target.", 400);
        const url = new URL(request.url, "http://127.0.0.1");
        const sessionId = String(request.headers["x-avid-ao3-session"] ?? "");
        if (url.pathname === "/v1/session" && request.method === "POST") {
          const body = await bodyJson(request);
          if (
            typeof body.login !== "string" ||
            typeof body.password !== "string"
          )
            throw new ConnectorError("AO3 credentials are required.", 400);
          const connected = await service.login(body.login, body.password);
          if (response.destroyed) service.disconnect(connected.sessionId);
          else send(200, connected);
        } else if (
          url.pathname === "/v1/session" &&
          request.method === "DELETE"
        ) {
          service.disconnect(sessionId);
          send(200, { disconnected: true });
        } else if (url.pathname === "/v1/page" && request.method === "GET")
          send(
            200,
            await service.page(sessionId, url.searchParams.get("path") ?? ""),
          );
        else if (url.pathname === "/v1/epub" && request.method === "GET") {
          const bytes = await service.epub(
            sessionId,
            url.searchParams.get("path") ?? "",
          );
          response.setHeader("Content-Type", "application/epub+zip");
          response.end(bytes);
        } else throw new ConnectorError("Unknown companion route.", 404);
      } catch (error) {
        if (response.destroyed || response.headersSent) {
          if (!response.destroyed) response.destroy();
          return;
        }
        const known = error instanceof ConnectorError;
        if (known && error.retryAfter)
          response.setHeader("Retry-After", String(error.retryAfter));
        send(known ? error.status : 502, {
          message: known
            ? error.message
            : "AO3 could not be reached. No credentials or session details were logged.",
        });
      }
    },
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
