import type { NativeOwnerEventTail, PlaybackSessionIdentity } from "../../../packages/playback/src/foundation";
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {RemoteSkipPolicy} from '../../../packages/playback/src/remotePolicy';

export interface NativePlaybackLoad {
  /** Stable server + user scope. Never a credential. */
  accountScope: string;
  bookId: string;
  fileId: string;
  url: string;
  tracks?: { id: string; url: string; duration?: number }[];
  chapters?: {id:string;title:string;start:number;duration:number}[];
  coverUrl?: string;
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
  nativeEvents?: NativeOwnerEventTail;
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
  /** Durable metadata failure; playback itself can still be playing. */
  recoveryError?: string;
  ended?: boolean;
  updatedAt: string;
}

export interface NativePlaybackPlugin {
  capabilities(): Promise<{ backgroundAudioAvailable: boolean; systemMediaControlsAvailable: boolean; carIntegrationAvailable: boolean }>;
  load(options: NativePlaybackLoad): Promise<void>;
  play(options?: { expected: PlaybackSessionIdentity }): Promise<void>;
  pause(options?: { expected: PlaybackSessionIdentity }): Promise<void>;
  seek(options: { position: number; expected?: PlaybackSessionIdentity }): Promise<void>;
  setRate(options: { rate: number; expected?: PlaybackSessionIdentity }): Promise<void>;
  configureRemote?(options:RemoteSkipPolicy):Promise<void>;
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
