import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechController, getAudioCodecSupport, resolveAudioSource } from '../src';

class Utterance {
  lang = ''; rate = 1; voice = null;
  onstart: (() => void) | null = null;
  onboundary: ((event: { charIndex: number; charLength: number; elapsedTime: number; name: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(readonly text: string) {}
}

function setup() {
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  const utterances: Utterance[] = [];
  const engine = {
    cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: vi.fn(() => []),
    speak: vi.fn((utterance: Utterance) => { utterances.push(utterance); }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  };
  const speech = new SpeechController(engine as unknown as SpeechSynthesis);
  return { speech, engine, utterances };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('speech boundaries', () => {
  it('keeps selected-start offsets in the original passage', () => {
    const { speech, utterances } = setup();
    const boundary = vi.fn();
    speech.speak({ text: 'A short passage is spoken.', start: 8, onBoundary: boundary });
    expect(utterances[0]!.text).toBe('passage is spoken.');
    utterances[0]!.onboundary?.({ charIndex: 8, charLength: 2, elapsedTime: 1.2, name: 'word' });
    expect(boundary).toHaveBeenCalledWith({ start: 16, end: 18, elapsedTime: 1.2, kind: 'word' });
  });
  it('derives a missing range length only when a real boundary event arrives', () => {
    const { speech, utterances } = setup();
    const boundary = vi.fn();
    speech.speak({ text: 'Real event timing', onBoundary: boundary });
    expect(boundary).not.toHaveBeenCalled();
    utterances[0]!.onboundary?.({ charIndex: 5, charLength: 0, elapsedTime: 0.8, name: 'word' });
    expect(boundary).toHaveBeenCalledWith({ start: 5, end: 10, elapsedTime: 0.8, kind: 'word' });
  });
  it('does not advance pages from cancelled utterance callbacks', () => {
    const { speech, utterances } = setup();
    const advance = vi.fn();
    speech.speak({ text: 'Old chapter', onEnd: advance });
    speech.speak({ text: 'New chapter' });
    utterances[0]!.onend?.();
    expect(advance).not.toHaveBeenCalled();
    expect(speech.getSnapshot().status).toBe('speaking');
    utterances[1]!.onend?.();
    expect(speech.getSnapshot().status).toBe('idle');
  });
  it('exposes unsupported speech and recovers paused utterances without replacing them', () => {
    const { speech, engine } = setup();
    speech.speak({ text: 'Keep the same utterance' });
    speech.pause();
    expect(speech.getSnapshot().status).toBe('paused');
    speech.resume();
    expect(engine.speak).toHaveBeenCalledTimes(1);
    expect(engine.resume).toHaveBeenCalledTimes(1);
    const unavailable = new SpeechController(null);
    unavailable.speak({ text: 'No engine' });
    expect(unavailable.getSnapshot()).toMatchObject({ status: 'failed' });
  });
});

describe('codec selection', () => {
  it('selects a supported derivative without claiming every MIME can play', () => {
    const audio = { canPlayType: (mime: string): CanPlayTypeResult => mime === 'audio/mpeg' ? 'probably' : '' };
    const sources = [{ url: '/original.m4b', mime: 'audio/mp4' }, { url: '/derivative.mp3', mime: 'audio/mpeg' }];
    expect(resolveAudioSource(sources, audio)?.url).toBe('/derivative.mp3');
    expect(resolveAudioSource([sources[0]!], audio)).toBeNull();
    expect(getAudioCodecSupport(audio).find(item => item.format === 'FLAC')?.support).toBe('');
  });
});
