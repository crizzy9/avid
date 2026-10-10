import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { getDesktopSystemSurfaces } from "../../desktop/src/system-surfaces";

export interface SystemBook {
  bookId: string;
  fileId: string;
  title: string;
  author: string;
  kind: "epub" | "pdf" | "comic" | "audio";
  progress: number;
  audioPosition?: number;
  audioDuration?: number;
}
export interface NativeNavigation {
  scopeHash: string;
  bookId: string;
  fileId: string;
  kind: SystemBook["kind"];
}
export interface NativeSystemSurfaces {
  capabilities(): Promise<{
    appGroupAvailable: boolean;
    spotlightAvailable: boolean;
    desktopSearchAvailable?: boolean;
    widgetExtensionEmbedded: boolean;
    androidWidgetAvailable?: boolean;
    audioIntentsAvailable: boolean;
    controlsAvailable: boolean;
  }>;
  activateAccount(options: { accountScope: string }): Promise<void>;
  publishRecent(options: {
    accountScope: string;
    book: SystemBook;
  }): Promise<{ id: string }>;
  indexBooks(options: {
    accountScope: string;
    books: SystemBook[];
  }): Promise<{ ids: string[] }>;
  removeBooks(options: { ids: string[] }): Promise<void>;
  clearAccount(): Promise<void>;
  consumeNavigation(): Promise<{ book?: NativeNavigation }>;
  addListener(
    eventName: "navigationAvailable",
    callback: () => void,
  ): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativeSystemSurfaces>("AvidSystemSurfaces");
/** Capabilities reflect the installed native bridge and entitlements, never the browser user agent. */
export function getNativeSystemSurfaces(): NativeSystemSurfaces | null {
  return Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("AvidSystemSurfaces")
    ? plugin
    : getDesktopSystemSurfaces();
}
