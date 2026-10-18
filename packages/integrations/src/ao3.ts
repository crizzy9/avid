import { z } from "zod";
import {
  captureAo3WorkSkin,
  restoreAo3WorkSkin,
  type Ao3WorkSkin,
} from "./ao3WorkSkin";

export const AO3_ORIGIN = "https://archiveofourown.org";
export interface Ao3FollowedWork {
  workId: string;
  title: string;
  author: string;
}
export interface Ao3Chapter {
  id: string;
  title: string;
  revision: string;
}
export interface Ao3WorkEdition extends Ao3FollowedWork {
  accountId: string;
  revision: string;
  chapters: Ao3Chapter[];
  chapterIds: string[];
  epubPath: string;
  checkedAt: string;
  /** Ephemeral authenticated source formatting; never stored in follow metadata. */
  workSkin?: Ao3WorkSkin;
}
export interface Ao3Import {
  accountId: string;
  workId: string;
  title: string;
  author: string;
  revision: string;
  chapterIds: string[];
  file: File;
}
export interface Ao3SubscriptionPage {
  works: Ao3FollowedWork[];
  nextPage?: number;
  unavailable: number;
}
export class Ao3Error extends Error {
  status: number;
  retryAfter?: number;
  constructor(message: string, status = 0, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
const numericId = (id: string) => {
  if (!/^[1-9]\d{0,19}$/.test(id))
    throw new Ao3Error("Invalid AO3 work identity.");
  return id;
};
function documentFor(html: string): DocumentFragment {
  if (html.length > 8 * 1024 * 1024)
    throw new Ao3Error("This AO3 page exceeds the connector size limit.");
  // Template contents remain inert, including image/iframe resources. Never
  // attach imported page nodes to Avid's active document.
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}
const text = (element: Element | null) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
function linkPath(href: string): string {
  const url = new URL(href, AO3_ORIGIN);
  if (url.origin !== AO3_ORIGIN || url.username || url.password)
    throw new Ao3Error("AO3 link points outside the supported archive.");
  return `${url.pathname}${url.search}`;
}
function assertAccount(doc: DocumentFragment, username: string) {
  const identities = [...doc.querySelectorAll("#greeting a[href]")]
    .map((link) => new URL(link.getAttribute("href")!, AO3_ORIGIN))
    .filter(
      (url) =>
        url.origin === AO3_ORIGIN && /^\/users\/[^/]+$/.test(url.pathname),
    )
    .map((url) => decodeURIComponent(url.pathname.slice(7)));
  if (!identities.includes(username))
    throw new Ao3Error(
      "AO3 session expired or changed account. Connect again.",
      401,
    );
}
export function parseAo3Subscriptions(
  html: string,
  username: string,
  page = 1,
): Ao3SubscriptionPage {
  const doc = documentFor(html);
  assertAccount(doc, username);
  const list = doc.querySelector("dl.subscription.index");
  if (!list)
    throw new Ao3Error(
      "AO3’s subscriptions page has changed or is unavailable. No followed works were replaced.",
    );
  const works = new Map<string, Ao3FollowedWork>();
  let unavailable = 0;
  for (const row of list.querySelectorAll(":scope > dt")) {
    const link = [...row.querySelectorAll("a[href]")].find((value) =>
      /^\/works\/[1-9]\d*$/.test(
        new URL(value.getAttribute("href")!, AO3_ORIGIN).pathname,
      ),
    );
    if (!link) {
      unavailable++;
      continue;
    }
    const path = linkPath(link.getAttribute("href")!);
    const id = /^\/works\/([1-9]\d*)$/.exec(path)?.[1];
    if (!id) throw new Ao3Error("Unexpected AO3 followed-work link.");
    works.set(id, {
      workId: id,
      title: text(link),
      author: [...row.querySelectorAll('a[rel="author"]')].map(text).join(", "),
    });
  }
  const next = doc.querySelector(
    '.pagination a.next_page, .pagination a[rel="next"]',
  );
  let nextPage: number | undefined;
  if (next) {
    const url = new URL(linkPath(next.getAttribute("href")!), AO3_ORIGIN);
    const value = Number(url.searchParams.get("page"));
    if (
      url.pathname !== `/users/${encodeURIComponent(username)}/subscriptions` ||
      url.searchParams.get("type") !== "works" ||
      value !== page + 1 ||
      value > 1000
    )
      throw new Ao3Error("Unexpected AO3 subscriptions pagination.");
    nextPage = value;
  }
  return { works: [...works.values()], nextPage, unavailable };
}
export function parseAo3ChapterIndex(
  html: string,
  username: string,
  workId: string,
): { id: string; title: string }[] {
  const doc = documentFor(html);
  assertAccount(doc, username);
  const list = doc.querySelector("ol.chapter.index");
  if (!list)
    throw new Ao3Error(
      "AO3’s chapter index is unavailable. Existing editions were retained.",
    );
  const chapters = [...list.querySelectorAll("li > a[href]")].map((link) => {
    const path = linkPath(link.getAttribute("href")!);
    const match = new RegExp(
      `^/works/${numericId(workId)}/chapters/([1-9]\\d*)$`,
    ).exec(path);
    if (!match)
      throw new Ao3Error(
        "AO3 returned a chapter belonging to a different work.",
      );
    return { id: match[1], title: text(link) };
  });
  if (
    !chapters.length ||
    chapters.length > 2000 ||
    new Set(chapters.map((chapter) => chapter.id)).size !== chapters.length
  )
    throw new Ao3Error(
      "AO3 chapter identities are missing, duplicated, or exceed the connector limit.",
    );
  return chapters;
}
async function hash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function parseAo3Edition(
  html: string,
  username: string,
  workId: string,
  index: { id: string; title: string }[],
): Promise<Ao3WorkEdition> {
  const doc = documentFor(html);
  assertAccount(doc, username);
  const title = text(
    doc.querySelector(
      "#workskin > .preface h2.title, #workskin .preface h2.title",
    ),
  );
  if (!title)
    throw new Ao3Error(
      "AO3 did not display this work. Its visibility or content preferences may require attention on AO3.",
    );
  const author =
    [...doc.querySelectorAll('#workskin > .preface h3.byline [rel="author"]')]
      .map(text)
      .join(", ") || text(doc.querySelector("#workskin > .preface h3.byline"));
  const chapterElements = [...doc.querySelectorAll("#chapters > .chapter")];
  const content = chapterElements.length
    ? chapterElements.map((chapter) =>
        chapter.querySelector('.userstuff[role="article"]'),
      )
    : [doc.querySelector("#chapters > .userstuff")];
  if (content.length !== index.length || content.some((element) => !element))
    throw new Ao3Error(
      "AO3 chapter content changed while checking. Retry; the previous edition is unchanged.",
    );
  const chapters: Ao3Chapter[] = [];
  for (let i = 0; i < index.length; i++) {
    const actual = chapterElements[i]
      ?.querySelector("h3.title a[href]")
      ?.getAttribute("href");
    if (
      actual &&
      linkPath(actual) !== `/works/${workId}/chapters/${index[i].id}`
    )
      throw new Ao3Error(
        "AO3 chapter order changed while checking. Retry before importing.",
      );
    chapters.push({
      ...index[i],
      revision: await hash(content[i]!.innerHTML.replace(/\r\n/g, "\n").trim()),
    });
  }
  const download = [...doc.querySelectorAll("li.download a[href]")]
    .map((link) => linkPath(link.getAttribute("href")!))
    .find((path) =>
      new RegExp(`^/downloads/${numericId(workId)}/[^/]+\\.epub(?:\\?|$)`).test(
        path,
      ),
    );
  if (!download)
    throw new Ao3Error(
      "AO3 does not currently offer an EPUB download for this work.",
    );
  let workSkin: Ao3WorkSkin | undefined;
  try {
    workSkin = captureAo3WorkSkin(
      doc,
      content.map((element, i) => ({ id: index[i].id, element: element! })),
    );
  } catch (error) {
    throw new Ao3Error(`AO3 formatting restoration failed. ${error instanceof Error ? error.message : "Cannot read the work skin."}`);
  }
  return {
    accountId: username,
    workId,
    title,
    author,
    chapters,
    chapterIds: chapters.map((chapter) => chapter.id),
    epubPath: download,
    // No-skin editions keep their historical revision, so existing imports are not duplicated.
    // Styling adds an immutable rendition identity; prior unstyled file/CFI identities survive.
    revision: await hash(
      JSON.stringify([
        workId,
        title,
        author,
        chapters,
        ...(workSkin
          ? [
              {
                workSkinVersion: workSkin.version,
                css: workSkin.css,
                classNames: workSkin.chapters.map(
                  (chapter) => chapter.className,
                ),
              },
            ]
          : []),
      ]),
    ),
    checkedAt: new Date().toISOString(),
    ...(workSkin ? { workSkin } : {}),
  };
}
const pageSchema = z.object({ url: z.string().url(), html: z.string() });
const sessionSchema = z.object({
  username: z.string().min(1),
  sessionId: z.string().min(32),
});
export function normalizeAo3CompanionAddress(address: string): string {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Ao3Error(
      "Use a local HTTP companion or a configured HTTPS companion origin.",
    );
  }
  const local =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    Boolean(url.port);
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port === "0" ||
    ![url.origin, `${url.origin}/`].includes(address.trim())
  )
    throw new Ao3Error(
      "Use a local HTTP companion or a configured HTTPS companion origin.",
    );
  return url.origin;
}
function companionFetch(): typeof fetch {
  // Capacitor's generic HTTP patch does not preserve redirect:'error' or AbortSignal for POST.
  // HTTPS deployment provides CORS, so the original WebView fetch is the correct credential boundary.
  const runtime = globalThis as typeof globalThis & {
    CapacitorWebFetch?: typeof fetch;
    Capacitor?: { isNativePlatform?: () => boolean };
  };
  if (runtime.CapacitorWebFetch)
    return runtime.CapacitorWebFetch.bind(globalThis);
  if (runtime.Capacitor?.isNativePlatform?.())
    throw new Ao3Error(
      "The native web transport is unavailable. Reopen Avid before connecting.",
    );
  return globalThis.fetch.bind(globalThis);
}
/** Explicit loopback or HTTPS companion; credentials stay in request bodies/headers, never URLs. */
export class Ao3Client {
  private base: string;
  private pairing: string;
  private transport: typeof fetch;
  private timeout: number;
  private session: { username: string; sessionId: string } | null = null;
  constructor(
    address: string,
    pairingCode: string,
    options: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.base = normalizeAo3CompanionAddress(address);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(pairingCode.trim()))
      throw new Ao3Error(
        "Enter the pairing code configured for your companion.",
      );
    this.pairing = pairingCode.trim();
    this.transport = options.fetch ?? companionFetch();
    this.timeout = Math.max(
      1000,
      Math.min(120_000, options.timeoutMs ?? 60_000),
    );
  }
  get accountId() {
    return this.session?.username ?? null;
  }
  private async request(
    path: string,
    init: RequestInit = {},
    session = this.session,
  ): Promise<Response> {
    const abort = new AbortController(),
      cancel = () => abort.abort(init.signal?.reason);
    if (init.signal?.aborted) cancel();
    else init.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () =>
        abort.abort(
          new DOMException("Companion request timed out.", "TimeoutError"),
        ),
      this.timeout,
    );
    let rejectAbort: (() => void) | undefined,
      reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => {
        void reader?.cancel().catch(() => {});
        reject(
          abort.signal.reason ??
            new DOMException("Request cancelled.", "AbortError"),
        );
      };
      if (abort.signal.aborted) rejectAbort();
      else abort.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    void cancelled.catch(() => {});
    try {
      abort.signal.throwIfAborted();
      const pending = this.transport(`${this.base}${path}`, {
        ...init,
        signal: abort.signal,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: {
          Authorization: `Bearer ${this.pairing}`,
          ...(session ? { "X-Avid-AO3-Session": session.sessionId } : {}),
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      void pending
        .then((response) => {
          if (abort.signal.aborted)
            void response.body?.cancel().catch(() => {});
        })
        .catch(() => {});
      const response = await Promise.race([pending, cancelled]);
      reader = response.body?.getReader();
      const maximum = !response.ok
        ? 64 * 1024
        : path.startsWith("/v1/epub?")
          ? 64 * 1024 * 1024
          : 18 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > maximum)
        throw new Ao3Error(
          "The companion response exceeds the supported size limit.",
        );
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const result = await Promise.race([reader.read(), cancelled]);
          abort.signal.throwIfAborted();
          if (result.done) break;
          size += result.value.length;
          if (size > maximum)
            throw new Ao3Error(
              "The companion response exceeds the supported size limit.",
            );
          parts.push(result.value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const buffered = new Response(
        [204, 205, 304].includes(response.status) ? null : bytes,
        { status: response.status, headers: response.headers },
      );
      if (!response.ok) {
        let message = "The AO3 companion request failed.";
        try {
          const data = await buffered.json();
          if (typeof data.message === "string") message = data.message;
        } catch {
          /* No upstream HTML is rendered as an error. */
        }
        if (response.status === 401 && session === this.session)
          this.session = null;
        throw new Ao3Error(
          message,
          response.status,
          Number(response.headers.get("retry-after")) || undefined,
        );
      }
      return buffered;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", cancel);
      if (rejectAbort) abort.signal.removeEventListener("abort", rejectAbort);
      void reader?.cancel().catch(() => {});
    }
  }
  async connect(
    login: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      "/v1/session",
      { method: "POST", body: JSON.stringify({ login, password }), signal },
      null,
    );
    this.session = sessionSchema.parse(await response.json());
    if (signal?.aborted) {
      await this.disconnect();
      throw new DOMException("Connection cancelled.", "AbortError");
    }
    return this.session.username;
  }
  async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session)
      await this.request("/v1/session", { method: "DELETE" }, session);
  }
  private async page(path: string, signal?: AbortSignal): Promise<string> {
    if (!this.session)
      throw new Ao3Error("Connect your AO3 account first.", 401);
    const response = await this.request(
      `/v1/page?path=${encodeURIComponent(path)}`,
      { signal },
    );
    const page = pageSchema.parse(await response.json());
    if (new URL(page.url).origin !== AO3_ORIGIN)
      throw new Ao3Error("Unexpected archive response origin.");
    return page.html;
  }
  async subscriptions(
    page = 1,
    signal?: AbortSignal,
  ): Promise<Ao3SubscriptionPage> {
    const account = this.accountId;
    if (!account) throw new Ao3Error("Connect your AO3 account first.", 401);
    if (!Number.isInteger(page) || page < 1 || page > 1000)
      throw new Ao3Error("Subscriptions page is out of bounds.");
    return parseAo3Subscriptions(
      await this.page(
        `/users/${encodeURIComponent(account)}/subscriptions?type=works&page=${page}`,
        signal,
      ),
      account,
      page,
    );
  }
  async edition(workId: string, signal?: AbortSignal): Promise<Ao3WorkEdition> {
    const account = this.accountId;
    if (!account) throw new Ao3Error("Connect your AO3 account first.", 401);
    const id = numericId(workId);
    const index = parseAo3ChapterIndex(
      await this.page(`/works/${id}/navigate`, signal),
      account,
      id,
    );
    return parseAo3Edition(
      await this.page(`/works/${id}?view_full_work=true`, signal),
      account,
      id,
      index,
    );
  }
  async download(
    edition: Ao3WorkEdition,
    signal?: AbortSignal,
  ): Promise<Ao3Import> {
    if (edition.accountId !== this.accountId)
      throw new Ao3Error(
        "This edition belongs to a different AO3 account.",
        401,
      );
    const response = await this.request(
      `/v1/epub?path=${encodeURIComponent(edition.epubPath)}`,
      { signal },
    );
    let file = await response.blob();
    if (
      !file.size ||
      file.size > 64 * 1024 * 1024 ||
      !response.headers.get("content-type")?.includes("application/epub+zip")
    )
      throw new Ao3Error("The companion did not return a supported EPUB.");
    const current = await this.edition(edition.workId, signal);
    if (current.revision !== edition.revision)
      throw new Ao3Error(
        "This work changed during download. Check again before importing; the previous edition is retained.",
      );
    if (current.workSkin) {
      try {
        file = await restoreAo3WorkSkin(file, current.workSkin, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Ao3Error(
          `AO3 formatting restoration failed. ${error instanceof Error ? error.message : "The previous edition is retained."}`,
        );
      }
    }
    signal?.throwIfAborted();
    if (this.accountId !== edition.accountId)
      throw new Ao3Error(
        "This edition belongs to a different AO3 account.",
        401,
      );
    return {
      accountId: edition.accountId,
      workId: edition.workId,
      title: edition.title,
      author: edition.author,
      revision: edition.revision,
      chapterIds: edition.chapterIds,
      file: new File(
        [file],
        `AO3-${edition.workId}-${edition.revision.slice(0, 12)}.epub`,
        { type: "application/epub+zip" },
      ),
    };
  }
}

const storedWork = z.object({
  workId: z.string().regex(/^[1-9]\d*$/),
  title: z.string(),
  author: z.string(),
  revision: z.string(),
  chapterIds: z.array(z.string()),
  checkedAt: z.string(),
  importedRevisions: z.array(z.string()).max(200),
});
export type Ao3StoredWork = z.infer<typeof storedWork>;
/** Metadata only: old reader book/file identities, anchors and bytes belong to the host repository. */
export class Ao3FollowStore {
  private key: string;
  private storage: Pick<Storage, "getItem" | "setItem">;
  constructor(
    accountScope: string,
    ao3AccountId: string,
    storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    this.key = `avid:ao3:follows:${JSON.stringify([accountScope, ao3AccountId])}`;
    this.storage = storage;
  }
  all(): Ao3StoredWork[] {
    const raw = this.storage.getItem(this.key);
    if (!raw) return [];
    return z.array(storedWork).max(1000).parse(JSON.parse(raw));
  }
  record(edition: Ao3WorkEdition, imported = false): Ao3StoredWork {
    const all = this.all(),
      previous = all.find((work) => work.workId === edition.workId);
    const importedRevisions = [
      ...new Set([
        ...(previous?.importedRevisions ?? []),
        ...(imported ? [edition.revision] : []),
      ]),
    ].slice(-200);
    const work: Ao3StoredWork = {
      workId: edition.workId,
      title: edition.title,
      author: edition.author,
      revision: edition.revision,
      chapterIds: edition.chapterIds,
      checkedAt: edition.checkedAt,
      importedRevisions,
    };
    const next = all.filter((item) => item.workId !== work.workId);
    next.push(work);
    if (next.length > 1000)
      throw new Ao3Error(
        "The connector tracks at most 1,000 works per account.",
      );
    this.storage.setItem(this.key, JSON.stringify(next));
    return work;
  }
}
