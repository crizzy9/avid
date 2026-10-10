import { LOCALES, useI18n, type Locale } from "../../../packages/i18n/src";
import { formatPlayerTime, type PlayerTimeline } from "./playerTimeline";

type Translations = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];
export const playerMessages = {
  chapterCount: [
    "Chapter {current} of {total}",
    "Luku {current}/{total}",
    "Chapitre {current} sur {total}",
    "Kapitel {current} von {total}",
    "Rozdział {current} z {total}",
    "第 {current} 章，共 {total} 章",
    "Capítulo {current} de {total}",
  ],
  chapterPosition: [
    "Chapter position",
    "Kohta luvussa",
    "Position dans le chapitre",
    "Position im Kapitel",
    "Pozycja w rozdziale",
    "章节进度",
    "Posición en el capítulo",
  ],
  chapterElapsed: [
    "Chapter elapsed",
    "Lukua kulunut",
    "Temps écoulé du chapitre",
    "Vergangene Kapitelzeit",
    "Upłynęło w rozdziale",
    "章节已播放",
    "Tiempo transcurrido del capítulo",
  ],
  chapterRemaining: [
    "Chapter remaining",
    "Lukua jäljellä",
    "Temps restant du chapitre",
    "Verbleibende Kapitelzeit",
    "Pozostało w rozdziale",
    "章节剩余",
    "Tiempo restante del capítulo",
  ],
  bookElapsed: [
    "Book elapsed",
    "Kirjaa kulunut",
    "Temps écoulé du livre",
    "Vergangene Buchzeit",
    "Upłynęło w książce",
    "全书已播放",
    "Tiempo transcurrido del libro",
  ],
  bookRemaining: [
    "Book remaining",
    "Kirjaa jäljellä",
    "Temps restant du livre",
    "Verbleibende Buchzeit",
    "Pozostało w książce",
    "全书剩余",
    "Tiempo restante del libro",
  ],
  wholeBook: [
    "Whole book",
    "Koko kirja",
    "Livre entier",
    "Gesamtes Buch",
    "Cała książka",
    "全书",
    "Libro completo",
  ],
  remainingAtRate: [
    "{time} remaining at {rate}×",
    "{time} jäljellä nopeudella {rate}×",
    "{time} restantes à {rate}×",
    "Noch {time} bei {rate}×",
    "Pozostało {time} przy {rate}×",
    "以 {rate}× 播放还剩 {time}",
    "Quedan {time} a {rate}×",
  ],
  durationUnknown: [
    "Duration not available",
    "Kesto ei ole saatavilla",
    "Durée indisponible",
    "Dauer nicht verfügbar",
    "Czas trwania niedostępny",
    "暂无时长",
    "Duración no disponible",
  ],
  duration: [
    "Duration {time}",
    "Kesto {time}",
    "Durée {time}",
    "Dauer {time}",
    "Czas trwania {time}",
    "时长 {time}",
    "Duración {time}",
  ],
  positionValue: [
    "{elapsed} of {duration}",
    "{elapsed}/{duration}",
    "{elapsed} sur {duration}",
    "{elapsed} von {duration}",
    "{elapsed} z {duration}",
    "{elapsed}，共 {duration}",
    "{elapsed} de {duration}",
  ],
  remoteControls: [
    "System skip controls",
    "Järjestelmän siirtymispainikkeet",
    "Commandes de saut système",
    "System-Sprungsteuerung",
    "Systemowe sterowanie przewijaniem",
    "系统跳转控制",
    "Controles de salto del sistema",
  ],
  chapterNumber: [
    "Chapter {number}",
    "Luku {number}",
    "Chapitre {number}",
    "Kapitel {number}",
    "Rozdział {number}",
    "第 {number} 章",
    "Capítulo {number}",
  ],
} as const satisfies Record<string, Translations>;

export type PlayerMessageKey = keyof typeof playerMessages;
export function playerTranslate(
  key: PlayerMessageKey,
  parameters: Record<string, string | number> = {},
  locale: Locale = "en",
) {
  return playerMessages[key][
    LOCALES.findIndex((item) => item.code === locale)
  ].replace(/\{(\w+)\}/g, (token, name: string) =>
    String(parameters[name] ?? token),
  );
}
export function usePlayerI18n() {
  const { locale } = useI18n();
  return (
    key: PlayerMessageKey,
    parameters?: Record<string, string | number>,
  ) => playerTranslate(key, parameters, locale);
}

/** Shared by the expanded player, mini player and book details. */
export function playerRemainingLabel(
  timeline: Pick<PlayerTimeline, "listeningRemaining" | "rate">,
  locale: Locale = "en",
): string {
  return timeline.listeningRemaining === null
    ? playerTranslate("durationUnknown", {}, locale)
    : playerTranslate(
        "remainingAtRate",
        {
          time: formatPlayerTime(Math.ceil(timeline.listeningRemaining)),
          rate: new Intl.NumberFormat(locale, {
            maximumFractionDigits: 2,
          }).format(timeline.rate),
        },
        locale,
      );
}
