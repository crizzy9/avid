// Opt-in development-only full-book runner. Production preparation code is not modified.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Reader } from "../src/Reader";
import type { ReaderAlignmentHandle } from "../src/alignedPassage";
import { BookOrbitClient, type AudioManifest } from "../../core/src/bookorbit";
import { accountScope } from "../../core/src/repository";
import { PreparedReadListenStore } from "../../core/src/preparedReadListen";
import { sha256Blob } from "../../core/src/blobHash";
import type { Book } from "../../core/src/types";
import {
  prepareReadListen,
  createLocalRecognizer,
  type PreparationProgress,
} from "../../../apps/web/src/preparation/prepareReadListen";
import { generateAlignmentInWorker } from "../../../apps/web/src/preparation/match";
import type { GeneratedAlignmentSnapshot } from "../../playback/src/generated-alignment";
import "../../../apps/web/src/styles.css";

interface Asset {
  path: string;
  sha256: string;
  bytes: number;
  durationSeconds?: number;
  title?: string;
}
interface CorpusBook {
  id: string;
  title: string;
  narrator: string;
  role: string;
  epub: Asset;
  audio: Asset[];
}
interface Config {
  corpus: { books: CorpusBook[] };
  corpusManifestSha256: string;
  commit: string;
  baseline: string;
  sourceProof: { path: string; sha256: string; matchesBaseline: boolean }[];
  harnessProof: unknown;
  buildProof: unknown;
  model: unknown;
  modelCache: { name: string; url: string; localUrl: string; sha256: string }[];
}
const session = {
  profile: {
    id: "full-book-baseline",
    name: "Public full-book fixture",
    url: "https://full-book-fixture.invalid",
  },
  userId: "public-corpus",
  accessToken: "unused-fixture-token",
};
const scope = accountScope(session);
const assetUrl = (id: string, kind: string, index?: number) =>
  `/__fullbook/asset?book=${encodeURIComponent(id)}&kind=${kind}${index === undefined ? "" : `&index=${index}`}`;
class EvidenceSaveError extends Error {}
let evidenceWrites: Promise<void> = Promise.resolve();
function save(name: string, value: unknown, artifact = false) {
  const body = JSON.stringify(value);
  const write = evidenceWrites.then(async () => {
    const response = await fetch(
      `/__fullbook/${artifact ? "artifact" : "report"}?name=${encodeURIComponent(name)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body },
    );
    if (!response.ok)
      throw new EvidenceSaveError(
        `Could not save benchmark evidence: ${response.status} ${await response.text()}`,
      );
  });
  evidenceWrites = write.catch(() => {});
  return write;
}
function Harness() {
  const [config, setConfig] = useState<Config>(),
    [selected, setSelected] = useState(""),
    [source, setSource] = useState<Blob>(),
    [handle, setHandle] = useState<ReaderAlignmentHandle | null>(null),
    [status, setStatus] = useState("Loading corpus…"),
    [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null),
    started = useRef(false);
  const corpusBook = config?.corpus.books.find((book) => book.id === selected);
  useEffect(() => {
    void fetch("/__fullbook/config")
      .then((r) => r.json())
      .then((value: Config) => {
        setConfig(value);
        setSelected(
          new URLSearchParams(location.search).get("book") ??
            value.corpus.books[0]?.id ??
            "",
        );
        setStatus("Select a complete book and start its baseline.");
      })
      .catch((error) => {
        setStatus(String(error));
        document.documentElement.dataset.fullBookStatus = "failed";
      });
  }, []);
  useEffect(() => {
    setSource(undefined);
    setHandle(null);
    started.current = false;
    if (!corpusBook) return;
    let active = true;
    void fetch(assetUrl(corpusBook.id, "epub"))
      .then((r) => r.blob())
      .then(async (blob) => {
        if ((await sha256Blob(blob)) !== corpusBook.epub.sha256)
          throw Error("Corpus EPUB hash changed.");
        if (active) setSource(blob);
      })
      .catch((error) => {
        setStatus(String(error));
        document.documentElement.dataset.fullBookStatus = "failed";
      });
    return () => {
      active = false;
    };
  }, [corpusBook]);
  async function run() {
    if (!config || !corpusBook || !source || !handle || running) return;
    started.current = true;
    delete document.documentElement.dataset.fullBookStatus;
    setRunning(true);
    const control = new AbortController();
    abort.current = control;
    const attemptId = crypto.randomUUID();
    const begin = performance.now(),
      name = corpusBook.id + "-baseline",
      events: unknown[] = [],
      tracks: unknown[] = [];
    const report: Record<string, unknown> = {
      schemaVersion: 1,
      attemptId,
      corpusManifestSha256: config.corpusManifestSha256,
      instrumentedWallTime: true,
      bookId: corpusBook.id,
      role: corpusBook.role,
      startedAt: new Date().toISOString(),
      status: "running",
      baseline: config.baseline,
      commit: config.commit,
      sourceProof: config.sourceProof,
      harnessProof: config.harnessProof,
      buildProof: config.buildProof,
      model: config.model,
      runtime: {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        backend: "production-browser-worker-wasm",
        threads: 1,
      },
      originalAssetCount: corpusBook.audio.length,
      originalAudioSeconds: corpusBook.audio.reduce(
        (n, a) => n + a.durationSeconds!,
        0,
      ),
      modelCache: config.modelCache.map(({ name, sha256 }) => ({
        name,
        sha256,
      })),
      events,
      tracks,
      qualityReview: "not performed",
      coldReopen: "not performed",
      nativeAcceptance: "not performed",
    };
    let stage = "initializing",
      lastProgress = 0;
    const record = (progress: PreparationProgress) => {
      stage = progress.stage;
      setStatus(
        `${stage}: ${progress.fraction === undefined ? "" : (100 * progress.fraction).toFixed(2) + "%"} ${progress.detail ?? ""}`,
      );
      const now = performance.now();
      if (now - lastProgress < 5000 && progress.stage === "comparing") return;
      lastProgress = now;
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
      events.push({
        ...progress,
        elapsedMs: Math.round(now - begin),
        jsHeapBytes: memory?.usedJSHeapSize ?? null,
      });
      void save(name, {
        ...report,
        lastStage: stage,
        elapsedMs: Math.round(now - begin),
      }).catch((error) => {
        control.abort();
        setStatus(String(error));
      });
    };
    const manifest: AudioManifest = {
      schema: "bookorbit.audiobook-manifest",
      schemaVersion: 2,
      revision: corpusBook.epub.sha256.slice(0, 16) + "-" + corpusBook.id,
      totalDurationMs: corpusBook.audio.reduce(
        (sum, a) => sum + Math.round(a.durationSeconds!) * 1000,
        0,
      ),
      chapters: [],
      assets: corpusBook.audio.map((a, index) => ({
        assetId: `asset-${index}`,
        fileId: 2000 + index,
        sequence: index,
        format: "mp3",
        durationMs: Math.round(a.durationSeconds!) * 1000,
        sizeBytes: a.bytes,
        etag: a.sha256,
      })),
    };
    const book: Book = {
      id: corpusBook.id,
      title: corpusBook.title,
      authors: [],
      description: "Complete independent public audio/EPUB baseline",
      format: "EPUB",
      color: "#a58b55",
      progress: 0,
      status: "unread",
      genres: [],
      addedAt: "2026-10-19",
      files: [{ id: "1000", name: "book.epub", format: "EPUB" }],
    };
    class Client extends BookOrbitClient {
      constructor() {
        super(session, {
          readOnly: true,
          fetch: async () => {
            throw Error(
              "No external BookOrbit server is permitted in this fixture.",
            );
          },
        });
      }
      override async getAudioManifest() {
        return structuredClone(manifest);
      }
      override async getAudioAssetBlob(
        _id: string,
        assetId: string,
        options: { signal?: AbortSignal } = {},
      ) {
        const index = manifest.assets.findIndex((a) => a.assetId === assetId);
        if (index < 0) throw Error("Unknown audio asset.");
        const response = await fetch(assetUrl(corpusBook!.id, "audio", index), {
          signal: options.signal,
        });
        if (!response.ok) throw Error("Corpus audio unavailable.");
        const blob = await response.blob();
        if (
          blob.size !== corpusBook!.audio[index]!.bytes ||
          (await sha256Blob(blob)) !== corpusBook!.audio[index]!.sha256
        )
          throw Error("Corpus audio hash changed.");
        return blob;
      }
    }
    try {
      await save(name, report);
      if (config.sourceProof.some((item) => !item.matchesBaseline))
        throw Error(
          "Production preparation sources differ from the declared baseline.",
        );
      // Seed only exact pinned model artifacts already present in the local opt-in cache.
      // The unmodified worker still loads its ordinary immutable Hugging Face URLs.
      const cache = await caches.open("transformers-cache");
      for (const item of config.modelCache) {
        const response = await fetch(item.localUrl);
        const blob = await response.blob();
        if ((await sha256Blob(blob)) !== item.sha256)
          throw Error("Model cache hash changed.");
        await cache.put(
          item.url,
          new Response(blob, {
            headers: {
              "Content-Type": item.name.endsWith(".json")
                ? "application/json"
                : "application/octet-stream",
            },
          }),
        );
      }
      const result = await prepareReadListen(
        {
          client: new Client(),
          profile: "balanced",
          scope,
          scopeLabel: "Public corpus baseline",
          book,
          fileId: "1000",
          epub: source,
          handle: {
            ...handle,
            extractAlignmentText: async () => {
              const publication = await handle.extractAlignmentText!();
              report.extractedPassages = publication.passages.length;
              await save(name + "-publication", publication, true);
              return publication;
            },
          },
          store: new PreparedReadListenStore(
            `avid-full-book-baseline-v1-${attemptId}`,
          ),
          signal: control.signal,
          isActive: () => !control.signal.aborted,
          onProgress: record,
        },
        async (signal, onModel, profile) => {
          const inner = await createLocalRecognizer(signal, onModel, profile);
          let index = 0;
          return {
            dispose: () => inner.dispose(),
            transcribe: async (blob, duration, onTime) => {
              const track = index++,
                start = performance.now();
              const words = await inner.transcribe(blob, duration, onTime);
              const value = {
                index: track,
                duration,
                words: words.length,
                recognitionMs: Math.round(performance.now() - start),
              };
              tracks.push(value);
              await save(
                name + "-track-" + track,
                {
                  ...value,
                  sourceSha256: corpusBook.audio[track]!.sha256,
                  words,
                },
                true,
              );
              return words;
            },
          };
        },
        async (input, signal) => {
          stage = "matching";
          await save(name + "-matching-input", input, true);
          const value: GeneratedAlignmentSnapshot =
            await generateAlignmentInWorker(input, signal);
          report.coverage = value.coverage;
          await save(name + "-alignment", value, true);
          return value;
        },
      );
      if (result.reused)
        throw Error("Unexpected prepared-package reuse; not a fresh baseline.");
      report.status = "prepared";
      report.reused = result.reused;
      report.preparedPackageId = result.descriptor.id;
      report.segments = result.map.segments.length;
      setStatus(
        `Prepared full book: ${result.map.segments.length} matched passages. Accuracy review has not run.`,
      );
    } catch (error) {
      report.status = control.signal.aborted ? "cancelled" : "failed";
      report.error = error instanceof Error ? error.message : String(error);
      report.failureCategory =
        error instanceof EvidenceSaveError
          ? "harness-evidence"
          : control.signal.aborted
            ? "cancelled"
            : "preparation";
      setStatus(`${report.status} at ${stage}: ${report.error}`);
    } finally {
      report.lastStage = stage;
      report.finishedAt = new Date().toISOString();
      report.elapsedMs = Math.round(performance.now() - begin);
      await save(name, report).catch((error) => {
        report.status = "evidence-failed";
        setStatus(String(error));
      });
      setRunning(false);
      document.documentElement.dataset.fullBookStatus = String(report.status);
    }
  }
  useEffect(() => {
    if (
      handle &&
      source &&
      new URLSearchParams(location.search).get("autorun") === "1" &&
      !started.current
    )
      void run();
  }, [handle, source]);
  const controls = (
    <section style={{ padding: 16, background: "#182421", color: "white" }}>
      <h1>Full-book baseline</h1>
      <p>
        Local public corpus. No user server. Original recordings; whole-second
        manifest durations.
      </p>
      <select
        aria-label="Full book"
        disabled={running}
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        {config?.corpus.books.map((book) => (
          <option key={book.id} value={book.id}>
            {book.title}
          </option>
        ))}
      </select>
      <button disabled={!handle || running} onClick={() => void run()}>
        Run full-book baseline
      </button>
      <button disabled={!running} onClick={() => abort.current?.abort()}>
        Cancel baseline
      </button>
      <p role="status">{status}</p>
    </section>
  );
  return source && corpusBook ? (
    <Reader
      key={corpusBook.id}
      book={{
        id: corpusBook.id,
        title: corpusBook.title,
        authors: [],
        description: "",
        format: "EPUB",
        color: "#a58b55",
        progress: 0,
        status: "unread",
        genres: [],
        addedAt: "2026-10-19",
        files: [{ id: "1000", name: "book.epub", format: "EPUB" }],
      }}
      file={{ id: "1000", name: "book.epub", format: "EPUB" }}
      source={source}
      accountScope={scope}
      annotations={[]}
      annotationsEnabled={false}
      persistProgress={false}
      externalNarration
      onAnchor={() => {
        throw Error("Baseline must not save progress.");
      }}
      onAnnotation={() => {
        throw Error("Baseline must not save annotations.");
      }}
      onAlignmentReady={setHandle}
      onClose={() => abort.current?.abort()}
      modeControls={controls}
    />
  ) : (
    controls
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
