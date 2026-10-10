import {Capacitor, registerPlugin} from '@capacitor/core';
import {createDesktopCrossPointFetch, getDesktopCrossPointFetch, getDesktopReaderDiscovery, type DesktopCrossPointBridge} from '../../desktop/src/crosspoint';
import {createReaderDiscovery, type ReaderDiscoveryBridge, type DiscoverReaders} from '../../../packages/integrations/src/discovery';

const plugin = registerPlugin<DesktopCrossPointBridge & ReaderDiscoveryBridge>('AvidCrossPoint');
const nativeFetch = createDesktopCrossPointFetch(plugin);
const nativeDiscover = createReaderDiscovery(plugin);
function available() { return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('AvidCrossPoint'); }
const unavailableFetch: typeof fetch = async () => { throw new Error('The installed app has no isolated reader transport. Update Avid to continue.'); };
export function getCrossPointFetch(): typeof fetch | null {
  return getDesktopCrossPointFetch() ?? (Capacitor.isNativePlatform() ? (available() ? nativeFetch : unavailableFetch) : null);
}
/** Desktop/Android broadcast; iOS probes the firmware's default mDNS hostname and AP address. */
export function getReaderDiscovery(): DiscoverReaders | undefined {
  return getDesktopReaderDiscovery() ?? (available() ? nativeDiscover : undefined);
}
