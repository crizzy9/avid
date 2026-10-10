import { useI18n } from "../../../packages/i18n/src";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BookOpen,
  Server,
  ArrowRight,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import { BookOrbitClient } from "../../../packages/core/src/bookorbit";
import type { Session } from "../../../packages/core/src/types";
import { ProviderSignIn } from "./ProviderSignIn";
import { createNativeAuthFetch } from "../../mobile/src/native-auth";
import { getDesktopFetch } from "../../desktop/src/network";

export interface ConnectionAttemptBinding {
  nativeGeneration?: string;
}

export function Connect({
  onConnect,
  onAttempt,
}: {
  onConnect: (session: Session, readOnly: boolean) => Promise<void>;
  onAttempt?: (
    method?: "password" | "provider",
  ) =>
    void | ConnectionAttemptBinding | Promise<void | ConnectionAttemptBinding>;
}) {
  const { t, locale, setLocale } = useI18n();

  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false),
    attempt = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current++;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const current = ++attempt.current;
    const active = () => mounted.current && current === attempt.current;
    setBusy(true);
    setError("");
    try {
      const binding = await onAttempt?.("password");
      if (!active()) return;
      const serverUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const profile = {
        id: crypto.randomUUID(),
        name: new URL(serverUrl).hostname,
        url: serverUrl,
        username,
      };
      const session = await BookOrbitClient.login(profile, password, {
        readOnly,
        clientKind: getDesktopFetch() ? "native" : "web",
        fetch: binding?.nativeGeneration
          ? createNativeAuthFetch(binding.nativeGeneration, bookOrbitFetch)
          : bookOrbitFetch,
        transportBaseUrl: proxyBaseFor(serverUrl),
      });
      if (!active()) return;
      setPassword("");
      await onConnect(session, readOnly);
    } catch (err) {
      if (active())
        setError(
          err instanceof TypeError
            ? t("connect.unreachable")
            : err instanceof Error
              ? err.message
              : t("connect.failed"),
        );
    } finally {
      if (active()) setBusy(false);
    }
  }
  return (
    <form className="connect-form" onSubmit={submit}>
      <div className="connect-emblem">
        <BookOpen size={30} />
      </div>
      <h3>{t("connect.heading")}</h3>
      <p>{t("connect.hint")}</p>
      <label>
        {t("connect.address")}
        <div className="input-icon">
          <Server size={17} />
          <input
            required
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder="https://books.example.com"
            value={url}
            disabled={busy || providerBusy}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      </label>
      <label>
        {t("connect.username")}
        <input
          required
          autoComplete="username"
          value={username}
          disabled={busy || providerBusy}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t("connect.usernameHint")}
        />
      </label>
      <label>
        {t("connect.password")}
        <input
          required
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy || providerBusy}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("connect.passwordHint")}
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={readOnly}
          disabled={busy || providerBusy}
          onChange={(e) => setReadOnly(e.target.checked)}
        />{" "}
        {t("connect.readOnly")}
      </label>
      <p className="field-hint">{t("connect.readOnlyHint")}</p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <button
        className="primary-button full-width"
        disabled={busy || providerBusy}
        type="submit"
      >
        {busy ? (
          <LoaderCircle size={17} className="spin" />
        ) : (
          <ArrowRight size={17} />
        )}{" "}
        {busy ? t("connect.busy") : t("connect.button")}
      </button>
      <ProviderSignIn
        serverUrl={url}
        readOnly={readOnly}
        disabled={busy}
        onAttempt={() => onAttempt?.("provider")}
        onBusyChange={setProviderBusy}
      />
      <p className="privacy-note">
        <ShieldCheck size={15} />
        {t("connect.privacy")}
      </p>
    </form>
  );
}

/** The development proxy is optional and only forwards to the explicitly configured server. */
export const bookOrbitFetch: typeof fetch = (input, init) => {
  const desktop = getDesktopFetch();
  if (desktop) return desktop(input, init);
  const configured = import.meta.env.DEV
    ? (import.meta.env.VITE_BOOKORBIT_PROXY_ORIGIN as string | undefined)
    : undefined;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (configured && url.startsWith(`${configured.replace(/\/$/, "")}/api/v1/`))
    return fetch(
      `/bookorbit${new URL(url).pathname}${new URL(url).search}`,
      init,
    );
  return fetch(input, init);
};

export function proxyBaseFor(serverUrl: string): string | undefined {
  if (getDesktopFetch()) return undefined;
  const configured = import.meta.env.DEV
    ? (import.meta.env.VITE_BOOKORBIT_PROXY_ORIGIN as string | undefined)
    : undefined;
  return configured &&
    serverUrl.replace(/\/$/, "") === configured.replace(/\/$/, "")
    ? "/bookorbit"
    : undefined;
}
