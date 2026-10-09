import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativePlaybackLoad {
  /** Stable server + user scope. Never a credential. */
  accountScope: string;
  bookId: string;
  fileId: string;
  url: string;
  title: string;
  author: string;
  position?: number;
  rate?: number;
}

export interface NativePlaybackSnapshot {
  accountScope: string;
  bookId: string;
  fileId: string;
  position: number;
  duration: number;
  rate: number;
  playing: boolean;
  updatedAt: string;
}

export interface NativePlaybackPlugin {
  load(options: NativePlaybackLoad): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setSleepTimer(options: { deadline?: number; chapterEnd?: number }): Promise<void>;
  snapshot(): Promise<NativePlaybackSnapshot>;
  clear(): Promise<void>;
  addListener(eventName: 'checkpoint', callback: (event: NativePlaybackSnapshot) => void): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<NativePlaybackPlugin>('AvidPlayback');

/** No silent HTML fallback: a native owner must be installed before using this adapter. */
export function getNativePlayback(): NativePlaybackPlugin | null {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AvidPlayback') ? plugin : null;
}
