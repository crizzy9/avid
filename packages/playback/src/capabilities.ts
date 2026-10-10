/** Read-only runtime evidence. Native reports are accepted only with an installed bridge. */
export interface BrowserCapabilityEvidence {
  audio: boolean;
  mediaSession: boolean;
  speech: boolean;
  installedVoices: number;
}
export interface NativeCapabilityEvidence {
  installed: boolean;
  checking?: boolean;
  /** Keep bridge results untrusted: only literal true enables a capability. */
  report?: unknown;
}
export interface PlatformCapabilityEvidence {
  browser: BrowserCapabilityEvidence;
  playback?: NativeCapabilityEvidence;
  surfaces?: NativeCapabilityEvidence;
  speech?: NativeCapabilityEvidence;
}

export const capabilityEnglish = {
  audio: 'Audiobooks',
  mediaSession: 'System media controls',
  speech: 'Read aloud',
  background: 'Background playback',
  car: 'CarPlay and Android Auto',
  widgets: 'Widgets',
  intents: 'Voice shortcuts',
  controls: 'Lock Screen controls',
  spotlight: 'Search your books from your device',
  offline: 'Complete offline library',
  audioReady: 'Listen with chapter, speed and sleep controls. Supported audio formats vary by device.',
  mediaReady: 'Control playback from your device’s media controls. The controls shown can vary by device.',
  speechReady: 'Installed voices can read your books aloud. Highlighting depends on the selected voice.',
  speechEmpty: 'No installed voices are available now. This device supports speech, and voices may load later.',
  speechUnavailable: 'Speech voices are not available on this device.',
  backgroundReady: 'Continue listening while the app is in the background.',
  backgroundUnavailable: 'Background playback is not available here. Keep the app open while listening.',
  carReady: 'Browse and play audiobooks on a compatible connected car display.',
  widgetsReady: 'Open recent books from your home screen.',
  intentsReady: 'Use voice shortcuts to resume or pause an audiobook.',
  controlsReady: 'Resume or pause an audiobook from supported device controls.',
  spotlightReady: 'Find your books with your device’s search.',
  unavailable: 'Not available in this app on this device.',
  checking: 'Checking availability…',
  offlineUnavailable: 'Downloading a complete library for offline use is not available yet.',
} as const;
export type CapabilityMessageKey = keyof typeof capabilityEnglish;
export type CapabilityTranslator = (key: CapabilityMessageKey) => string;
export type PlatformCapabilityId = 'audio' | 'media-session' | 'speech' | 'background-audio' | 'carplay' | 'widgets' | 'system-intents' | 'system-controls' | 'spotlight' | 'offline';
export interface PlatformCapability {
  id: PlatformCapabilityId;
  label: string;
  available: boolean;
  detail: string;
}

export function readBrowserCapabilities(): BrowserCapabilityEvidence {
  const speech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  let installedVoices = 0;
  if (speech) {
    try { installedVoices = speechSynthesis.getVoices().length; } catch { /* A blocked voice list cannot establish availability. */ }
  }
  return {
    audio: typeof Audio !== 'undefined',
    mediaSession: typeof navigator !== 'undefined' && 'mediaSession' in navigator,
    speech,
    installedVoices,
  };
}

function reports(source: NativeCapabilityEvidence | undefined, key: string): boolean {
  return source?.installed === true && source.checking !== true && typeof source.report === 'object' && source.report !== null
    && Object.prototype.hasOwnProperty.call(source.report, key) && (source.report as Record<string, unknown>)[key] === true;
}

/** Default remains a synchronous web snapshot; native hosts supply installed bridge reports. */
export function getPlatformCapabilities(
  evidence: PlatformCapabilityEvidence = { browser: readBrowserCapabilities() },
  translate: CapabilityTranslator = key => capabilityEnglish[key],
): PlatformCapability[] {
  const { browser, playback, surfaces } = evidence;
  const nativeAudio = playback?.installed === true;
  const audio = nativeAudio || browser.audio;
  const media = nativeAudio ? reports(playback, 'systemMediaControlsAvailable') : browser.mediaSession;
  const speech = evidence.speech?.installed ? reports(evidence.speech, 'speechAvailable') : browser.speech && Number.isFinite(browser.installedVoices) && browser.installedVoices > 0;
  const background = reports(playback, 'backgroundAudioAvailable');
  const car = reports(playback, 'carIntegrationAvailable');
  // All of these surfaces depend on the account-scoped shared store. OS APIs alone
  // cannot establish that the installed app can populate or open its own surfaces.
  const sharedStore = reports(surfaces, 'appGroupAvailable');
  const widgets = (sharedStore && reports(surfaces, 'widgetExtensionEmbedded')) || reports(surfaces, 'androidWidgetAvailable');
  const intents = sharedStore && nativeAudio && reports(surfaces, 'audioIntentsAvailable');
  const controls = widgets && nativeAudio && reports(surfaces, 'controlsAvailable');
  const spotlight = (sharedStore && reports(surfaces, 'spotlightAvailable')) || reports(surfaces, 'desktopSearchAvailable');
  const detail = (available: boolean, ready: CapabilityMessageKey, source?: NativeCapabilityEvidence, missing: CapabilityMessageKey = 'unavailable') =>
    available ? ready : source?.installed && source.checking ? 'checking' : missing;
  const row = (id: PlatformCapabilityId, label: CapabilityMessageKey, available: boolean, description: CapabilityMessageKey): PlatformCapability =>
    ({ id, label: translate(label), available, detail: translate(description) });
  return [
    row('audio', 'audio', audio, detail(audio, 'audioReady')),
    row('media-session', 'mediaSession', media, detail(media, 'mediaReady', playback)),
    row('speech', 'speech', speech, speech ? 'speechReady' : evidence.speech?.checking ? 'checking' : evidence.speech?.installed || browser.speech ? 'speechEmpty' : 'speechUnavailable'),
    row('background-audio', 'background', background, detail(background, 'backgroundReady', playback, 'backgroundUnavailable')),
    row('carplay', 'car', car, detail(car, 'carReady', playback)),
    row('widgets', 'widgets', widgets, detail(widgets, 'widgetsReady', surfaces)),
    row('system-intents', 'intents', intents, detail(intents, 'intentsReady', surfaces)),
    row('system-controls', 'controls', controls, detail(controls, 'controlsReady', surfaces)),
    row('spotlight', 'spotlight', spotlight, detail(spotlight, 'spotlightReady', surfaces)),
    row('offline', 'offline', false, 'offlineUnavailable'),
  ];
}
