import { Capacitor, registerPlugin } from "@capacitor/core";
import type { Session } from "../../../packages/core/src/types";
import { getDesktopSessionVault } from "../../desktop/src/network";

export interface NativeSessionRecord {
  generation: string;
  session?: Session;
  readOnly?: boolean;
}
export interface NativeSessionVault {
  read(): Promise<NativeSessionRecord>;
  write(value: {
    expectedGeneration: string;
    session: Session;
    readOnly: boolean;
  }): Promise<NativeSessionRecord>;
  clear(value?: { expectedGeneration?: string }): Promise<NativeSessionRecord>;
}
const vault = registerPlugin<NativeSessionVault>("AvidSession");
/** Native only: credentials never fall back to localStorage, Preferences or IndexedDB. */
export function getNativeSessionVault(): NativeSessionVault | null {
  return Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("AvidSession")
    ? vault
    : getDesktopSessionVault();
}
export type NativeSessionStore = NativeSessionVault;
export const nativeSessionStore = getNativeSessionVault;
