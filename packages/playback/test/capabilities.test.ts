import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityEnglish, getPlatformCapabilities, readBrowserCapabilities, type PlatformCapabilityEvidence, type PlatformCapabilityId } from '../src/capabilities';

const browser = { audio: true, mediaSession: true, speech: true, installedVoices: 0 };
const playback = { backgroundAudioAvailable: true, systemMediaControlsAvailable: true, carIntegrationAvailable: true };
const surfaces = { appGroupAvailable: true, spotlightAvailable: true, widgetExtensionEmbedded: true, audioIntentsAvailable: true, controlsAvailable: true };
const row = (evidence: PlatformCapabilityEvidence, id: PlatformCapabilityId) => getPlatformCapabilities(evidence).find(item => item.id === id)!;
afterEach(() => vi.unstubAllGlobals());

describe('installed platform capability evidence', () => {
  it('does not claim speech voices just because the speech API exists', () => {
    expect(row({ browser }, 'speech')).toMatchObject({ available: false, detail: capabilityEnglish.speechEmpty });
    expect(row({ browser: { ...browser, installedVoices: 2 } }, 'speech').available).toBe(true);
    expect(row({ browser: { ...browser, speech: false, installedVoices: 2 } }, 'speech')).toMatchObject({ available: false, detail: capabilityEnglish.speechUnavailable });
    expect(row({ browser: { ...browser, installedVoices: NaN } }, 'speech').available).toBe(false);
  });
  it('requires a real installed bridge before accepting native reports', () => {
    const evidence = { browser, playback: { installed: false, report: playback }, surfaces: { installed: false, report: surfaces } };
    for (const id of ['background-audio', 'carplay', 'widgets', 'system-intents', 'system-controls', 'spotlight'] as const) expect(row(evidence, id).available, id).toBe(false);
    expect(row(evidence, 'media-session').available).toBe(true);
    expect(row(evidence, 'offline').available).toBe(false);
  });
  it('accepts individual native reports only and never promotes a missing or malformed flag', () => {
    const evidence = { browser, playback: { installed: true, report: { ...playback, carIntegrationAvailable: 'true', backgroundAudioAvailable: 1 } } };
    expect(row(evidence, 'media-session').available).toBe(true);
    expect(row(evidence, 'background-audio').available).toBe(false);
    expect(row(evidence, 'carplay').available).toBe(false);
    expect(row({ browser, playback: { installed: true } }, 'media-session').available).toBe(false);
    expect(row({ browser, playback: { installed: true, report: Object.create(playback) } }, 'background-audio').available).toBe(false);
  });
  it('reports actual installed background and car capability separately', () => {
    const evidence = { browser, playback: { installed: true, report: { ...playback, carIntegrationAvailable: false } }, surfaces: { installed: true, report: surfaces } };
    expect(row(evidence, 'background-audio').available).toBe(true);
    expect(row(evidence, 'carplay').available).toBe(false);
    expect(row(evidence, 'media-session').available).toBe(true);
    expect(row({ ...evidence, playback: { installed: true, report: playback } }, 'carplay').available).toBe(true);
  });
  it('requires the installed shared store for widgets, search and account-scoped shortcuts', () => {
    const evidence = { browser, playback: { installed: true, report: playback }, surfaces: { installed: true, report: { ...surfaces, appGroupAvailable: false } } };
    for (const id of ['widgets', 'system-intents', 'system-controls', 'spotlight'] as const) expect(row(evidence, id).available, id).toBe(false);
    const ready = { ...evidence, surfaces: { installed: true, report: surfaces } };
    for (const id of ['widgets', 'system-intents', 'system-controls', 'spotlight'] as const) expect(row(ready, id).available, id).toBe(true);
  });
  it('does not conflate an OS search API, embedded widgets and audio shortcuts', () => {
    const evidence = { browser, surfaces: { installed: true, report: { ...surfaces, widgetExtensionEmbedded: false } } };
    expect(row(evidence, 'spotlight').available).toBe(true);
    expect(row(evidence, 'widgets').available).toBe(false);
    expect(row(evidence, 'system-intents').available).toBe(false);
    expect(row({ ...evidence, playback: { installed: true, report: playback } }, 'system-intents').available).toBe(true);
    expect(row({ ...evidence, playback: { installed: true, report: playback } }, 'system-controls').available).toBe(false);
  });
  it('does not claim availability before reports finish and does not infer native support from a user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'iPhone Avid iOS Native CarPlay', mediaSession: {} });
    const evidence = { browser, playback: { installed: true, checking: true, report: playback }, surfaces: { installed: true, checking: true, report: surfaces } };
    expect(row(evidence, 'background-audio')).toMatchObject({ available: false, detail: capabilityEnglish.checking });
    expect(row(evidence, 'widgets')).toMatchObject({ available: false, detail: capabilityEnglish.checking });
    expect(getPlatformCapabilities().find(item => item.id === 'carplay')?.available).toBe(false);
  });
  it('reads real browser feature evidence and handles blocked voice enumeration', () => {
    vi.stubGlobal('Audio', function Audio() {});
    vi.stubGlobal('navigator', { mediaSession: {} });
    vi.stubGlobal('SpeechSynthesisUtterance', function SpeechSynthesisUtterance() {});
    const getVoices = vi.fn().mockReturnValue([]);
    vi.stubGlobal('speechSynthesis', { getVoices });
    expect(readBrowserCapabilities()).toEqual(browser);
    expect(getPlatformCapabilities().find(item => item.id === 'speech')?.available).toBe(false);
    getVoices.mockReturnValue([{}, {}]);
    expect(readBrowserCapabilities().installedVoices).toBe(2);
    getVoices.mockImplementation(() => { throw new Error('Not available'); });
    expect(readBrowserCapabilities().installedVoices).toBe(0);
  });
});
