import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NativeSpeechPlugin } from '../../mobile/src/native-speech';

export interface DesktopRecent {
  bookId: string;
  fileId: string;
  title: string;
  author: string;
  kind: 'epub' | 'pdf' | 'comic' | 'audio';
  progress: number;
}
export interface DesktopMedia {
  bookId: string;
  fileId: string;
  title: string;
  author: string;
  chapter?: string;
  /** Bounded image data only. Native sanitization removes metadata before system display. */
  coverDataUrl?: string;
  position: number;
  duration: number;
  playing: boolean;
}
export interface DesktopSnapshot {
  accountScope: string | null;
  recents: DesktopRecent[];
  media?: DesktopMedia | null;
}
export interface DesktopAction {
  accountScope: string;
  bookId?: string;
  fileId?: string;
  kind?: DesktopRecent['kind'];
  action: 'open' | 'play' | 'pause' | 'toggle' | 'stop' | 'next' | 'previous' | 'seek';
  position?: number;
}
export interface DesktopCapabilities {
  mediaControlsAvailable: boolean;
  trayAvailable: boolean;
  speechAvailable: boolean;
  wordBoundariesAvailable: false;
}
export interface DesktopBridge {
  capabilities(): Promise<DesktopCapabilities>;
  publish(snapshot: DesktopSnapshot): Promise<void>;
  onAction(callback: (action: DesktopAction) => void): Promise<() => void>;
}
const bridge: DesktopBridge = {
  capabilities: () => invoke('desktop_capabilities'),
  publish: (snapshot) => invoke('desktop_publish', { snapshot }),
  onAction: (callback) => listen<DesktopAction>('avid:desktop-action', (event) => callback(event.payload)),
};
/** No UA detection or fallback that reports a native feature without a running Tauri host. */
export function getDesktopBridge(): DesktopBridge | null { return isTauri() ? bridge : null; }
const speech: NativeSpeechPlugin = {
  voices: () => invoke('desktop_speech_voices'),
  speak: (request) => invoke('desktop_speech_speak', { request }),
  cancel: (request = {}) => invoke('desktop_speech_cancel', { id: request.id ?? null }),
  addListener: async (_event, callback) => {
    const remove = await listen<Parameters<typeof callback>[0]>('avid:desktop-speech', (event) => callback(event.payload));
    return { remove: async () => remove() };
  },
};
export function getDesktopSpeech(): NativeSpeechPlugin | null { return isTauri() ? speech : null; }
