import { useEffect, useState } from 'react';
import { useI18n } from '../../../packages/i18n/src';
import { getPlatformCapabilities, readBrowserCapabilities, type BrowserCapabilityEvidence, type PlatformCapability, type PlatformCapabilityEvidence } from '../../../packages/playback/src/capabilities';
import { getNativePlayback } from '../../mobile/src/native-playback';
import { getNativeSystemSurfaces } from '../../mobile/src/native-surfaces';
import { capabilityTranslate } from './capabilityMessages';

interface CapabilityBridge { capabilities?(): Promise<unknown> }
export interface PlatformCapabilityRuntime {
  browser(): BrowserCapabilityEvidence;
  playback(): CapabilityBridge | null;
  surfaces(): CapabilityBridge | null;
  speech(): Pick<SpeechSynthesis, 'addEventListener' | 'removeEventListener'> | null;
}
const installedRuntime: PlatformCapabilityRuntime = {
  browser: readBrowserCapabilities,
  playback: getNativePlayback,
  surfaces: getNativeSystemSurfaces,
  speech: () => typeof speechSynthesis === 'undefined' ? null : speechSynthesis,
};

function snapshot(runtime: PlatformCapabilityRuntime) {
  const playback = runtime.playback(), surfaces = runtime.surfaces();
  const evidence: PlatformCapabilityEvidence = {
    browser: runtime.browser(),
    playback: { installed: playback !== null, checking: typeof playback?.capabilities === 'function' },
    surfaces: { installed: surfaces !== null, checking: typeof surfaces?.capabilities === 'function' },
  };
  return { evidence, playback, surfaces };
}

/** Native calls cannot be cancelled; bound the wait and discard results after refresh/unmount. */
function readReport(bridge: CapabilityBridge, signal: AbortSignal): Promise<unknown> {
  if (typeof bridge.capabilities !== 'function' || signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let settled = false;
    const finish = (result?: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(result);
    };
    const aborted = () => finish();
    const timer = window.setTimeout(() => finish(), 5_000);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => bridge.capabilities!()).then(finish, () => finish());
  });
}

/** Localized, read-only installed capabilities. Never loads media or changes an account. */
export function usePlatformCapabilities(runtime: PlatformCapabilityRuntime = installedRuntime): PlatformCapability[] {
  const { locale } = useI18n();
  const [evidence, setEvidence] = useState(() => snapshot(runtime).evidence);
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    const refresh = () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const current = snapshot(runtime);
      setEvidence(current.evidence);
      for (const kind of ['playback', 'surfaces'] as const) {
        const bridge = current[kind];
        if (!bridge) continue;
        void readReport(bridge, controller.signal).then(report => {
          if (active && !controller.signal.aborted) setEvidence(previous => ({ ...previous, [kind]: { installed: true, checking: false, report } }));
        });
      }
    };
    const voicesChanged = () => setEvidence(previous => ({ ...previous, browser: runtime.browser() }));
    const visible = () => { if (!document.hidden) refresh(); };
    const speech = runtime.speech();
    speech?.addEventListener('voiceschanged', voicesChanged);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    refresh();
    return () => {
      active = false;
      request?.abort();
      speech?.removeEventListener('voiceschanged', voicesChanged);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [runtime]);
  return getPlatformCapabilities(evidence, key => capabilityTranslate(key, locale));
}
