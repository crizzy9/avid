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

export interface AO3PanelProps {
  accountScope: string;
  onImport: (edition: Ao3Import) => Promise<void>;
}
/** Opt-in account connector. The host preserves one work identity and separate edition file identities. */
export function AO3Panel({ accountScope, onImport }: AO3PanelProps) {
  const id = useId();
  const [enabled, setEnabled] = useState(false),
    [address, setAddress] = useState("http://127.0.0.1:43119");
  const [pairing, setPairing] = useState(""),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState("");
  const [account, setAccount] = useState<string | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
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
    setBusy("");
    setPassword("");
    setPairing("");
    setNotice("");
    setError("");
  };
  useEffect(() => {
    ownerScope.current = accountScope;
    setEnabled(false);
    setLogin("");
    setPassword("");
    setPairing("");
    setError("");
    setNotice("");
    setAccount(null);
    setWorks([]);
    setEditions({});
    setTracked([]);
    setNextPage(undefined);
    setBusy("");
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
    label: string,
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
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action(control.signal, current);
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error ? cause.message : "The AO3 request failed.",
        );
        if (cause instanceof Ao3Error && cause.status === 401) {
          setAccount(null);
          setPassword("");
        }
      }
    } finally {
      if (current()) setBusy("");
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
      setNotice(
        `${result.unavailable} unavailable or unrevealed subscription(s) cannot be inspected.`,
      );
  };
  const connect = () => {
    const user = login,
      secret = password,
      code = pairing;
    setPassword("");
    void run("Connecting to AO3…", async (signal, current) => {
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
    void run(`Checking ${work.title}…`, async (signal, current) => {
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
          ? "This edition is already in Avid."
          : previous
            ? `${added} new chapter(s). Review and import this edition; previous editions remain available.`
            : "Ready to import the first edition of this followed work.",
      );
    });
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
      setNotice("This edition is already in Avid.");
      return;
    }
    void run(`Downloading ${edition.title}…`, async (signal, current) => {
      const incoming = await c.download(edition, signal);
      if (!current()) return;
      await onImport(incoming);
      if (!current()) return;
      records.record(edition, true);
      setTracked(records.all());
      setNotice(
        "Edition imported. Previous editions, notes and reading positions are retained.",
      );
    });
  };
  const currentOwner = ownerScope.current === accountScope;
  const visibleAccount = currentOwner ? account : null;
  return (
    <section className="ao3-panel" style={{ display: "grid", gap: 14 }}>
      <p>
        Follow works through your own AO3 subscriptions. Checks and EPUB
        downloads run only when you request them. Opening work pages can update
        your AO3 reading history.
      </p>
      <label>
        <input
          type="checkbox"
          checked={currentOwner && enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            if (!event.target.checked) disconnect();
          }}
        />{" "}
        Enable the AO3 account connector
      </label>
      {currentOwner && enabled && !visibleAccount && (
        <>
          <details>
            <summary>Set up the local companion</summary>
            <p>
              On the same computer, run{" "}
              <code>node scripts/ao3-companion.mjs</code> using Node 24, then
              enter its address and pairing code. The companion accepts
              configured Avid origins and connects only to AO3. Passwords and
              cookies remain in memory; stopping it clears every session.
              Mobile-device and hosted-site connection policies still require
              qualification.
            </p>
          </details>
          <form
            style={{ display: "grid", gap: 10 }}
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <label htmlFor={`${id}-address`}>Companion address</label>
            <input
              id={`${id}-address`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={!!busy}
              autoCapitalize="none"
            />
            <label htmlFor={`${id}-pairing`}>Pairing code</label>
            <input
              id={`${id}-pairing`}
              type="password"
              value={pairing}
              onChange={(event) => setPairing(event.target.value)}
              disabled={!!busy}
              autoComplete="off"
            />
            <label htmlFor={`${id}-login`}>AO3 username or email</label>
            <input
              id={`${id}-login`}
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              disabled={!!busy}
              autoComplete="username"
              autoCapitalize="none"
            />
            <label htmlFor={`${id}-password`}>AO3 password</label>
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
              Connect AO3 account
            </button>
          </form>
        </>
      )}
      {currentOwner && enabled && visibleAccount && (
        <>
          <p>
            Connected as <strong>{visibleAccount}</strong> · {works.length}{" "}
            followed works loaded.
          </p>
          <div className="button-row">
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={() => {
                const c = client.current;
                if (c)
                  void run("Refreshing subscriptions…", (signal, current) =>
                    readPage(c, 1, signal, current),
                  );
              }}
            >
              Refresh subscriptions
            </button>
            <button className="secondary-button" onClick={disconnect}>
              Disconnect and clear session
            </button>
          </div>
          {!works.length && !busy && (
            <p>
              No visible work subscriptions were found. Subscribe to a work on
              AO3, then refresh.
            </p>
          )}
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
                    Check updates
                  </button>
                  {edition && (
                    <>
                      <p>
                        {edition.chapterIds.length} chapter(s) ·{" "}
                        {imported
                          ? "Edition already imported"
                          : "New edition available"}
                      </p>
                      <button
                        className="primary-button"
                        disabled={!!busy || imported}
                        onClick={() => importEdition(edition)}
                      >
                        Import this edition
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
                  void run("Loading followed works…", (signal, current) =>
                    readPage(c, nextPage, signal, current),
                  );
              }}
            >
              Load more followed works
            </button>
          )}
        </>
      )}
      {busy && (
        <p role="status">
          {busy}{" "}
          <button
            className="text-button"
            onClick={() => {
              epoch.current++;
              abort.current?.abort();
              setBusy("");
            }}
          >
            Cancel
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <p className="muted">
        New editions do not replace prior files or translate old CFI positions.
        This connector does not upload to BookOrbit or change your AO3
        subscriptions.
      </p>
    </section>
  );
}
