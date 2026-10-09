export interface SpeechBoundary {
  /** UTF-16 offsets into the original supplied text (same units as DOM ranges). */
  start: number;
  end: number;
  elapsedTime: number;
  kind: string;
}

export interface SpeechRequest {
  text: string;
  lang?: string;
  voiceURI?: string;
  rate?: number;
  start?: number;
  onBoundary?: (boundary: SpeechBoundary) => void;
  onEnd?: () => void;
  onError?: (message: string) => void;
}

export interface SpeechSnapshot {
  status: 'idle' | 'loading' | 'speaking' | 'paused' | 'failed';
  boundary: SpeechBoundary | null;
  error: string | null;
}

/** Installed-voice browser fallback. No synthetic word timing is generated. */
export class SpeechController {
  private engine: SpeechSynthesis | null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private utteranceStarted = false;
  private snapshot: SpeechSnapshot = { status: 'idle', boundary: null, error: null };
  private listeners = new Set<() => void>();
  private generation = 0;

  constructor(engine?: SpeechSynthesis | null) {
    this.engine = engine !== undefined ? engine : typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  }
  get available(): boolean { return this.engine !== null && typeof SpeechSynthesisUtterance !== 'undefined'; }
  getSnapshot = (): SpeechSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getVoices(): SpeechSynthesisVoice[] { return this.engine?.getVoices() ?? []; }
  onVoicesChanged(listener: () => void): () => void {
    this.engine?.addEventListener('voiceschanged', listener);
    return () => { this.engine?.removeEventListener('voiceschanged', listener); };
  }
  speak(request: SpeechRequest): void {
    this.cancel();
    if (!this.available || !this.engine) {
      const error = 'Speech is not available in this browser. Open Avid in a browser with installed speech voices.';
      this.update({ status: 'failed', error });
      request.onError?.(error);
      return;
    }
    const start = Math.max(0, Math.min(request.text.length, request.start ?? 0));
    const text = request.text.slice(start);
    if (!text.trim()) { request.onEnd?.(); return; }
    const generation = this.generation;
    const utterance = new SpeechSynthesisUtterance(text);
    this.utterance = utterance;
    utterance.lang = request.lang ?? 'en-US';
    utterance.rate = Math.min(3, Math.max(0.5, request.rate ?? 1));
    if (request.voiceURI) {
      const voice = this.getVoices().find(item => item.voiceURI === request.voiceURI);
      if (voice) { utterance.voice = voice; utterance.lang = voice.lang; }
    }
    utterance.onstart = () => {
      if (generation === this.generation) { this.utteranceStarted = true; this.update({ status: 'speaking', error: null }); }
    };
    utterance.onboundary = event => {
      if (generation !== this.generation) return;
      const boundary: SpeechBoundary = { start: start + event.charIndex,
        end: start + event.charIndex + (event.charLength || this.wordLengthAt(text, event.charIndex)),
        elapsedTime: event.elapsedTime, kind: event.name };
      this.update({ boundary });
      request.onBoundary?.(boundary);
    };
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.utterance = null;
      this.update({ status: 'idle', boundary: null });
      request.onEnd?.();
    };
    utterance.onerror = event => {
      if (generation !== this.generation) return;
      this.utterance = null;
      const error = `Speech stopped: ${event.error}.`;
      this.update({ status: 'failed', error });
      request.onError?.(error);
    };
    this.update({ status: 'loading', error: null });
    this.engine.speak(utterance);
  }
  pause(): void { if (this.utterance) { this.engine?.pause(); this.update({ status: 'paused' }); } }
  resume(): void { if (this.utterance) { this.engine?.resume(); this.update({ status: this.utteranceStarted ? 'speaking' : 'loading' }); } }
  cancel(): void {
    this.generation++;
    this.utterance = null;
    this.utteranceStarted = false;
    this.engine?.cancel();
    this.update({ status: 'idle', boundary: null, error: null });
  }
  destroy(): void { this.cancel(); this.listeners.clear(); }
  private wordLengthAt(text: string, index: number): number {
    // Some engines give the real start event but omit its length. Derive only the range, not its timing.
    return text.slice(index).match(/^\S+/u)?.[0].length ?? 1;
  }
  private update(patch: Partial<SpeechSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
}
