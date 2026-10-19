import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  PlaybackPreferenceStore,
  playbackPreferenceKeys,
  projectPlaybackPreferences,
  type PlaybackPreferenceKey,
  type PlaybackPreferenceScope,
  type PlaybackPreferenceSource,
  type PlaybackPreferences,
} from "../../../packages/playback/src/preferences";
import { useI18n } from "../../../packages/i18n/src";
import { usePlaybackSettingsI18n } from "./playbackSettingsMessages";
import "./playbackSettings.css";

function PreferenceField({
  setting,
  value,
  source,
  overridden,
  accountScope,
  disabled,
  onChange,
  onReset,
}: {
  setting: PlaybackPreferenceKey;
  value: PlaybackPreferences[PlaybackPreferenceKey];
  source: PlaybackPreferenceSource;
  overridden: boolean;
  accountScope: boolean;
  disabled: boolean;
  onChange: (value: PlaybackPreferences[PlaybackPreferenceKey]) => void;
  onReset: () => void;
}) {
  const text = usePlaybackSettingsI18n();
  const inputId = useId();
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);
  const label = text(setting);
  const sourceLabel = text(source.kind);
  const numeric = setting !== "remoteMode";
  const error = text(setting === "rate" ? "invalidRate" : "invalidSkip");
  return (
    <form
      className="listening-setting"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) return;
        const next = numeric ? Number(draft) : draft;
        const valid = numeric
          ? draft.trim() !== "" &&
            Number.isFinite(next) &&
            (setting === "rate"
              ? Number(next) >= 0.5 && Number(next) <= 3
              : Number.isInteger(next) &&
                Number(next) >= 1 &&
                Number(next) <= 300)
          : next === "time" || next === "chapter";
        setInvalid(!valid);
        if (valid) onChange(next as PlaybackPreferences[PlaybackPreferenceKey]);
      }}
    >
      <label htmlFor={inputId}>{label}</label>
      <div className="listening-setting-controls">
        {numeric ? (
          <input
            id={inputId}
            type="number"
            inputMode="decimal"
            min={setting === "rate" ? 0.5 : 1}
            max={setting === "rate" ? 3 : 300}
            step={setting === "rate" ? 0.05 : 1}
            value={draft}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={`${inputId}-source${invalid ? ` ${inputId}-error` : ""}`}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
          />
        ) : (
          <select
            id={inputId}
            value={draft}
            disabled={disabled}
            aria-describedby={`${inputId}-source`}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
          >
            <option value="time">{text("time")}</option>
            <option value="chapter">{text("chapter")}</option>
          </select>
        )}
        <button
          type="submit"
          className="secondary-button"
          disabled={disabled || (overridden && draft === String(value))}
          aria-label={text("applyField", { setting: label })}
        >
          {text("apply")}
        </button>
      </div>
      <div className="listening-setting-source">
        <small id={`${inputId}-source`}>
          {text("source", { source: sourceLabel })}
        </small>
        <button
          type="button"
          className="text-button"
          disabled={disabled || !overridden}
          aria-label={text("resetField", { setting: label })}
          onClick={() => {
            setDraft(String(value));
            setInvalid(false);
            onReset();
          }}
        >
          {text(accountScope ? "resetDefault" : "reset")}
        </button>
      </div>
      {invalid && (
        <p
          id={`${inputId}-error`}
          role="alert"
          className="listening-setting-error"
        >
          {error}
        </p>
      )}
    </form>
  );
}

export function PlaybackSettings({
  preferences,
  bookId,
  seriesId,
  sessionRate,
  onResetSessionRate,
}: {
  preferences: PlaybackPreferenceStore;
  bookId: string;
  seriesId?: string;
  sessionRate?: number;
  onResetSessionRate?: () => void;
}) {
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
  );
  const { locale } = useI18n();
  const text = usePlaybackSettingsI18n();
  const scopeId = useId();
  const [scopeKind, setScopeKind] = useState<"account" | "book">("book");
  const scope: PlaybackPreferenceScope =
    scopeKind === "account"
      ? { kind: "account" }
      : { kind: "book", id: bookId };
  const context = scopeKind === "account" ? {} : { bookId, seriesId };
  const hasSessionRate =
    scopeKind === "book" &&
    sessionRate !== undefined &&
    Number.isFinite(sessionRate) &&
    sessionRate >= 0.5 &&
    sessionRate <= 3 &&
    preferences.resolve(context).sources.rate.kind === "default";
  const resolved = preferences.resolve(
    context,
    hasSessionRate ? { rate: sessionRate } : {},
  );
  const applied = projectPlaybackPreferences(resolved, {
    minRate: 0.5,
    maxRate: 3,
  });
  const overrides =
    scope.kind === "account"
      ? snapshot.document.account
      : (snapshot.document.books[bookId] ?? {});
  const errorKey =
    snapshot.status === "unsupported-version"
      ? "newerVersion"
      : snapshot.status === "corrupt"
        ? "corrupt"
        : snapshot.status === "memory"
          ? "memory"
          : snapshot.error &&
              ["unavailable", "invalid"].includes(snapshot.migration)
            ? "migration"
            : snapshot.error
              ? "saveError"
              : null;
  const format = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  return (
    <details className="listening-settings">
      <summary>{text("title")}</summary>
      <p className="listening-settings-hint">{text("hint")}</p>
      <div className="listening-settings-scope">
        <label htmlFor={scopeId}>{text("scope")}</label>
        <select
          id={scopeId}
          value={scopeKind}
          onChange={(event) =>
            setScopeKind(event.target.value as "account" | "book")
          }
        >
          <option value="book">{text("book")}</option>
          <option value="account">{text("account")}</option>
        </select>
      </div>
      {applied.rateLimited && (
        <p role="status" className="listening-settings-hint">
          {text("rateLimited", {
            requested: format(applied.requested.rate),
            applied: format(applied.values.rate),
          })}
        </p>
      )}
      {errorKey && (
        <p role="alert" className="listening-setting-error">
          {text(errorKey)}
        </p>
      )}
      {playbackPreferenceKeys.map((setting) => (
        <PreferenceField
          key={`${preferences.accountId}:${scopeKind}:${bookId}:${setting}`}
          setting={setting}
          value={resolved.values[setting]}
          source={resolved.sources[setting]}
          overridden={
            Object.prototype.hasOwnProperty.call(overrides, setting) ||
            (setting === "rate" && hasSessionRate)
          }
          accountScope={scopeKind === "account"}
          disabled={snapshot.status === "unsupported-version"}
          onChange={(value) => {
            preferences.set(scope, { [setting]: value });
          }}
          onReset={() => {
            if (setting === "rate" && hasSessionRate) onResetSessionRate?.();
            else preferences.reset(scope, setting);
          }}
        />
      ))}
    </details>
  );
}
