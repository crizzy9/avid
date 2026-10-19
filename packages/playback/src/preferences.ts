/** Listening preferences are client settings, not a media library or an offline sync queue. */
export interface PlaybackPreferences {
  rate: number;
  skipBackwardSeconds: number;
  skipForwardSeconds: number;
  remoteMode: "time" | "chapter";
}

export type PlaybackPreferenceKey = keyof PlaybackPreferences;
export type PlaybackPreferencePatch = Partial<PlaybackPreferences>;
export type PlaybackPreferenceScope =
  { kind: "account" } | { kind: "library" | "series" | "book"; id: string };
export interface PlaybackPreferenceContext {
  libraryId?: string;
  seriesId?: string;
  bookId?: string;
}
export type PlaybackPreferenceSource =
  PlaybackPreferenceScope | { kind: "default" | "session" };
export interface ResolvedPlaybackPreferences {
  values: PlaybackPreferences;
  sources: Record<PlaybackPreferenceKey, PlaybackPreferenceSource>;
}

export const defaultPlaybackPreferences: Readonly<PlaybackPreferences> =
  Object.freeze({
    rate: 1,
    skipBackwardSeconds: 15,
    skipForwardSeconds: 30,
    remoteMode: "time",
  });
export const playbackPreferenceKeys: readonly PlaybackPreferenceKey[] =
  Object.freeze([
    "rate",
    "skipBackwardSeconds",
    "skipForwardSeconds",
    "remoteMode",
  ]);
export const playbackPreferencesFormat = "avid.playback-preferences";
export const playbackPreferencesVersion = 1;
export const legacyPlaybackPreferenceKey = "avid.audio.remote-policy.v1";
export const legacyPlaybackPreferenceClaimKey =
  "avid.audio.remote-policy.claim.v1";
export const playbackPreferenceStorageKey = (accountId: string): string =>
  `${playbackPreferencesFormat}.v1:${encodeURIComponent(accountId)}`;

type ScopeValues = Record<string, PlaybackPreferencePatch>;
interface PreferenceData {
  account: PlaybackPreferencePatch;
  libraries: ScopeValues;
  series: ScopeValues;
  books: ScopeValues;
}
export interface PlaybackPreferenceDocument extends PreferenceData {
  format: typeof playbackPreferencesFormat;
  version: typeof playbackPreferencesVersion;
  accountId: string;
}
export type PlaybackPreferenceStorageStatus =
  "ready" | "memory" | "corrupt" | "unsupported-version";
export type PlaybackPreferenceMigrationStatus =
  | "unchecked"
  | "absent"
  | "migrated"
  | "claimed-elsewhere"
  | "unavailable"
  | "invalid";
export interface PlaybackPreferenceSnapshot {
  /** Immutable snapshot, stable until a change; usable with useSyncExternalStore. */
  document: Readonly<PlaybackPreferenceDocument>;
  status: PlaybackPreferenceStorageStatus;
  error: string | null;
  migration: PlaybackPreferenceMigrationStatus;
}
export type PlaybackPreferenceStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
export interface PlaybackPreferenceStoreOptions {
  /** Tests/hosts can provide an exclusive cross-context lock. Undefined uses Web Locks.
   * A host without an exclusive lock skips automatic migration rather than copying
   * an unscoped preference into multiple accounts. */
  withMigrationLock?: <T>(work: () => Promise<T>) => Promise<T>;
}

const MAX_BYTES = 256 * 1024;
const MAX_SCOPES = 1000;
const own = (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const emptyScopes = (): ScopeValues => Object.create(null) as ScopeValues;
const emptyData = (): PreferenceData => ({
  account: {},
  libraries: emptyScopes(),
  series: emptyScopes(),
  books: emptyScopes(),
});
const emptyDocument = (accountId: string): PlaybackPreferenceDocument => ({
  format: playbackPreferencesFormat,
  version: playbackPreferencesVersion,
  accountId,
  ...emptyData(),
});

function validValue(key: PlaybackPreferenceKey, value: unknown): boolean {
  if (key === "remoteMode") return value === "time" || value === "chapter";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (key === "rate") return value >= 0.5 && value <= 5;
  return Number.isInteger(value) && value >= 1 && value <= 300;
}

/** Strict for imports/edits: unknown fields never become future behavior or secrets. */
export function validatePlaybackPreferencePatch(
  value: unknown,
): PlaybackPreferencePatch | null {
  if (!record(value) || !exactKeys(value, playbackPreferenceKeys)) return null;
  const patch: PlaybackPreferencePatch = {};
  for (const key of playbackPreferenceKeys) {
    if (!own(value, key)) continue;
    if (!validValue(key, value[key])) return null;
    Object.assign(patch, { [key]: value[key] });
  }
  return patch;
}

function parseScopes(value: unknown): ScopeValues | null {
  if (!record(value) || Object.keys(value).length > MAX_SCOPES) return null;
  const result = emptyScopes();
  for (const [id, raw] of Object.entries(value)) {
    const patch = validatePlaybackPreferencePatch(raw);
    if (!validId(id) || !patch) return null;
    if (Object.keys(patch).length) result[id] = patch;
  }
  return result;
}

function parseData(value: Record<string, unknown>): PreferenceData | null {
  const account = validatePlaybackPreferencePatch(value.account);
  const libraries = parseScopes(value.libraries);
  const series = parseScopes(value.series);
  const books = parseScopes(value.books);
  return account && libraries && series && books
    ? { account, libraries, series, books }
    : null;
}

function parseDocument(
  value: unknown,
  accountId: string,
): PlaybackPreferenceDocument | null {
  if (
    !record(value) ||
    !exactKeys(value, [
      "format",
      "version",
      "accountId",
      "account",
      "libraries",
      "series",
      "books",
    ]) ||
    value.format !== playbackPreferencesFormat ||
    value.version !== 1 ||
    value.accountId !== accountId
  )
    return null;
  const data = parseData(value);
  return data
    ? { format: playbackPreferencesFormat, version: 1, accountId, ...data }
    : null;
}

function cloneDocument(
  document: Readonly<PlaybackPreferenceDocument>,
): PlaybackPreferenceDocument {
  return parseDocument(
    JSON.parse(JSON.stringify(document)),
    document.accountId,
  )!;
}

function freezeDocument(
  document: PlaybackPreferenceDocument,
): Readonly<PlaybackPreferenceDocument> {
  Object.freeze(document.account);
  for (const group of [document.libraries, document.series, document.books]) {
    for (const patch of Object.values(group)) Object.freeze(patch);
    Object.freeze(group);
  }
  return Object.freeze(document);
}

function groupFor(
  document: PlaybackPreferenceDocument,
  scope: Exclude<PlaybackPreferenceScope, { kind: "account" }>,
): ScopeValues {
  return scope.kind === "library"
    ? document.libraries
    : scope.kind === "series"
      ? document.series
      : document.books;
}

/** Project into the current engine's verified range without changing the user's
 * requested setting. DSP, pitch toggles and future options are deliberately absent. */
export function projectPlaybackPreferences(
  resolved: ResolvedPlaybackPreferences,
  capability: { minRate: number; maxRate: number } = {
    minRate: 0.5,
    maxRate: 3,
  },
): ResolvedPlaybackPreferences & {
  requested: PlaybackPreferences;
  rateLimited: boolean;
} {
  const valid =
    Number.isFinite(capability.minRate) &&
    Number.isFinite(capability.maxRate) &&
    capability.minRate >= 0.5 &&
    capability.maxRate <= 5 &&
    capability.minRate <= capability.maxRate;
  const min = valid ? capability.minRate : 0.5;
  const max = valid ? capability.maxRate : 3;
  const rate = Math.min(max, Math.max(min, resolved.values.rate));
  return {
    values: { ...resolved.values, rate },
    requested: { ...resolved.values },
    rateLimited: rate !== resolved.values.rate,
    sources: { ...resolved.sources },
  };
}

interface MigrationClaim {
  version: 1;
  accountId: string;
  state: "pending" | "complete";
  preferences: PlaybackPreferencePatch;
}

function parseClaim(raw: string): MigrationClaim | null {
  if (raw.length > 8192) return null;
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    !exactKeys(value, ["version", "accountId", "state", "preferences"]) ||
    value.version !== 1 ||
    !validId(value.accountId) ||
    !["pending", "complete"].includes(String(value.state))
  )
    return null;
  const preferences = validatePlaybackPreferencePatch(value.preferences);
  return preferences
    ? {
        version: 1,
        accountId: value.accountId,
        state: value.state as MigrationClaim["state"],
        preferences,
      }
    : null;
}

function webMigrationLock<T>(work: () => Promise<T>): Promise<T> | null {
  if (typeof navigator === "undefined" || !navigator.locks?.request)
    return null;
  // DOM's callback generic does not model promise assimilation; await it here.
  return (async () =>
    await navigator.locks.request(
      legacyPlaybackPreferenceClaimKey,
      { mode: "exclusive" },
      work,
    ))();
}

export class PlaybackPreferenceStore {
  private snapshot: PlaybackPreferenceSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly identityValid: boolean;
  private migrationJob: Promise<PlaybackPreferenceSnapshot> | null = null;

  constructor(
    readonly accountId: string,
    private readonly storage?: PlaybackPreferenceStorage,
    private readonly options: PlaybackPreferenceStoreOptions = {},
  ) {
    this.identityValid = validId(accountId);
    this.snapshot = Object.freeze({
      document: freezeDocument(emptyDocument(accountId)),
      status: storage ? "ready" : "memory",
      error: storage
        ? null
        : "Listening settings are temporary because storage is unavailable.",
      migration: "unchecked",
    });
    this.reload();
  }

  getSnapshot = (): PlaybackPreferenceSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(change: Partial<PlaybackPreferenceSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of this.listeners) listener();
  }

  /** Can be called on a storage event. Does not write or claim legacy preferences. */
  reload = (): PlaybackPreferenceSnapshot => {
    if (!this.identityValid) {
      this.publish({
        status: "memory",
        error: "An account identity is required to save listening settings.",
      });
      return this.snapshot;
    }
    if (!this.storage) return this.snapshot;
    try {
      const raw = this.storage.getItem(
        playbackPreferenceStorageKey(this.accountId),
      );
      if (raw === null) {
        this.publish({
          document: freezeDocument(emptyDocument(this.accountId)),
          status: "ready",
          error: null,
        });
        return this.snapshot;
      }
      if (raw.length > MAX_BYTES) throw new Error("oversized");
      const value: unknown = JSON.parse(raw);
      if (
        record(value) &&
        value.format === playbackPreferencesFormat &&
        value.accountId === this.accountId &&
        typeof value.version === "number" &&
        value.version > 1
      ) {
        this.publish({
          status: "unsupported-version",
          error:
            "These listening settings were saved by a newer Avid version and have been left unchanged.",
        });
        return this.snapshot;
      }
      const document = parseDocument(value, this.accountId);
      if (!document) throw new Error("invalid");
      this.publish({
        document: freezeDocument(document),
        status: "ready",
        error: null,
      });
    } catch {
      // Never expose raw storage, which can contain untrusted/accidentally secret data.
      this.publish({
        status: "corrupt",
        error:
          "Saved listening settings could not be read. Defaults are available; saving a change will replace the unreadable settings.",
      });
    }
    return this.snapshot;
  };

  resolve(
    context: PlaybackPreferenceContext = {},
    session: PlaybackPreferencePatch = {},
  ): ResolvedPlaybackPreferences {
    const values = { ...defaultPlaybackPreferences };
    const sources = Object.fromEntries(
      playbackPreferenceKeys.map((key) => [key, { kind: "default" }]),
    ) as ResolvedPlaybackPreferences["sources"];
    const apply = (
      patch: PlaybackPreferencePatch | undefined,
      source: PlaybackPreferenceSource,
    ) => {
      if (!patch) return;
      for (const key of playbackPreferenceKeys)
        if (own(patch, key)) {
          Object.assign(values, { [key]: patch[key] });
          sources[key] = source;
        }
    };
    const document = this.snapshot.document;
    apply(document.account, { kind: "account" });
    for (const [kind, id, group] of [
      ["library", context.libraryId, document.libraries],
      ["series", context.seriesId, document.series],
      ["book", context.bookId, document.books],
    ] as const)
      if (validId(id) && own(group, id)) apply(group[id], { kind, id });
    apply(validatePlaybackPreferencePatch(session) ?? undefined, {
      kind: "session",
    });
    return { values, sources };
  }

  private save(document: PlaybackPreferenceDocument): boolean {
    if (this.snapshot.status === "unsupported-version") return false;
    if (!this.identityValid) return false;
    const serialized = JSON.stringify(document);
    if (serialized.length > MAX_BYTES) {
      this.publish({
        error:
          "There are too many listening overrides to save. Remove some overrides before adding more.",
      });
      return false;
    }
    let persisted = false;
    try {
      this.storage?.setItem(
        playbackPreferenceStorageKey(this.accountId),
        serialized,
      );
      persisted =
        !!this.storage &&
        this.storage.getItem(playbackPreferenceStorageKey(this.accountId)) ===
          serialized;
    } catch {
      /* Retain the explicitly chosen setting for this session. */
    }
    this.publish({
      document: freezeDocument(document),
      status: persisted ? "ready" : "memory",
      error: persisted
        ? null
        : "Listening settings apply to this session but could not be saved on this device.",
    });
    return persisted;
  }

  set(scope: PlaybackPreferenceScope, value: PlaybackPreferencePatch): boolean {
    const patch = validatePlaybackPreferencePatch(value);
    if (!patch || !this.validScope(scope)) {
      this.publish({
        error:
          "Listening settings are invalid. Speed must be 0.5–5× and skips must be whole seconds from 1–300.",
      });
      return false;
    }
    const document = cloneDocument(this.snapshot.document);
    if (scope.kind === "account")
      document.account = { ...document.account, ...patch };
    else {
      const group = groupFor(document, scope);
      if (!own(group, scope.id) && Object.keys(group).length >= MAX_SCOPES) {
        this.publish({
          error:
            "There are too many listening overrides. Remove an override before adding another.",
        });
        return false;
      }
      const result = {
        ...(own(group, scope.id) ? group[scope.id] : {}),
        ...patch,
      };
      if (Object.keys(result).length) group[scope.id] = result;
    }
    return this.save(document);
  }

  private validScope(scope: PlaybackPreferenceScope): boolean {
    return (
      !!scope &&
      (scope.kind === "account" ||
        (["library", "series", "book"].includes(scope.kind) &&
          validId(scope.id)))
    );
  }

  /** Removes an override. Inheritance is restored; defaults are never copied into it. */
  reset(scope: PlaybackPreferenceScope, key?: PlaybackPreferenceKey): boolean {
    if (
      !this.validScope(scope) ||
      (key !== undefined && !playbackPreferenceKeys.includes(key))
    ) {
      this.publish({ error: "The listening setting to reset is invalid." });
      return false;
    }
    const document = cloneDocument(this.snapshot.document);
    if (scope.kind === "account") {
      if (key) delete document.account[key];
      else document.account = {};
    } else {
      const group = groupFor(document, scope);
      if (own(group, scope.id)) {
        if (key) delete group[scope.id]![key];
        if (!key || !Object.keys(group[scope.id]!).length)
          delete group[scope.id];
      }
    }
    return this.save(document);
  }

  resetAll(): boolean {
    return this.save(emptyDocument(this.accountId));
  }

  /** No account identity, connection, credential, media, annotation or history data. */
  exportSettings(): string {
    const { account, libraries, series, books } = this.snapshot.document;
    return JSON.stringify(
      {
        format: "avid.playback-preferences-export",
        version: 1,
        preferences: { account, libraries, series, books },
      },
      null,
      2,
    );
  }

  /** Replaces this account's preferences only after the entire import validates. */
  importSettings(json: string): boolean {
    try {
      if (typeof json !== "string" || json.length > MAX_BYTES)
        throw new Error("oversized");
      const value: unknown = JSON.parse(json);
      if (
        !record(value) ||
        !exactKeys(value, ["format", "version", "preferences"]) ||
        value.format !== "avid.playback-preferences-export" ||
        value.version !== 1 ||
        !record(value.preferences) ||
        !exactKeys(value.preferences, [
          "account",
          "libraries",
          "series",
          "books",
        ])
      )
        throw new Error("invalid");
      const data = parseData(value.preferences);
      if (!data) throw new Error("invalid");
      return this.save({
        format: playbackPreferencesFormat,
        version: 1,
        accountId: this.accountId,
        ...data,
      });
    } catch {
      this.publish({
        error:
          "This is not a valid Avid listening-settings export. Existing settings have been left unchanged.",
      });
      return false;
    }
  }

  /** Explicit asynchronous first-account claim, protected across tabs/WebViews by
   * an exclusive lock. The durable pending receipt makes interrupted migration
   * retryable; account reset never reimports a completed legacy value. */
  migrateLegacyRemotePolicy(
    isActive: () => boolean = () => true,
  ): Promise<PlaybackPreferenceSnapshot> {
    if (this.migrationJob) return this.migrationJob;
    const run = async (): Promise<PlaybackPreferenceSnapshot> => {
      if (!isActive()) return this.snapshot;
      if (
        !this.storage ||
        !this.identityValid ||
        this.snapshot.status === "unsupported-version" ||
        this.snapshot.status === "corrupt"
      ) {
        this.publish({ migration: "unavailable" });
        return this.snapshot;
      }
      try {
        if (
          this.storage.getItem(legacyPlaybackPreferenceKey) === null &&
          this.storage.getItem(legacyPlaybackPreferenceClaimKey) === null
        ) {
          this.publish({ migration: "absent" });
          return this.snapshot;
        }
      } catch {
        this.publish({
          migration: "unavailable",
          error: "Previous skip settings could not be read on this device.",
        });
        return this.snapshot;
      }
      const work = async (): Promise<PlaybackPreferenceSnapshot> => {
        if (!isActive()) return this.snapshot;
        try {
          const claimRaw = this.storage!.getItem(
            legacyPlaybackPreferenceClaimKey,
          );
          let claim = claimRaw === null ? null : parseClaim(claimRaw);
          if (claimRaw !== null && !claim) {
            this.publish({
              migration: "invalid",
              error:
                "The previous listening-setting migration could not be verified. Legacy settings were left unchanged.",
            });
            return this.snapshot;
          }
          if (claim && claim.accountId !== this.accountId) {
            this.publish({ migration: "claimed-elsewhere" });
            return this.snapshot;
          }
          if (claim?.state === "complete") {
            this.publish({ migration: "migrated" });
            return this.snapshot;
          }
          if (!claim) {
            const raw = this.storage!.getItem(legacyPlaybackPreferenceKey);
            if (raw === null) {
              this.publish({ migration: "absent" });
              return this.snapshot;
            }
            if (raw.length > 8192) throw new Error("invalid legacy policy");
            const legacy: unknown = JSON.parse(raw);
            if (
              !record(legacy) ||
              (legacy.mode !== "time" && legacy.mode !== "chapter") ||
              typeof legacy.seconds !== "number" ||
              !Number.isFinite(legacy.seconds)
            ) {
              this.publish({
                migration: "invalid",
                error:
                  "Previous skip settings were unreadable and were not imported.",
              });
              return this.snapshot;
            }
            // Preserve the old controller's 5–120 second normalization exactly.
            const seconds = Math.max(
              5,
              Math.min(120, Math.round(legacy.seconds)),
            );
            claim = {
              version: 1,
              accountId: this.accountId,
              state: "pending",
              preferences: {
                remoteMode: legacy.mode,
                skipBackwardSeconds: seconds,
                skipForwardSeconds: seconds,
              },
            };
            const serialized = JSON.stringify(claim);
            this.storage!.setItem(legacyPlaybackPreferenceClaimKey, serialized);
            if (
              this.storage!.getItem(legacyPlaybackPreferenceClaimKey) !==
              serialized
            )
              throw new Error("claim not saved");
          }
          // Refresh before merging to preserve another view's existing account choices.
          this.reload();
          if (
            this.snapshot.status === "unsupported-version" ||
            this.snapshot.status === "corrupt"
          ) {
            this.publish({ migration: "unavailable" });
            return this.snapshot;
          }
          const document = cloneDocument(this.snapshot.document);
          document.account = { ...claim.preferences, ...document.account };
          if (!this.save(document)) {
            this.publish({ migration: "unavailable" });
            return this.snapshot;
          }
          const receipt = JSON.stringify({ ...claim, state: "complete" });
          this.storage!.setItem(legacyPlaybackPreferenceClaimKey, receipt);
          if (
            this.storage!.getItem(legacyPlaybackPreferenceClaimKey) !== receipt
          )
            throw new Error("receipt not saved");
          this.publish({ migration: "migrated" });
          // The receipt, not deletion of the legacy key, is the isolation guard.
          try {
            this.storage!.removeItem(legacyPlaybackPreferenceKey);
          } catch {
            /* Receipt remains authoritative. */
          }
        } catch {
          this.publish({
            migration: "unavailable",
            error:
              "Previous skip settings could not be safely migrated. No other account will inherit this account's listening settings.",
          });
        }
        return this.snapshot;
      };
      try {
        const locked = this.options.withMigrationLock
          ? this.options.withMigrationLock(work)
          : webMigrationLock(work);
        if (locked) return await locked;
        this.publish({
          migration: "unavailable",
          error:
            "Automatic import of previous skip settings is unavailable in this browser. New listening settings remain account-specific.",
        });
      } catch {
        this.publish({
          migration: "unavailable",
          error: "Previous skip settings could not be safely migrated.",
        });
      }
      return this.snapshot;
    };
    this.migrationJob = run().finally(() => {
      this.migrationJob = null;
    });
    return this.migrationJob;
  }
}
