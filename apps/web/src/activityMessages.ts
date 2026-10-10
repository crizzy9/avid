import {
  getLocale,
  LOCALES,
  useI18n,
  type Locale,
} from "../../../packages/i18n/src";
const messages = {
  source: [
    "Platform",
    "Alusta",
    "Plateforme",
    "Plattform",
    "Platforma",
    "平台",
    "Plataforma",
  ],
  allSources: [
    "All platforms",
    "Kaikki alustat",
    "Toutes les plateformes",
    "Alle Plattformen",
    "Wszystkie platformy",
    "所有平台",
    "Todas las plataformas",
  ],
  sourceHint: [
    "Platform totals combine reading and listening. Selecting a reading type returns to all platforms.",
    "Alustojen ajat sisältävät lukemisen ja kuuntelun. Lukutyypin valinta palauttaa kaikki alustat.",
    "Les totaux par plateforme regroupent lecture et écoute. Choisir un type rétablit toutes les plateformes.",
    "Plattformzeiten umfassen Lesen und Hören. Ein Lesetyp zeigt wieder alle Plattformen.",
    "Czas platform obejmuje czytanie i słuchanie. Wybór rodzaju przywraca wszystkie platformy.",
    "平台总时长包含阅读与收听。选择阅读类型后将显示所有平台。",
    "Los totales por plataforma combinan lectura y escucha. Elegir un tipo vuelve a todas las plataformas.",
  ],
  allTime: [
    "Entire account",
    "Koko tili",
    "Compte entier",
    "Gesamtes Konto",
    "Całe konto",
    "整个账户",
    "Toda la cuenta",
  ],
  timeline: [
    "Server reading history",
    "Palvelimen lukuhistoria",
    "Historique de lecture du serveur",
    "Leseverlauf auf dem Server",
    "Historia czytania na serwerze",
    "服务器阅读记录",
    "Historial de lectura del servidor",
  ],
  local: [
    "Activity saved on this device",
    "Tälle laitteelle tallennettu toiminta",
    "Activité enregistrée sur cet appareil",
    "Auf diesem Gerät gespeicherte Aktivität",
    "Aktywność zapisana na tym urządzeniu",
    "此设备保存的活动",
    "Actividad guardada en este dispositivo",
  ],
  previous: [
    "Previous week",
    "Edellinen viikko",
    "Semaine précédente",
    "Vorige Woche",
    "Poprzedni tydzień",
    "上一周",
    "Semana anterior",
  ],
  next: [
    "Next week",
    "Seuraava viikko",
    "Semaine suivante",
    "Nächste Woche",
    "Następny tydzień",
    "下一周",
    "Semana siguiente",
  ],
  week: [
    "Week {week}, {year} · {start} – {end} (UTC)",
    "Viikko {week}, {year} · {start} – {end} (UTC)",
    "Semaine {week}, {year} · {start} – {end} (UTC)",
    "Woche {week}, {year} · {start} – {end} (UTC)",
    "Tydzień {week}, {year} · {start} – {end} (UTC)",
    "{year} 年第 {week} 周 · {start} – {end}（UTC）",
    "Semana {week}, {year} · {start} – {end} (UTC)",
  ],
  noHistory: [
    "No server sessions in this week.",
    "Tällä viikolla ei ole palvelinistuntoja.",
    "Aucune session sur le serveur cette semaine.",
    "Diese Woche keine Sitzungen auf dem Server.",
    "Brak sesji na serwerze w tym tygodniu.",
    "本周没有服务器会话记录。",
    "No hay sesiones del servidor esta semana.",
  ],
  timelineHint: [
    "This server reports session format and platform; exact reading/listening session types are not included in this view.",
    "Palvelin ilmoittaa istunnon muodon ja alustan; tarkka luku- tai kuuntelutyyppi ei sisälly tähän näkymään.",
    "Le serveur indique le format et la plateforme ; le type exact de lecture ou d’écoute n’est pas fourni ici.",
    "Der Server meldet Format und Plattform; genaue Lese- oder Hörtypen fehlen in dieser Ansicht.",
    "Serwer podaje format i platformę; dokładny rodzaj czytania lub słuchania nie jest tu dostępny.",
    "此视图的服务器记录提供格式和平台，但不提供精确的阅读或收听类型。",
    "El servidor indica formato y plataforma; esta vista no incluye el tipo exacto de lectura o escucha.",
  ],
  more: [
    "Show more sessions",
    "Näytä lisää istuntoja",
    "Afficher plus de sessions",
    "Weitere Sitzungen anzeigen",
    "Pokaż więcej sesji",
    "显示更多会话",
    "Mostrar más sesiones",
  ],
  limit: [
    "This week reached the server’s 3,000-session limit. Some sessions may be omitted.",
    "Viikko saavutti palvelimen 3 000 istunnon rajan. Osa istunnoista voi puuttua.",
    "Cette semaine atteint la limite de 3 000 sessions du serveur. Certaines peuvent manquer.",
    "Diese Woche erreicht das Serverlimit von 3.000 Sitzungen. Einige können fehlen.",
    "Ten tydzień osiągnął limit 3000 sesji serwera. Niektóre sesje mogą być pominięte.",
    "本周达到服务器 3,000 条会话上限，部分记录可能未显示。",
    "Esta semana llegó al límite de 3.000 sesiones del servidor. Algunas pueden faltar.",
  ],
} as const;
export function activityTranslate(
  key: keyof typeof messages,
  params: Record<string, string | number> = {},
  locale: Locale = getLocale(),
) {
  return messages[key][
    LOCALES.findIndex((value) => value.code === locale)
  ].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}
export function useActivityI18n() {
  useI18n();
  return activityTranslate;
}
