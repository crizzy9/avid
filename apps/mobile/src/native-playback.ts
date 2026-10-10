import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativePlaybackLoad {
  /** Stable server + user scope. Never a credential. */
  accountScope: string;
  bookId: string;
  fileId: string;
  url: string;
  tracks?: { id: string; url: string; duration?: number }[];
  manifestRevision?: string;
  readOnly?: boolean;
  title: string;
  author: string;
  position?: number;
  rate?: number;
  /** Optional signed-source expiry; native cold resume refuses expired access. */
  expiresAt?: string;
}

export interface NativePlaybackSnapshot {
  accountScope: string;
  bookId: string;
  fileId: string;
  position: number;
  trackId?: string;
  trackIds?: string[];
  trackIndex?: number;
  trackTime?: number;
  manifestRevision?: string;
  readOnly?: boolean;
  sleepUntil?: number | null;
  sleepAtChapterEnd?: number | null;
  duration: number;
  rate: number;
  playing: boolean;
  status?: 'stopped' | 'loading' | 'playing' | 'paused' | 'buffering' | 'interrupted' | 'failed';
  error?: string;
  ended?: boolean;
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

/** Identity only, without media URLs or credentials. Does not load, seek or start audio. */
export async function readOwnerSnapshot(): Promise<NativePlaybackSnapshot | null> {
  const native = getNativePlayback();
  if (!native) return null;
  const value = await native.snapshot();
  return value.bookId && value.fileId && value.accountScope ? value : null;
}
