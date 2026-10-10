import { isTauri, invoke } from "@tauri-apps/api/core";

export async function setDesktopAppearance(
  theme: "light" | "dark" | "system",
  locale: string,
): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke("desktop_set_appearance", { theme, locale });
  return true;
}
