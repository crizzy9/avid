import { useEffect, useId, useRef, useState } from "react";
import {
  Ao3Client,
  Ao3Error,
  Ao3FollowStore,
  type Ao3FollowedWork,
  type Ao3Import,
  type Ao3StoredWork,
  type Ao3WorkEdition,
} from "./ao3";
import {
  connectorError,
  useConnectorI18n,
  type ConnectorNotice,
  type ConnectorMessageKey,
} from "./messages";

export interface AO3PanelProps {
  accountScope: string;
  onImport: (edition: Ao3Import) => Promise<void>;
}
/** Opt-in account connector. The host preserves one work identity and separate edition file identities. */
export function AO3Panel({ accountScope, onImport }: AO3PanelProps) {
  const { t } = useConnectorI18n();
  const id = useId();
  const [enabled, setEnabled] = useState(false),
    [address, setAddress] = useState("http://127.0.0.1:43119");
  const [pairing, setPairing] = useState(""),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState("");
  const [account, setAccount] = useState<string | null>(null),
    [busy, setBusy] = useState<ConnectorNotice | null>(null),
    [error, setError] = useState<ConnectorNotice | null>(null),
    [notice, setNotice] = useState<ConnectorNotice | null>(null);
  const [works, setWorks] = useState<Ao3FollowedWork[]>([]),
    [nextPage, setNextPage] = useState<number | undefined>();
  const [editions, setEditions] = useState<Record<string, Ao3WorkEdition>>({}),
    [tracked, setTracked] = useState<Ao3StoredWork[]>([]);
  const client = useRef<Ao3Client | null>(null),
    store = useRef<Ao3FollowStore | null>(null),
    abort = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const currentScope = useRef(accountScope);
  currentScope.current = accountScope;
  const ownerScope = useRef(accountScope);
  const disconnect = () => {
    epoch.current++;
    abort.current?.abort();
    abort.current = null;
    const previous = client.current;
    client.current = null;
    store.current = null;
    void previous?.disconnect().catch(() => {});
    setAccount(null);
    setWorks([]);
    setEditions({});
    setTracked([]);
    setNextPage(undefined);
    setBusy(null);
    setPassword("");
    setPairing("");
    setNotice(null);
    setError(null);
  };
  useEffect(() => {
    ownerScope.current = accountScope;
    setEnabled(false);
    setLogin("");
    setPassword("");
    setPairing("");
    setError(null);
    setNotice(null);
    setAccount(null);
    setWorks([]);
    setEditions({});
    setTracked([]);
    setNextPage(undefined);
    setBusy(null);
    return () => {
      epoch.current++;
      abort.current?.abort();
      const previous = client.current;
      client.current = null;
      store.current = null;
      void previous?.disconnect().catch(() => {});
    };
  }, [accountScope]);
  async function run(
    label: ConnectorMessageKey | ConnectorNotice,
    action: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    abort.current?.abort();
    const control = new AbortController();
    abort.current = control;
    const generation = ++epoch.current,
      scope = accountScope;
    const current = () =>
      generation === epoch.current &&
      scope === currentScope.current &&
      !control.signal.aborted;
    setBusy(typeof label === "string" ? { key: label } : label);
    setError(null);
    setNotice(null);
    try {
      await action(control.signal, current);
    } catch (cause) {
      if (current()) {
        setError(connectorError(cause, "ao3"));
        if (cause instanceof Ao3Error && cause.status === 401) {
          setAccount(null);
          setPassword("");
        }
      }
    } finally {
      if (current()) setBusy(null);
    }
  }
  const readPage = async (
    c: Ao3Client,
    page: number,
    signal: AbortSignal,
    current: () => boolean,
  ) => {
    const result = await c.subscriptions(page, signal);
    if (!current()) return;
    setWorks((previous) =>
      [
        ...new Map(
          [...(page === 1 ? [] : previous), ...result.works].map((work) => [
            work.workId,
            work,
          ]),
        ).values(),
      ].slice(0, 1000),
    );
    setNextPage(result.nextPage);
    if (result.unavailable)
      setNotice({
        key: "unavailableWorks",
        values: { count: result.unavailable },
      });
  };
  const connect = () => {
    const user = login,
      secret = password,
      code = pairing;
    setPassword("");
    void run("ao3Connecting", async (signal, current) => {
      const next = new Ao3Client(address, code);
      const accountId = await next.connect(user, secret, signal);
      if (!current()) {
        await next.disconnect();
        return;
      }
      const previous = client.current;
      client.current = next;
      void previous?.disconnect().catch(() => {});
      const records = new Ao3FollowStore(accountScope, accountId);
      store.current = records;
      setTracked(records.all());
      setAccount(accountId);
      setWorks([]);
      setEditions({});
      setNextPage(undefined);
      ownerScope.current = accountScope;
      await readPage(next, 1, signal, current);
    });
  };
  const check = (work: Ao3FollowedWork) => {
    const c = client.current,
      records = store.current;
    if (!c || !records) return;
    void run(
      { key: "checkingTitle", values: { title: work.title } },
      async (signal, current) => {
        const edition = await c.edition(work.workId, signal);
        if (!current()) return;
        const previous = records
          .all()
          .find((item) => item.workId === work.workId);
        const saved = records.record(edition);
        setTracked(records.all());
        setEditions((values) => ({ ...values, [work.workId]: edition }));
        const added = edition.chapterIds.filter(
          (chapter) => !previous?.chapterIds.includes(chapter),
        ).length;
        setNotice(
          saved.importedRevisions.includes(edition.revision)
            ? { key: "alreadyImported" }
            : previous
              ? { key: "newChapters", values: { count: added } }
              : { key: "firstEdition" },
        );
      },
    );
  };
  const importEdition = (edition: Ao3WorkEdition) => {
    const c = client.current,
      records = store.current;
    if (!c || !records) return;
    if (
      records
        .all()
        .find((item) => item.workId === edition.workId)
        ?.importedRevisions.includes(edition.revision)
    ) {
      setNotice({ key: "alreadyImported" });
      return;
    }
    void run(
      { key: "downloadingTitle", values: { title: edition.title } },
      async (signal, current) => {
        const incoming = await c.download(edition, signal);
        if (!current()) return;
        await onImport(incoming);
        if (!current()) return;
        records.record(edition, true);
        setTracked(records.all());
        setNotice({ key: "imported" });
      },
    );
  };
  const currentOwner = ownerScope.current === accountScope;
  const visibleAccount = currentOwner ? account : null;
  return (
    <section className="ao3-panel" style={{ display: "grid", gap: 14 }}>
      <p>{t("ao3Intro")}</p>
      <label>
        <input
          type="checkbox"
          checked={currentOwner && enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            if (!event.target.checked) disconnect();
          }}
        />{" "}
        {t("ao3Enable")}
      </label>
      {currentOwner && enabled && !visibleAccount && (
        <>
          <details>
            <summary>{t("setup")}</summary>
            <p>
              {t("setupBody", { command: "node scripts/ao3-companion.mjs" })}
            </p>
          </details>
          <form
            style={{ display: "grid", gap: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <label htmlFor={`${id}-address`}>{t("companionAddress")}</label>
            <input
              id={`${id}-address`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={!!busy}
              autoCapitalize="none"
            />
            <label htmlFor={`${id}-pairing`}>{t("pairingCode")}</label>
            <input
              id={`${id}-pairing`}
              type="password"
              value={pairing}
              onChange={(event) => setPairing(event.target.value)}
              disabled={!!busy}
              autoComplete="off"
            />
            <label htmlFor={`${id}-login`}>{t("ao3Login")}</label>
            <input
              id={`${id}-login`}
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              disabled={!!busy}
              autoComplete="username"
              autoCapitalize="none"
            />
            <label htmlFor={`${id}-password`}>{t("ao3Password")}</label>
            <input
              id={`${id}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!!busy}
              autoComplete="current-password"
            />
            <button
              className="primary-button"
              disabled={!!busy || !login || !password || !pairing}
            >
              {t("ao3Connect")}
            </button>
          </form>
        </>
      )}
      {currentOwner && enabled && visibleAccount && (
        <>
          <p>
            {t("connected", { account: visibleAccount, count: works.length })}
          </p>
          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => {
                const c = client.current;
                if (c)
                  void run("subscriptionsRefreshing", (signal, current) =>
                    readPage(c, 1, signal, current),
                  );
              }}
            >
              {t("subscriptionsRefresh")}
            </button>
            <button className="secondary-button" onClick={disconnect}>
              {t("disconnect")}
            </button>
          </div>
          {!works.length && !busy && <p>{t("noWorks")}</p>}
          <ul
            style={{ listStyle: "none", padding: 0, display: "grid", gap: 16 }}
          >
            {works.map((work) => {
              const edition = editions[work.workId],
                saved = tracked.find((item) => item.workId === work.workId),
                imported =
                  !!edition &&
                  !!saved?.importedRevisions.includes(edition.revision);
              return (
                <li key={work.workId}>
                  <strong>{work.title}</strong>
                  <p>{work.author}</p>
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() => check(work)}
                  >
                    {t("checkUpdates")}
                  </button>
                  {edition && (
                    <>
                      {edition.workSkin && <p>{t("ao3StylingHint")}</p>}
                      <p>
                        {t(imported ? "editionImported" : "editionAvailable", {
                          count: edition.chapterIds.length,
                        })}
                      </p>
                      <button
                        className="primary-button"
                        disabled={!!busy || imported}
                        onClick={() => importEdition(edition)}
                      >
                        {t("importEdition")}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {nextPage && works.length < 1000 && (
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => {
                const c = client.current;
                if (c)
                  void run("worksLoading", (signal, current) =>
                    readPage(c, nextPage, signal, current),
                  );
              }}
            >
              {t("worksMore")}
            </button>
          )}
        </>
      )}
      {busy && (
        <p role="status">
          {t(busy.key, busy.values)}{" "}
          <button
            className="text-button"
            onClick={() => {
              epoch.current++;
              abort.current?.abort();
              setBusy(null);
            }}
          >
            {t("cancel")}
          </button>
        </p>
      )}
      {notice && <p role="status">{t(notice.key, notice.values)}</p>}
      {error && <p role="alert">{t(error.key, error.values)}</p>}
      <p className="muted">{t("editionsHint")}</p>
    </section>
  );
}
