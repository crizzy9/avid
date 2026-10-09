export interface PlatformCapability {
  id: string;
  label: string;
  available: boolean;
  detail: string;
}

export function getPlatformCapabilities(): PlatformCapability[] {
  const mediaSession = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
  const speech = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  return [
    { id: 'audio', label: 'Audiobooks', available: typeof Audio !== 'undefined', detail: 'Browser-supported codecs, chapters, speed, skip, and sleep timer.' },
    { id: 'media-session', label: 'System media controls', available: mediaSession, detail: mediaSession ? 'Media Session metadata and supported controls. Availability varies by browser and OS.' : 'This browser does not expose Media Session controls.' },
    { id: 'speech', label: 'Speak with installed voices', available: speech, detail: 'Installed browser voices; word highlighting uses real boundary events when the chosen voice supplies them.' },
    { id: 'background-audio', label: 'Guaranteed background playback', available: false, detail: 'Native service source is included but is not connected and device-qualified in this web build. Browser suspension can stop playback and timers.' },
    { id: 'carplay', label: 'CarPlay and Android Auto', available: false, detail: 'Native browsing, entitlement approval, and physical-device validation are still required.' },
    { id: 'widgets', label: 'Widgets and system intents', available: false, detail: 'Native widget extensions, App Intents, and account-safe shared snapshots are not shipped in this build.' },
    { id: 'spotlight', label: 'Spotlight indexing', available: false, detail: 'Native account-scoped indexing and deletion are still required.' },
    { id: 'offline', label: 'Complete offline library', available: false, detail: 'Reserved for Phase 2; cached pages are not verified downloads.' },
  ];
}
