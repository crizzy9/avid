import { useEffect, useRef, useState } from "react";
import {
  BookOrbitClient,
  type LoginOptions,
} from "../../../packages/core/src/bookorbit";
import type { Session } from "../../../packages/core/src/types";
import { useI18n } from "../../../packages/i18n/src";
import {
  WebOidcCoordinator,
  configuredWebOidc,
  webOidcCallback,
} from "./webOidc";
import { bookOrbitFetch, proxyBaseFor } from "./Connect";
import { getNativeOidc } from "../../mobile/src/native-oidc";
import { configuredNativeOidc, getConfiguredNativeOidcCoordinator, nativeOidcRedirect } from "./nativeOidcCoordinator";

export function getNativeProviderCoordinator() {
  return getConfiguredNativeOidcCoordinator(url => ({ fetch: bookOrbitFetch, transportBaseUrl: proxyBaseFor(url) }));
}

let coordinator: WebOidcCoordinator | undefined;
function getCoordinator() {
  if (coordinator) return coordinator;
  const deployment = configuredWebOidc();
  if (!deployment)
    throw new Error(
      "Provider sign-in is not configured for this Avid deployment.",
    );
  coordinator = new WebOidcCoordinator({
    deployment,
    storage: sessionStorage,
    pageUrl: () => location.href,
    launch: (url) => location.assign(url),
    clearCallback: () => history.replaceState(null, "", "/"),
    clientOptions: (url) => ({
      fetch: bookOrbitFetch,
      transportBaseUrl: proxyBaseFor(url),
    }),
  });
  return coordinator;
}
export function ProviderSignIn({
  serverUrl,
  readOnly,
  onAttempt,
  onBusyChange,
  disabled = false,
}: {
  serverUrl: string;
  readOnly: boolean;
  onAttempt?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<LoginOptions["oidcProviders"]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentOptions = useRef({ serverUrl, readOnly, disabled });
  const native = getNativeOidc() !== null;
  currentOptions.current = { serverUrl, readOnly, disabled };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setProviders([]);
    setError("");
    setBusy(false);
  }, [serverUrl, readOnly, disabled]);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  if (native ? !configuredNativeOidc() : !configuredWebOidc()) return null;
  async function discover() {
    const current = ++generation.current;
    const active = () =>
      mounted.current &&
      current === generation.current &&
      currentOptions.current.serverUrl === serverUrl &&
      !currentOptions.current.disabled;
    setBusy(true);
    setError("");
    try {
      const url = /^https?:\/\//i.test(serverUrl)
        ? serverUrl
        : `https://${serverUrl}`;
      if (native) nativeOidcRedirect(configuredNativeOidc()!, url);
      else webOidcCallback(configuredWebOidc()!, url, location.href);
      const result = await BookOrbitClient.loginOptions(url, {
        fetch: bookOrbitFetch,
        transportBaseUrl: proxyBaseFor(url),
      });
      if (!active()) return;
      const enabled = result.oidcProviders.filter(provider => provider.enabled && (!native || configuredNativeOidc()!.providers.includes(provider.slug)));
      setProviders(enabled);
      if (!enabled.length)
        setError(t("oidc.none"));
    } catch (err) {
      if (active())
        setError(err instanceof Error ? err.message : t("connect.failed"));
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function begin(provider: string) {
    const current = ++generation.current;
    const active = () =>
      mounted.current &&
      current === generation.current &&
      currentOptions.current.serverUrl === serverUrl &&
      currentOptions.current.readOnly === readOnly &&
      !currentOptions.current.disabled;
    setBusy(true);
    setError("");
    try {
      await onAttempt?.();
      if (!active()) return;
      const url = /^https?:\/\//i.test(serverUrl)
        ? serverUrl
        : `https://${serverUrl}`;
      await (native ? getNativeProviderCoordinator()! : getCoordinator()).begin(
        {
          id: crypto.randomUUID(),
          name: new URL(url).hostname,
          url,
          username: "",
        },
        provider,
        readOnly,
        { isActive: active },
      );
    } catch (err) {
      if (active()) {
        setError(err instanceof Error ? err.message : t("connect.failed"));
        setBusy(false);
      }
    }
  }
  return (
    <div className="provider-signin">
      <button
        type="button"
        className="secondary-button full-width"
        disabled={disabled || busy || !serverUrl.trim()}
        onClick={() => void discover()}
      >
        {t("oidc.discover")}
      </button>
      {providers.map((provider) => (
        <button
          type="button"
          key={provider.slug}
          className="secondary-button full-width"
          disabled={disabled || busy}
          onClick={() => void begin(provider.slug)}
        >
          {t("oidc.continue", { provider: provider.displayName })}
        </button>
      ))}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function ProviderCallback({
  onConnect,
}: {
  onConnect: (session: Session, readOnly: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const [callbackUrl] = useState(() =>
    location.pathname === "/oauth2-callback" ? location.href : null,
  );
  const [error, setError] = useState("");
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!callbackUrl) return;
    let active = true;
    history.replaceState(null, "", "/");
    Promise.resolve()
      .then(() => getCoordinator().complete(callbackUrl))
      .then(async (result) => {
        if (active) {
          await onConnectRef.current(result.session, result.readOnly);
          if (active) setDone(true);
        }
      })
      .catch((err) => {
        if (active)
          setError(err instanceof Error ? err.message : t("connect.failed"));
      });
    return () => {
      active = false;
    };
  }, [callbackUrl]);
  if (!callbackUrl || done) return null;
  return (
    <div
      className={error ? "error-banner" : "connection-banner"}
      role={error ? "alert" : "status"}
    >
      {error || t("oidc.completing")}
    </div>
  );
}
