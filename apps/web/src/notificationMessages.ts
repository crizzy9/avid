import { getLocale, LOCALES, type Locale } from "../../../packages/i18n/src";
type Seven = readonly [string, string, string, string, string, string, string];
export const notificationMessages = {
  dismiss: [
    "Dismiss notification",
    "Sulje ilmoitus",
    "Fermer la notification",
    "Benachrichtigung schließen",
    "Zamknij powiadomienie",
    "关闭通知",
    "Cerrar notificación",
  ],
  waiting: [
    "{count} more messages",
    "Vielä {count} ilmoitusta",
    "{count} autres messages",
    "{count} weitere Meldungen",
    "Pozostałe wiadomości: {count}",
    "还有 {count} 条消息",
    "{count} mensajes más",
  ],
  next: [
    "Dismiss and show next message",
    "Sulje ja näytä seuraava ilmoitus",
    "Fermer et afficher le message suivant",
    "Schließen und nächste Meldung anzeigen",
    "Zamknij i pokaż następną wiadomość",
    "关闭并显示下一条消息",
    "Cerrar y mostrar el siguiente mensaje",
  ],
} as const satisfies Record<string, Seven>;
export function notificationT(
  key: keyof typeof notificationMessages,
  values: Record<string, string | number> = {},
  locale: Locale = getLocale(),
) {
  const index = LOCALES.findIndex((item) => item.code === locale);
  return notificationMessages[key][index < 0 ? 0 : index].replace(
    /\{(\w+)\}/g,
    (token, name: string) =>
      values[name] === undefined ? token : String(values[name]),
  );
}
