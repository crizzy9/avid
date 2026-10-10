import { getLocale, LOCALES, useI18n } from "../../../packages/i18n/src";
const messages = {
  fallback: [
    "No chapters available; skipping {seconds} seconds.",
    "Lukuja ei ole saatavilla; siirtymä on {seconds} sekuntia.",
    "Aucun chapitre disponible ; saut de {seconds} secondes.",
    "Keine Kapitel verfügbar; es wird um {seconds} Sekunden gesprungen.",
    "Brak rozdziałów; przewijanie o {seconds} sekund.",
    "暂无章节；每次跳转 {seconds} 秒。",
    "No hay capítulos disponibles; se salta {seconds} segundos.",
  ],
  controls: [
    "Skip controls",
    "Siirtymispainikkeet",
    "Commandes de saut",
    "Sprungsteuerung",
    "Sterowanie przewijaniem",
    "跳转控制",
    "Controles de salto",
  ],
  seconds: [
    "{seconds} seconds",
    "{seconds} sekuntia",
    "{seconds} secondes",
    "{seconds} Sekunden",
    "{seconds} sekund",
    "{seconds} 秒",
    "{seconds} segundos",
  ],
  chapter: [
    "By chapter",
    "Luvuittain",
    "Par chapitre",
    "Nach Kapitel",
    "Według rozdziałów",
    "按章节",
    "Por capítulo",
  ],
  back: [
    "Back {seconds} seconds",
    "Takaisin {seconds} sekuntia",
    "Reculer de {seconds} secondes",
    "{seconds} Sekunden zurück",
    "Wstecz o {seconds} sekund",
    "后退 {seconds} 秒",
    "Retroceder {seconds} segundos",
  ],
  forward: [
    "Forward {seconds} seconds",
    "Eteenpäin {seconds} sekuntia",
    "Avancer de {seconds} secondes",
    "{seconds} Sekunden vor",
    "Dalej o {seconds} sekund",
    "前进 {seconds} 秒",
    "Avanzar {seconds} segundos",
  ],
  previous: [
    "Previous chapter",
    "Edellinen luku",
    "Chapitre précédent",
    "Vorheriges Kapitel",
    "Poprzedni rozdział",
    "上一章",
    "Capítulo anterior",
  ],
  next: [
    "Next chapter",
    "Seuraava luku",
    "Chapitre suivant",
    "Nächstes Kapitel",
    "Następny rozdział",
    "下一章",
    "Capítulo siguiente",
  ],
  save: [
    "This skip preference could not be saved on this device.",
    "Siirtymisasetusta ei voitu tallentaa tälle laitteelle.",
    "Cette préférence de saut n’a pas pu être enregistrée sur cet appareil.",
    "Diese Sprungeinstellung konnte auf diesem Gerät nicht gespeichert werden.",
    "Nie udało się zapisać ustawienia przewijania na tym urządzeniu.",
    "无法在此设备上保存跳转偏好。",
    "No se pudo guardar esta preferencia de salto en este dispositivo.",
  ],
} as const;
export function useRemoteI18n() {
  useI18n();
  return (
    key: keyof typeof messages,
    params: Record<string, string | number> = {},
  ) =>
    messages[key][
      LOCALES.findIndex((locale) => locale.code === getLocale())
    ].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}
