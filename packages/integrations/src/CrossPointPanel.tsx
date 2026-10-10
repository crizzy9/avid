import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CrossPointClient,
  validateCrossPointTransferPlan,
  type CrossPointReadiness,
  type CrossPointTransferPlan,
  type CrossPointVerification,
} from "./crosspoint";
import {
  connectorError,
  useConnectorI18n,
  type ConnectorMessageKey,
  type ConnectorNotice,
} from "./messages";

export interface CrossPointFileSource {
  id: string;
  name: string;
  load: () => Promise<Blob>;
}
export interface CrossPointPanelProps {
  accountScope?: string;
  fileSources?: CrossPointFileSource[];
  /** Only pass a native fetch bridge that has actually been registered and validated. */
  nativeFetch?: typeof fetch;
}

export function CrossPointPanel({
  accountScope = "local",
  fileSources = [],
  nativeFetch,
}: CrossPointPanelProps) {
  const { t } = useConnectorI18n();
  const id = useId();
  const client = useMemo(
    () =>
      new CrossPointClient({
        fetch: nativeFetch,
        transport: nativeFetch ? "injected-native-fetch" : "browser-fetch",
      }),
    [nativeFetch],
  );
  const storageKey = `avid:crosspoint:last-transfer:${encodeURIComponent(accountScope)}`;
  const [address, setAddress] = useState("crosspoint.local");
  const [fallback, setFallback] = useState("");
  const [directory, setDirectory] = useState("/");
  const [device, setDevice] = useState<CrossPointReadiness | null>(null);
  const [sourceId, setSourceId] = useState("local");
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<CrossPointTransferPlan | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<CrossPointVerification | null>(null);
  const [busy, setBusy] = useState<ConnectorMessageKey | null>(null);
  const [error, setError] = useState<ConnectorNotice | null>(null);
  const abort = useRef<AbortController | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    setPlan(null);
    setDevice(null);
    setAttempted(false);
    setResult(null);
    setError(null);
    setBusy(null);
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const recovered: unknown = JSON.parse(saved);
        validateCrossPointTransferPlan(recovered);
        setPlan(recovered);
        setAttempted(true);
      }
    } catch {
      /* Malformed local state is not a transfer request. */
    }
    return () => {
      epoch.current++;
      abort.current?.abort();
    };
  }, [client, storageKey]);

  function invalidate() {
    setDevice(null);
    setPlan(null);
    setAttempted(false);
    setResult(null);
    setError(null);
  }
  async function run(
    label: ConnectorMessageKey,
    action: (signal: AbortSignal, stillCurrent: () => boolean) => Promise<void>,
  ) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = ++epoch.current;
    setBusy(label);
    setError(null);
    try {
      await action(controller.signal, () => epoch.current === current);
    } catch (failure) {
      if (epoch.current === current)
        setError(connectorError(failure, "crosspoint"));
    } finally {
      if (epoch.current === current) setBusy(null);
    }
  }

  function inspect() {
    void run("checkingReader", async (signal, current) => {
      const readiness = await client.inspect(address, {
        ipFallback: fallback || undefined,
        directory,
        signal,
      });
      if (current()) {
        setDevice(readiness);
        setPlan(null);
        setAttempted(false);
        setResult(null);
      }
    });
  }
  function prepare() {
    if (!device) return;
    void run("preparing", async (signal, current) => {
      const source = fileSources.find((item) => item.id === sourceId);
      const bytes = sourceId === "local" ? file : await source?.load();
      const name = sourceId === "local" ? file?.name : source?.name;
      if (!bytes || !name) {
        if (current()) setError({ key: "chooseEpub" });
        return;
      }
      const next = await client.prepare(device, bytes, name, signal);
      if (current()) {
        setPlan(next);
        setAttempted(false);
        setResult(null);
      }
    });
  }
  function send() {
    if (!plan || attempted) return;
    const pending = plan;
    setAttempted(true);
    // Save only receipt metadata, never book bytes or BookOrbit credentials.
    try {
      localStorage.setItem(storageKey, JSON.stringify(pending));
    } catch {
      /* The current view retains its receipt. */
    }
    void run("sending", async (signal, current) => {
      const verification = await client.send(pending, signal);
      if (current()) setResult(verification);
    });
  }
  function verify() {
    if (!plan) return;
    const pending = plan;
    void run("verifying", async (signal, current) => {
      const verification = await client.verify(pending, signal);
      if (current()) setResult(verification);
    });
  }

  return (
    <div className="crosspoint-panel" style={{ display: "grid", gap: 14 }}>
      <p>{t("crossIntro")}</p>
      <label htmlFor={`${id}-address`}>{t("readerAddress")}</label>
      <input
        id={`${id}-address`}
        value={address}
        disabled={!!busy}
        autoCapitalize="none"
        spellCheck={false}
        placeholder={t("readerAddressPlaceholder")}
        onChange={(event) => {
          setAddress(event.target.value);
          invalidate();
        }}
      />
      <label htmlFor={`${id}-fallback`}>{t("fallbackIp")}</label>
      <input
        id={`${id}-fallback`}
        value={fallback}
        disabled={!!busy}
        placeholder={t("ipHint")}
        autoCapitalize="none"
        onChange={(event) => {
          setFallback(event.target.value);
          invalidate();
        }}
      />
      <label htmlFor={`${id}-directory`}>{t("destinationFolder")}</label>
      <input
        id={`${id}-directory`}
        value={directory}
        disabled={!!busy}
        placeholder="/Books"
        onChange={(event) => {
          setDirectory(event.target.value);
          invalidate();
        }}
      />
      <button className="secondary-button" disabled={!!busy} onClick={inspect}>
        {t("checkReader")}
      </button>
      {device && (
        <div>
          <p>
            <strong>
              {t("deviceVersion", {
                device: device.device.device ?? "CrossPoint",
                version: device.device.version,
              })}
            </strong>
            <br />
            {t("deviceFiles", {
              count: device.files.length,
              directory: device.directory,
              ip: device.device.ip,
            })}
          </p>
          <p className="muted">{t("firmwareHint")}</p>
          {fileSources.length > 0 && (
            <>
              <label htmlFor={`${id}-source`}>{t("epubSource")}</label>
              <select
                id={`${id}-source`}
                value={sourceId}
                disabled={!!busy}
                onChange={(event) => {
                  setSourceId(event.target.value);
                  setPlan(null);
                  setAttempted(false);
                  setResult(null);
                }}
              >
                <option value="local">{t("chooseLocal")}</option>
                {fileSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {sourceId === "local" && (
            <>
              <label htmlFor={`${id}-file`}>{t("epubFile")}</label>
              <input
                id={`${id}-file`}
                type="file"
                accept=".epub,application/epub+zip"
                disabled={!!busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPlan(null);
                  setAttempted(false);
                  setResult(null);
                }}
              />
            </>
          )}
          <button
            className="secondary-button"
            style={{ marginTop: 12 }}
            disabled={!!busy || (sourceId === "local" && !file)}
            onClick={prepare}
          >
            {t("reviewTransfer")}
          </button>
        </div>
      )}
      {plan && (
        <div style={{ overflowWrap: "anywhere" }}>
          <p>
            <strong>{plan.originalName}</strong>
            <br />
            {t("sendDestination", {
              destination: `${plan.device.address}${plan.directory === "/" ? "" : plan.directory}/${plan.destinationName}`,
            })}
          </p>
          <p className="muted">
            {t("fileSizeHint", { size: plan.size / 1024 / 1024 })}
          </p>
          {!attempted ? (
            <button className="primary-button" disabled={!!busy} onClick={send}>
              {t("send")}
            </button>
          ) : (
            <button
              className="secondary-button"
              disabled={!!busy}
              onClick={verify}
            >
              {t("verifyAgain")}
            </button>
          )}
        </div>
      )}
      {busy && (
        <div role="status">
          {t(busy)}{" "}
          <button
            className="text-button"
            onClick={() => abort.current?.abort()}
          >
            {t("cancel")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {t(error.key, error.values)}
        </p>
      )}
      {result && (
        <p role="status">
          <strong>
            {t(
              result.state === "verified"
                ? "transferVerified"
                : "transferReview",
            )}
          </strong>{" "}
          {t(
            result.state === "verified"
              ? "verifiedDetail"
              : result.state === "missing"
                ? "missingDetail"
                : "differentDetail",
          )}
        </p>
      )}
      <p className="muted">{t("networkHint")}</p>
    </div>
  );
}
