import { Capacitor, registerPlugin } from "@capacitor/core";
import { setDesktopAppearance } from "../../desktop/src/appearance";
import type { Locale } from "../../../packages/i18n/src";

export type NativeTheme = "light" | "dark" | "system";
interface NativeAppearance {
  setTheme(options: { theme: NativeTheme; locale: Locale }): Promise<void>;
}
const plugin = registerPlugin<NativeAppearance>("AvidAppearance");

/** Native chrome follows the same explicit preference; never recreate the reader to change theme. */
export async function setNativeAppearance(
  theme: NativeTheme,
  locale: Locale = "en",
): Promise<boolean> {
  if (await setDesktopAppearance(theme, locale)) return true;
  if (
    !Capacitor.isNativePlatform() ||
    !Capacitor.isPluginAvailable("AvidAppearance")
  )
    return false;
  await plugin.setTheme({ theme, locale });
  return true;
}
