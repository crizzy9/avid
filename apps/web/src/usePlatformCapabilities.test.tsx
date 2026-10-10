// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlatformCapabilities, type PlatformCapabilityRuntime } from './usePlatformCapabilities';
import { capabilityTranslations, capabilityTranslate } from './capabilityMessages';
import { capabilityEnglish, type CapabilityMessageKey, type PlatformCapabilityId } from '../../../packages/playback/src/capabilities';
import { LOCALES, setLocale } from '../../../packages/i18n/src';

const installed = vi.hoisted(() => ({ playback: vi.fn(), surfaces: vi.fn() }));
vi.mock('../../mobile/src/native-playback', () => ({ getNativePlayback: installed.playback }));
vi.mock('../../mobile/src/native-surfaces', () => ({ getNativeSystemSurfaces: installed.surfaces }));
const playbackReport = { backgroundAudioAvailable: true, systemMediaControlsAvailable: true, carIntegrationAvailable: true };
const surfacesReport = { appGroupAvailable: true, spotlightAvailable: true, widgetExtensionEmbedded: true, audioIntentsAvailable: true, controlsAvailable: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let element: HTMLDivElement, root: Root | null;
beforeEach(() => {
  setLocale('en');
  installed.playback.mockReturnValue(null); installed.surfaces.mockReturnValue(null);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null; setLocale('en'); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function Harness({ runtime }: { runtime?: PlatformCapabilityRuntime }) {
  const rows = usePlatformCapabilities(runtime);
  return <ul>{rows.map(row => <li key={row.id} data-id={row.id} data-available={row.available}><b>{row.label}</b><span>{row.detail}</span></li>)}</ul>;
}
async function render(runtime?: PlatformCapabilityRuntime) { await act(async () => root!.render(<Harness runtime={runtime} />)); }
function row(id: PlatformCapabilityId) { return element.querySelector(`[data-id="${id}"]`)!; }
function available(id: PlatformCapabilityId) { return row(id).getAttribute('data-available') === 'true'; }
function fixture() {
  let voices = 0;
  const speech = new EventTarget();
  const playback = { capabilities: vi.fn().mockResolvedValue(playbackReport) };
  const surfaces = { capabilities: vi.fn().mockResolvedValue(surfacesReport) };
  const runtime: PlatformCapabilityRuntime = {
    browser: () => ({ audio: true, mediaSession: true, speech: true, installedVoices: voices }),
    playback: () => playback, surfaces: () => surfaces, speech: () => speech,
  };
  return { runtime, playback, surfaces, speech, setVoices: (count: number) => { voices = count; } };
}

describe('live localized platform capabilities', () => {
  it('covers every public label and detail in seven locales', () => {
    expect(Object.keys(capabilityTranslations).sort()).toEqual(Object.keys(capabilityEnglish).sort());
    for (const key of Object.keys(capabilityEnglish) as CapabilityMessageKey[]) {
      expect(capabilityTranslations[key]).toHaveLength(6);
      for (const { code } of LOCALES) {
        const value = capabilityTranslate(key, code);
        expect(value.trim().length, `${code}.${key}`).toBeGreaterThan(0);
        expect(value.match(/\{\w+\}/g) ?? []).toEqual(capabilityEnglish[key].match(/\{\w+\}/g) ?? []);
      }
    }
  });
  it('loads installed native reports and translates both labels and descriptions live without querying again', async () => {
    const f = fixture(); await render(f.runtime);
    for (const id of ['background-audio', 'carplay', 'widgets', 'system-intents', 'system-controls', 'spotlight'] as const) expect(available(id), id).toBe(true);
    expect(available('speech')).toBe(false);
    for (const { code } of LOCALES) {
      await act(async () => setLocale(code));
      expect(row('background-audio').querySelector('b')?.textContent).toBe(capabilityTranslate('background', code));
      expect(row('background-audio').querySelector('span')?.textContent).toBe(capabilityTranslate('backgroundReady', code));
      expect(row('speech').querySelector('span')?.textContent).toBe(capabilityTranslate('speechEmpty', code));
    }
    expect(f.playback.capabilities).toHaveBeenCalledOnce(); expect(f.surfaces.capabilities).toHaveBeenCalledOnce();
  });
  it('updates when voices arrive or disappear without re-querying native capabilities', async () => {
    const f = fixture(); await render(f.runtime); expect(available('speech')).toBe(false);
    await act(async () => { f.setVoices(3); f.speech.dispatchEvent(new Event('voiceschanged')); });
    expect(available('speech')).toBe(true);
    await act(async () => { f.setVoices(0); f.speech.dispatchEvent(new Event('voiceschanged')); });
    expect(available('speech')).toBe(false); expect(row('speech').textContent).toContain('No installed voices');
    expect(f.playback.capabilities).toHaveBeenCalledOnce();
  });
  it('refreshes actual native reports on foreground and ignores an older report finishing later', async () => {
    const f = fixture(), old = deferred<unknown>(); f.playback.capabilities.mockReturnValueOnce(old.promise);
    await render(f.runtime); expect(available('background-audio')).toBe(false); expect(row('background-audio').textContent).toContain('Checking');
    f.playback.capabilities.mockResolvedValue({ ...playbackReport, backgroundAudioAvailable: false, carIntegrationAvailable: false });
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(available('background-audio')).toBe(false); expect(row('background-audio').textContent).not.toContain('Checking');
    await act(async () => old.resolve(playbackReport));
    expect(available('background-audio')).toBe(false); expect(available('carplay')).toBe(false);
  });
  it('handles a failed or timed out native report without hiding an independent surface report', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.playback.capabilities.mockRejectedValueOnce(new Error('Not installed in this build'));
    await render(f.runtime); expect(available('background-audio')).toBe(false); expect(available('widgets')).toBe(true);
    expect(row('background-audio').textContent).not.toContain('Checking');
    f.playback.capabilities.mockReturnValue(new Promise(() => {}));
    await act(async () => window.dispatchEvent(new Event('focus'))); expect(row('background-audio').textContent).toContain('Checking');
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(row('background-audio').textContent).not.toContain('Checking'); expect(available('background-audio')).toBe(false); expect(available('widgets')).toBe(true);
  });
  it('discards reports from an old runtime and removes listeners and pending timers on unmount', async () => {
    vi.useFakeTimers();
    const f = fixture(), late = deferred<unknown>(); f.surfaces.capabilities.mockReturnValue(late.promise);
    const remove = vi.spyOn(f.speech, 'removeEventListener');
    await render(f.runtime);
    const web: PlatformCapabilityRuntime = { ...f.runtime, playback: () => null, surfaces: () => null };
    await render(web); await act(async () => late.resolve(surfacesReport));
    expect(available('widgets')).toBe(false); expect(available('background-audio')).toBe(false);
    expect(remove).toHaveBeenCalledWith('voiceschanged', expect.any(Function));
    await act(async () => root!.unmount()); root = null;
    const calls = f.playback.capabilities.mock.calls.length;
    window.dispatchEvent(new Event('focus')); f.speech.dispatchEvent(new Event('voiceschanged'));
    expect(f.playback.capabilities).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses installed bridge detectors by default and does not mistake an empty browser voice list for availability', async () => {
    installed.playback.mockReturnValue({ capabilities: vi.fn().mockResolvedValue(playbackReport) });
    installed.surfaces.mockReturnValue({ capabilities: vi.fn().mockResolvedValue({ ...surfacesReport, appGroupAvailable: false }) });
    const speech = Object.assign(new EventTarget(), { getVoices: () => [] });
    vi.stubGlobal('speechSynthesis', speech); vi.stubGlobal('SpeechSynthesisUtterance', function SpeechSynthesisUtterance() {});
    await render(); expect(available('background-audio')).toBe(true); expect(available('speech')).toBe(false); expect(available('widgets')).toBe(false); expect(available('spotlight')).toBe(false);
  });
});
