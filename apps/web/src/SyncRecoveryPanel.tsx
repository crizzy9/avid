import { useEffect, useMemo, useRef, useState } from "react";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import {
  LibraryRepository,
  type OutboxOperation,
  type SyncPayload,
} from "../../../packages/core/src/repository";
import {
  RecoveryChangedError,
  SyncRecovery,
  type RecoveryAction,
  type RecoveryReceipt,
  type SyncReview,
} from "../../../packages/core/src/syncRecovery";
import { useRecoveryI18n, type RecoveryMessageKey } from "./recoveryMessages";
import "./SyncRecoveryPanel.css";

export interface SyncRecoveryPanelProps {
  repo: LibraryRepository;
  client: BookOrbitClient;
  onResolved?: () => void | Promise<void>;
}
/** The containing app supplies its existing modal; this panel owns no session credentials. */
export function SyncRecoveryPanel({
  repo,
  client,
  onResolved,
}: SyncRecoveryPanelProps) {
  const { t, locale } = useRecoveryI18n();
  const current = useRef({ repo, client });
  current.current = { repo, client };
  const mounted = useRef(true);
  const generation = useRef(0);
  const recovery = useMemo(
    () =>
      new SyncRecovery(repo, client, {
        isActive: () =>
          mounted.current &&
          current.current.repo === repo &&
          current.current.client === client,
      }),
    [repo, client],
  );
  const [operations, setOperations] = useState<OutboxOperation[]>([]),
    [receipts, setReceipts] = useState<RecoveryReceipt[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({}),
    [review, setReview] = useState<SyncReview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const owned = () =>
    mounted.current &&
    current.current.repo === repo &&
    current.current.client === client;
  async function reload() {
    const [pending, copies, books] = await Promise.all([
      recovery.list(),
      recovery.receipts(),
      repo.getBooks(),
    ]);
    if (owned()) {
      setOperations(pending);
      setReceipts(copies);
      setTitles(Object.fromEntries(books.map((book) => [book.id, book.title])));
    }
  }
  function report(cause: unknown) {
    setError(
      cause instanceof RecoveryChangedError
        ? t("changed")
        : t("error", {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
    );
  }
  useEffect(() => {
    mounted.current = true;
    const attempt = ++generation.current;
    setReview(null);
    setOperations([]);
    setReceipts([]);
    setTitles({});
    setError("");
    setNotice("");
    setBusy(true);
    void reload()
      .catch((cause) => {
        if (owned() && attempt === generation.current) report(cause);
      })
      .finally(() => {
        if (owned() && attempt === generation.current) setBusy(false);
      });
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [recovery]);
  async function inspect(id: string) {
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    setReview(null);
    try {
      const value = await recovery.inspect(id);
      if (owned() && attempt === generation.current) setReview(value);
    } catch (cause) {
      if (owned() && attempt === generation.current) report(cause);
    } finally {
      if (owned() && attempt === generation.current) setBusy(false);
    }
  }
  async function resolve(action: RecoveryAction) {
    if (!review || busy) return;
    const attempt = ++generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await recovery.resolve(review, action);
      if (!owned() || attempt !== generation.current) return;
      setReview(null);
      setNotice(t("saved"));
      await reload();
      if (owned() && attempt === generation.current) await onResolved?.();
    } catch (cause) {
      if (owned() && attempt === generation.current) report(cause);
    } finally {
      if (owned() && attempt === generation.current) setBusy(false);
    }
  }
  function exportCopies() {
    const blob = new Blob(
      [
        JSON.stringify(
          { version: 1, accountScope: repo.scope, receipts },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "avid-saved-sync-versions.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const time = (value: string) =>
    Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(locale)
      : t("unknownTime");
  const payload = (value: SyncPayload) =>
    value.kind === "progress" ? (
      <>
        <p>
          {new Intl.NumberFormat(locale, {
            style: "percent",
            maximumFractionDigits: 1,
          }).format(value.anchor.progress)}
        </p>
        <code>{value.anchor.locator}</code>
        <small>{time(value.anchor.updatedAt)}</small>
      </>
    ) : value.kind === "preferences" ? (
      <code>{JSON.stringify(value.localSet, null, 2)}</code>
    ) : value.kind === "annotation" ? (
      <>
        {value.annotation.deleted && <strong>{t("deleted")}</strong>}
        <blockquote>{value.annotation.quote}</blockquote>
        <p>{value.annotation.text}</p>
        <code>{value.annotation.locator}</code>
        <small>{time(value.annotation.updatedAt)}</small>
      </>
    ) : (
      <>
        <p>{value.session.duration.toLocaleString(locale)} s</p>
        <small>
          {time(value.session.startedAt)} – {time(value.endedAt)}
        </small>
      </>
    );
  const actions = review ? recovery.actions(review) : [];
  const actionKeys: Record<RecoveryAction, RecoveryMessageKey> = {
    "use-local": "useLocal",
    "use-server": "useServer",
    "keep-device": "keepDevice",
    retry: "retry",
  };
  return (
    <section className="sync-recovery" aria-label={t("title")}>
      <p>{t("introduction")}</p>
      {client.readOnly && <p className="field-hint">{t("readOnly")}</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">{t("loading")}</p>}
      {!busy && !operations.length && <p>{t("empty")}</p>}
      <ul className="recovery-items">
        {operations.map((operation) => {
          const value = operation.payload,
            bookId =
              value.kind === "progress"
                ? value.anchor.bookId
                : value.kind === "annotation"
                  ? value.annotation.bookId
                  : value.kind === "preferences"
                    ? value.bookId
                    : value.session.bookId;
          return (
            <li key={operation.id}>
              <div>
                <strong>{titles[bookId] ?? bookId}</strong>
                <span>{t(value.kind)}</span>
                <small>{time(operation.occurredAt)}</small>
              </div>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void inspect(operation.id)}
              >
                {t("compare")}
              </button>
            </li>
          );
        })}
      </ul>
      {review && (
        <section aria-label={t("compare")}>
          <p>{t("queued", { count: review.operations.length })}</p>
          <div className="recovery-comparison">
            <article>
              <h3>{t("local")}</h3>
              {payload(review.local)}
            </article>
            <article>
              <h3>{t("server")}</h3>
              {review.remote.kind === "unavailable" ? (
                <p>
                  {review.remote.reason === "read-only"
                    ? t("readOnly")
                    : t("unavailable", { error: review.remote.reason })}
                </p>
              ) : review.remote.kind === "progress" ? (
                review.remote.value ? (
                  payload({ kind: "progress", anchor: review.remote.value })
                ) : (
                  <p>{t("missing")}</p>
                )
              ) : review.remote.kind === "preferences" ? (
                <code>{JSON.stringify(review.remote.value, null, 2)}</code>
              ) : review.remote.kind === "annotation" ? (
                review.remote.value ? (
                  payload({
                    kind: "annotation",
                    annotation: review.remote.value,
                  })
                ) : (
                  <p>{t("missing")}</p>
                )
              ) : (
                <p>{t("retryHint")}</p>
              )}
            </article>
          </div>
          {review.local.kind === "annotation" &&
            review.remote.kind === "annotation" &&
            !review.remote.value &&
            !/^\d+$/.test(review.local.annotation.id) && <p>{t("noExact")}</p>}
          <p className="field-hint">{t("useHint")}</p>
          <p className="field-hint">{t("keepHint")}</p>
          <p className="field-hint">{t("retryHint")}</p>
          <div className="recovery-actions">
            {actions.map((action) => (
              <button
                key={action}
                className="secondary-button"
                disabled={busy}
                onClick={() => void resolve(action)}
              >
                {t(actionKeys[action])}
              </button>
            ))}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void inspect(review.operation.id)}
            >
              {t("refresh")}
            </button>
          </div>
        </section>
      )}
      {!!receipts.length && (
        <section>
          <p>{t("history", { count: receipts.length })}</p>
          <button className="secondary-button" onClick={exportCopies}>
            {t("export")}
          </button>
        </section>
      )}
    </section>
  );
}
