import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { z } from "zod";
import {
  BookOrbitError,
  normalizeServerUrl,
} from "../../../packages/core/src/bookorbit";
import type { Session } from "../../../packages/core/src/types";
import type { NativeSessionRecord } from "./native-session";

export interface NativeAuthPlugin {
  /** Isolated cookies are committed only while this captured vault generation still owns the attempt. */
  authenticate(options: {
    expectedGeneration: string;
    serverUrl: string;
    path: "login" | "oidc/callback";
    body: string;
  }): Promise<{ status: number; body: unknown }>;
  /** Native single-flight refresh validates /auth/me, commits via vault CAS, then updates platform cookies. */
  refresh(options: {
    accountScope: string;
    expectedGeneration?: string;
    force?: boolean;
  }): Promise<NativeSessionRecord>;
  /** No credentials in notifications. Read/adopt the matching native record separately. */
  addListener(
    event: "sessionChanged",
    listener: (value: { generation: string; accountScope: string }) => void,
  ): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeAuthPlugin>("AvidAuth");
export function getNativeAuth(): NativeAuthPlugin | null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("AvidAuth")
    ? plugin
    : null;
}
/** Capture this immediately after the attempt's credential-clear barrier, never during a delayed request. */
export function createNativeAuthFetch(
  expectedGeneration: string,
  fallback: typeof fetch = globalThis.fetch.bind(globalThis),
  auth: NativeAuthPlugin | null = getNativeAuth(),
): typeof fetch {
  if (!expectedGeneration || !auth)
    throw new BookOrbitError("Secure native sign-in is unavailable.", 401);
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    // Browser/proxy and ordinary API reads keep their existing transport. Native
    // authentication always uses the actual server address, never a proxy URL.
    const authPath = /\/api\/v1\/auth\/(login|oidc\/callback)(?:[?#].*)?$/.exec(
      raw,
    );
    if (!authPath) return fallback(input, init);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BookOrbitError(
        "Native authentication requires the direct server URL.",
        401,
      );
    }
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      init?.body ??
      (input instanceof Request ? await input.clone().text() : undefined);
    if (
      method.toUpperCase() !== "POST" ||
      typeof body !== "string" ||
      !body.length ||
      url.search ||
      url.hash
    )
      throw new BookOrbitError("The native sign-in request is invalid.", 401);
    const serverUrl = normalizeServerUrl(raw.slice(0, authPath.index));
    if (
      init?.signal?.aborted ||
      (input instanceof Request && input.signal.aborted)
    )
      throw new DOMException("Sign-in cancelled.", "AbortError");
    const response = await auth.authenticate({
      expectedGeneration,
      serverUrl,
      path: authPath[1] as "login" | "oidc/callback",
      body,
    });
    if (
      init?.signal?.aborted ||
      (input instanceof Request && input.signal.aborted)
    )
      throw new DOMException("Sign-in cancelled.", "AbortError");
    if (
      !Number.isInteger(response.status) ||
      response.status < 200 ||
      response.status > 599
    )
      throw new BookOrbitError("The native sign-in response is invalid.", 502);
    return new Response(
      response.body == null ||
        response.status === 204 ||
        response.status === 205 ||
        response.status === 304
        ? null
        : JSON.stringify(response.body),
      {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
}
const sessionRecord = z.object({
  generation: z.string().min(1),
  readOnly: z.boolean().optional(),
  session: z.object({
    profile: z.object({
      id: z.string().min(1),
      name: z.string(),
      url: z.string().url(),
      username: z.string().optional(),
      version: z.string().optional(),
    }),
    userId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    clientKind: z.enum(["web", "native"]).optional(),
  }),
});
export function nativeAuthScope(session: Session): string {
  return JSON.stringify([
    normalizeServerUrl(session.profile.url),
    session.userId,
  ]);
}
/** Pass this to ClientOptions.refreshSession. Failures never fall back to a competing JS token rotation. */
export function createNativeSessionRefresh(options: {
  plugin: NativeAuthPlugin;
  /** Await cursor adoption before any retried API request can persist a stale vault generation. */
  onRecord: (record: NativeSessionRecord) => void | Promise<void>;
}): (session: Session) => Promise<Session> {
  return async (original) => {
    const session = structuredClone(original);
    const scope = nativeAuthScope(session);
    const raw = await options.plugin.refresh({
      accountScope: scope,
      force: true,
    });
    const parsed = sessionRecord.safeParse(raw);
    if (!parsed.success)
      throw new BookOrbitError(
        "The native credential refresh returned an invalid session. Sign in again.",
        401,
      );
    const record = parsed.data;
    if (
      nativeAuthScope(record.session) !== scope ||
      record.session.profile.id !== session.profile.id ||
      (record.session.clientKind ?? "web") !== (session.clientKind ?? "web")
    )
      throw new BookOrbitError(
        "The native credential refresh belongs to a different connection. Sign in again.",
        401,
      );
    record.session.profile.url = normalizeServerUrl(record.session.profile.url);
    const next = structuredClone(record.session);
    await options.onRecord(record);
    return next;
  };
}
