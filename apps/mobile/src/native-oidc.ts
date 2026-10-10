import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type { OidcTransaction } from "../../../packages/core/src/oidc";
import type { ServerProfile } from "../../../packages/core/src/types";

export const NATIVE_OIDC_REDIRECT_URI = "avid://oauth2-callback" as const;
export interface NativeOidcRouting {
  profile: ServerProfile;
  provider: string;
  readOnly: boolean;
  createdAt: number;
}
export interface NativeOidcPending {
  /** Captured when saved; bind code exchange to this credential-clear barrier. */
  generation: string;
  state: string;
  expiresAt: number;
  routing: NativeOidcRouting;
  callbackUrl?: string;
}
/**
 * One encrypted, vault-generation-bound attempt, retained for at most five minutes.
 * PKCE/nonce never fall back to browser storage. Native implementations verify the
 * authorization URL against the saved challenge and use the system auth browser.
 */
export interface NativeOidcPlugin {
  capabilities(): Promise<{ redirectUri: string; secureTransactions: boolean }>;
  save(options: {
    transaction: OidcTransaction;
    routing: NativeOidcRouting;
  }): Promise<void>;
  /** Atomically removes the entire attempt and callback before returning secrets. */
  take(options: { state: string }): Promise<{ transaction?: OidcTransaction }>;
  pending(): Promise<{ pending?: NativeOidcPending }>;
  open(options: { state: string; url: string }): Promise<void>;
  /** A state-specific cancellation must never remove a newer attempt. */
  cancel(options?: { state?: string }): Promise<void>;
  /** Notification only; obtain callback data from pending(), never event payloads. */
  addListener(
    event: "callbackAvailable",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeOidcPlugin>("AvidOidc");
export function getNativeOidc(): NativeOidcPlugin | null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("AvidOidc")
    ? plugin
    : null;
}
