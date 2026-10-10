import { Capacitor, registerPlugin } from '@capacitor/core';

export type NativeTheme = 'light' | 'dark' | 'system';
interface NativeAppearance { setTheme(options: { theme: NativeTheme }): Promise<void> }
const plugin = registerPlugin<NativeAppearance>('AvidAppearance');

/** Native chrome follows the same explicit preference; never recreate the reader to change theme. */
export async function setNativeAppearance(theme: NativeTheme): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('AvidAppearance')) return false;
  await plugin.setTheme({ theme });
  return true;
}
