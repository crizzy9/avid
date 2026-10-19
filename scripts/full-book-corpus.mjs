#!/usr/bin/env node
/** Opt-in public-domain full-book corpus acquisition. No inference, app/server writes or transcoding. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { JSDOM } from "jsdom";

export const CORPUS = [
  {
    id: "alice-yearsley-v3",
    title: "Alice's Adventures in Wonderland (version 3)",
    narrator: "Peter Yearsley",
    role: "development",
    rssId: 900,
    archiveId: "alice_wonderland_0711_librivox",
    gutenbergId: 11,
    catalogDurationSeconds: 9780,
    catalogUrl:
      "https://librivox.org/alices-adventures-in-wonderland-by-lewis-carroll-3/",
    expectedTracks: 12,
  },
  {
    id: "pride-savage-v3",
    title: "Pride and Prejudice (version 3)",
    narrator: "Karen Savage",
    role: "development-validation",
    rssId: 1480,
    archiveId: "pride_prejudice_krs_librivox",
    gutenbergId: 1342,
    catalogDurationSeconds: 37380,
    catalogUrl: "https://librivox.org/pride-and-prejudice-by-jane-austen-2/",
    expectedTracks: 61,
  },
  {
    id: "jane-eyre-volunteers",
    title: "Jane Eyre",
    narrator:
      "LibriVox volunteers (per-section identity in catalog snapshot and audio tags)",
    role: "sealed-quality-holdout",
    rssId: 133,
    archiveId: "jane_eyre_librivox",
    gutenbergId: 1260,
    catalogDurationSeconds: 74196,
    catalogUrl: "https://librivox.org/jane-eyre-by-charlotte-bront/",
    expectedTracks: 39,
  },
];
export const SPLIT_SEED = "avid-full-book-baseline-2026-10-19-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const xml = (value) => new JSDOM(value, { contentType: "application/xml" });
export function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("Unsafe corpus-relative path");
  return value;
}
export async function sha256File(file) {
  return digestFile(file, "sha256");
}
async function digestFile(file, algorithm) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}
export function originalAudio(rssText, archiveMetadata, expectedTracks) {
  const dom = xml(rssText);
  try {
    const items = [...dom.window.document.querySelectorAll("item")].map(
      (item, index) => {
        const sourceUrl = item.querySelector("enclosure")?.getAttribute("url");
        if (
          !sourceUrl ||
          !/^https?:\/\/(www\.)?archive\.org\/download\//.test(sourceUrl)
        )
          throw new Error("Unexpected catalog audio origin");
        const sourceName = decodeURIComponent(
          new URL(sourceUrl).pathname.split("/").at(-1),
        );
        let current = archiveMetadata.files.find(
          (file) => file.name === sourceName,
        );
        const lineage = [];
        const seen = new Set();
        while (current) {
          if (seen.has(current.name))
            throw new Error("Cyclic Archive original chain");
          seen.add(current.name);
          lineage.push({
            name: current.name,
            source: current.source,
            format: current.format,
          });
          if (current.source === "original") break;
          current = archiveMetadata.files.find(
            (file) => file.name === current.original,
          );
        }
        if (
          !current ||
          current.source !== "original" ||
          !current.name.endsWith(".mp3") ||
          current.name.includes("/")
        )
          throw new Error(`No original MP3 for ${sourceName}`);
        const episode =
          item.getElementsByTagName("itunes:episode")[0]?.textContent.trim() ||
          String(index + 1);
        return {
          index,
          section: episode,
          title: item.querySelector("title")?.textContent.trim(),
          catalogAudioUrl: sourceUrl,
          catalogDuration: item
            .getElementsByTagName("itunes:duration")[0]
            ?.textContent.trim(),
          originalName: current.name,
          sourceUrl: `https://archive.org/download/${archiveMetadata.metadata.identifier}/${encodeURIComponent(current.name)}`,
          archive: {
            source: current.source,
            format: current.format,
            bytes: Number(current.size),
            sha1: current.sha1,
            md5: current.md5,
            originalLineage: lineage,
          },
        };
      },
    );
    if (
      items.length !== expectedTracks ||
      new Set(items.map((item) => item.originalName)).size !== items.length
    )
      throw new Error(
        `Expected ${expectedTracks} unique tracks, received ${items.length}`,
      );
    return items;
  } finally {
    dom.window.close();
  }
}
export function epubMetadata(bytes) {
  const zip = unzipSync(bytes);
  const container = xml(strFromU8(zip["META-INF/container.xml"]));
  let packagePath;
  try {
    packagePath = container.window.document
      .querySelector("rootfile")
      ?.getAttribute("full-path");
  } finally {
    container.window.close();
  }
  safeRelativePath(packagePath);
  if (!zip[packagePath]) throw new Error("Missing EPUB package");
  const dom = xml(strFromU8(zip[packagePath]));
  try {
    const doc = dom.window.document;
    const items = new Map(
      [...doc.querySelectorAll("manifest > item")].map((item) => [
        item.getAttribute("id"),
        item,
      ]),
    );
    const spine = [...doc.querySelectorAll("spine > itemref")].map(
      (ref, index) => {
        const item = items.get(ref.getAttribute("idref"));
        if (!item) throw new Error("Missing EPUB spine item");
        const href = item.getAttribute("href");
        const file = path.posix.normalize(
          path.posix.join(
            path.posix.dirname(packagePath),
            decodeURIComponent(href),
          ),
        );
        safeRelativePath(file);
        if (!zip[file]) throw new Error(`Missing EPUB spine content: ${file}`);
        return {
          index,
          idref: ref.getAttribute("idref"),
          href,
          path: file,
          mediaType: item.getAttribute("media-type"),
          linear: ref.getAttribute("linear") !== "no",
          bytes: zip[file].length,
          sha256: hash(zip[file]),
        };
      },
    );
    const metadata = doc.querySelector("metadata");
    const names = (name) =>
      [...metadata.getElementsByTagNameNS("*", name)].map((element) =>
        element.textContent.trim(),
      );
    return {
      packagePath,
      packageSha256: hash(zip[packagePath]),
      version: doc.documentElement.getAttribute("version"),
      title: names("title"),
      creator: names("creator"),
      language: names("language"),
      identifier: names("identifier"),
      rights: names("rights"),
      modified: [...metadata.querySelectorAll("meta")]
        .filter(
          (element) => element.getAttribute("property") === "dcterms:modified",
        )
        .map((element) => element.textContent.trim()),
      spine,
    };
  } finally {
    dom.window.close();
  }
}
export function splitFor(book, audio) {
  return {
    seed: SPLIT_SEED,
    rule: "For development books, first 32 SHA-256 bits of seed + '/' + book ID + '/' + section modulo 5 == 0 are withheld from tuning; all Jane Eyre sections are quality holdout. Fixed before inference.",
    chapters: audio.map((track) => ({
      section: track.section,
      index: track.index,
      role:
        book.role === "sealed-quality-holdout" ||
        Number.parseInt(
          hash(`${SPLIT_SEED}/${book.id}/${track.section}`).slice(0, 8),
          16,
        ) %
          5 ===
          0
          ? "quality-holdout"
          : book.role,
    })),
    detailedHoldoutQualityInspected: false,
  };
}
async function command(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${binary} exited ${code}: ${stderr}`)),
    );
  });
}
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function download(root, relative, url) {
  safeRelativePath(relative);
  const file = path.join(root, relative);
  const receipt = `${file}.fetch.json`;
  if (await exists(file)) {
    if (!(await exists(receipt)))
      throw new Error(`Existing unverified file: ${file}`);
    const meta = JSON.parse(await readFile(receipt, "utf8"));
    if (
      meta.sourceUrl !== url ||
      meta.sha256 !== (await sha256File(file)) ||
      meta.bytes !== (await stat(file)).size
    )
      throw new Error(`Cached artifact changed: ${relative}`);
    return meta;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const resolvedUrl = (
    await command("curl", [
      "--location",
      "--fail",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--connect-timeout",
      "30",
      "--max-time",
      "1200",
      "--max-filesize",
      "536870912",
      "--speed-time",
      "90",
      "--speed-limit",
      "1024",
      ...(relative.endsWith(".mp3") ? ["--continue-at", "-"] : []),
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--output",
      `${file}.partial`,
      "--write-out",
      "%{url_effective}",
      url,
    ])
  ).trim();
  const meta = {
    path: relative,
    sourceUrl: url,
    resolvedUrl,
    fetchedAt: new Date().toISOString(),
    bytes: (await stat(`${file}.partial`)).size,
    sha256: await sha256File(`${file}.partial`),
  };
  await writeFile(`${receipt}.partial`, JSON.stringify(meta, null, 2) + "\n");
  await rename(`${file}.partial`, file);
  await rename(`${receipt}.partial`, receipt);
  return meta;
}
async function parallel(items, count, operation) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await operation(items[index], index);
      }
    }),
  );
  return output;
}
async function acquireBook(root, book, concurrency = 3) {
  const prefix = book.id;
  const frozenFile = path.join(root, prefix, "corpus.json");
  if (await exists(frozenFile)) {
    const frozen = JSON.parse(await readFile(frozenFile, "utf8"));
    for (const [key, value] of Object.entries(book))
      if (frozen[key] !== value)
        throw new Error(`Frozen corpus definition changed: ${book.id}/${key}`);
    await verifyManifest({ schemaVersion: 1, books: [frozen] }, root);
    process.stdout.write(`${book.id}: existing frozen book reverified\n`);
    return frozen;
  }
  const metadata = await parallel(
    [
      ["catalog.html", book.catalogUrl],
      ["catalog.rss.xml", `https://librivox.org/rss/${book.rssId}`],
      [
        "archive-metadata.json",
        `https://archive.org/metadata/${book.archiveId}`,
      ],
      [
        "gutenberg.html",
        `https://www.gutenberg.org/ebooks/${book.gutenbergId}`,
      ],
    ],
    3,
    async ([file, url]) => download(root, `${prefix}/sources/${file}`, url),
  );
  const rss = await readFile(path.join(root, metadata[1].path), "utf8");
  const archive = JSON.parse(
    await readFile(path.join(root, metadata[2].path), "utf8"),
  );
  const audioSources = originalAudio(rss, archive, book.expectedTracks);
  const gutenbergDom = new JSDOM(
    await readFile(path.join(root, metadata[3].path), "utf8"),
  );
  let epubUrl;
  try {
    const link = [
      ...gutenbergDom.window.document.querySelectorAll("a[href]"),
    ].find(
      (item) =>
        item.getAttribute("href") ===
        `/ebooks/${book.gutenbergId}.epub3.images`,
    );
    if (!link) throw new Error("Expected EPUB3 catalog link is absent");
    epubUrl = new URL(
      link.getAttribute("href"),
      `https://www.gutenberg.org/ebooks/${book.gutenbergId}`,
    ).href;
  } finally {
    gutenbergDom.window.close();
  }
  const epubDownload = await download(root, `${prefix}/ebook.epub`, epubUrl);
  const epub = {
    ...epubDownload,
    ...epubMetadata(
      new Uint8Array(await readFile(path.join(root, epubDownload.path))),
    ),
  };
  const audio = await parallel(audioSources, concurrency, async (source) => {
    const downloaded = await download(
      root,
      `${prefix}/audio/${source.originalName}`,
      source.sourceUrl,
    );
    if (downloaded.bytes !== source.archive.bytes)
      throw new Error(`Archive byte count differs: ${source.originalName}`);
    if (
      !/^[a-f0-9]{40}$/.test(source.archive.sha1) ||
      (await digestFile(path.join(root, downloaded.path), "sha1")) !==
        source.archive.sha1
    )
      throw new Error(`Archive SHA-1 differs: ${source.originalName}`);
    const probe = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        "-of",
        "json",
        path.join(root, downloaded.path),
      ]),
    );
    const durationSeconds = Number(probe.format?.duration);
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      !probe.streams?.some(
        (stream) =>
          stream.codec_type === "audio" && stream.codec_name === "mp3",
      )
    )
      throw new Error(`Invalid MP3 probe: ${source.originalName}`);
    const result = { ...source, ...downloaded, durationSeconds, probe };
    process.stdout.write(
      `${book.id}: verified original MP3 ${source.index + 1}/${audioSources.length}\n`,
    );
    return result;
  });
  const split = splitFor(book, audio);
  const rightsText = `Corpus source notices\n\nRecording: ${book.title}; ${book.narrator}.\nLibriVox catalog: ${book.catalogUrl}\nLibriVox states recordings are public domain in the USA; copyright status elsewhere must be checked. The downloaded catalog and Archive metadata are retained in sources/.\n\nEbook: Project Gutenberg #${book.gutenbergId}, https://www.gutenberg.org/ebooks/${book.gutenbergId}\nThe Gutenberg catalog states public domain in the USA. The actual EPUB is preserved intact with its embedded Project Gutenberg license/terms and front/back matter; catalog snapshot retained in sources/.\n\nNo recording was transcoded, trimmed, reordered or cleaned. Catalog order retained; explicit Archive original parent MP3 selected for each RSS enclosure.\n`;
  await writeFile(path.join(root, prefix, "SOURCE-NOTICES.txt"), rightsText);
  const record = {
    ...book,
    language: "en",
    frozenAt: new Date().toISOString(),
    encodingSelection:
      "Archive original MP3 ancestor of each LibriVox RSS enclosure, ordered by RSS items; no transformations",
    sourceSnapshots: metadata,
    rights: {
      recording:
        "LibriVox: public domain in USA; jurisdiction-specific elsewhere",
      ebook:
        "Project Gutenberg: public domain in USA; embedded distribution terms retained",
      noticesPath: `${prefix}/SOURCE-NOTICES.txt`,
      noticesSha256: hash(rightsText),
    },
    epub,
    audio,
    totalAudioBytes: audio.reduce((sum, track) => sum + track.bytes, 0),
    measuredDurationSeconds: audio.reduce(
      (sum, track) => sum + track.durationSeconds,
      0,
    ),
    split,
    qualityReview: {
      status: "not performed",
      independentlyLabeledParagraphs: 0,
      independentlyLabeledBoundaries: 0,
    },
  };
  await writeFile(
    path.join(root, prefix, "corpus.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  process.stdout.write(
    `${book.id}: FROZEN ${audio.length} tracks, ${(record.measuredDurationSeconds / 3600).toFixed(4)} h; ${path.join(root, prefix, "corpus.json")}\n`,
  );
  return record;
}
export async function verifyManifest(manifest, root) {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.books) ||
    !manifest.books.length
  )
    throw new Error("Unsupported corpus manifest");
  const ids = new Set();
  for (const book of manifest.books) {
    if (
      ids.has(book.id) ||
      !book.audio.length ||
      book.expectedTracks !== book.audio.length
    )
      throw new Error("Invalid book inventory");
    ids.add(book.id);
    for (const artifact of [
      book.epub,
      ...book.audio,
      ...book.sourceSnapshots,
    ]) {
      safeRelativePath(artifact.path);
      if (
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        (await stat(path.join(root, artifact.path))).size !== artifact.bytes ||
        (await sha256File(path.join(root, artifact.path))) !== artifact.sha256
      )
        throw new Error(`Corpus hash/size mismatch: ${artifact.path}`);
      if (
        artifact.archive &&
        (!/^[a-f0-9]{40}$/.test(artifact.archive.sha1) ||
          (await digestFile(path.join(root, artifact.path), "sha1")) !==
            artifact.archive.sha1)
      )
        throw new Error(`Archive source hash mismatch: ${artifact.path}`);
    }
    safeRelativePath(book.rights.noticesPath);
    if (
      (await sha256File(path.join(root, book.rights.noticesPath))) !==
      book.rights.noticesSha256
    )
      throw new Error("Source notice mismatch");
  }
  return {
    books: manifest.books.length,
    tracks: manifest.books.reduce((sum, book) => sum + book.audio.length, 0),
    bytes: manifest.books.reduce(
      (sum, book) => sum + book.totalAudioBytes + book.epub.bytes,
      0,
    ),
  };
}
async function main() {
  const args = process.argv.slice(2);
  const option = (key, fallback) => {
    const index = args.indexOf(key);
    return index < 0 ? fallback : args[index + 1];
  };
  if (
    args.includes("--help") ||
    (!args.includes("--fetch") && !args.includes("--verify"))
  ) {
    console.log(
      "Usage: node scripts/full-book-corpus.mjs --fetch --root /tmp/avid-full-books [--book ID] [--concurrency 1..6] [--evidence FILE]\n       node scripts/full-book-corpus.mjs --verify --root /tmp/avid-full-books [--manifest FILE]\nRequires curl, ffprobe, installed repository dependencies. Fetch is opt-in. MP3 partials resume through HTTP Range and must pass original source hashes. Existing downloads are rehashed before reuse. No model/inference work is performed.",
    );
    return;
  }
  const root = path.resolve(option("--root", "/tmp/avid-full-books"));
  if (args.includes("--verify")) {
    const manifestFile = path.resolve(
      option("--manifest", path.join(root, "manifest.json")),
    );
    console.log(
      JSON.stringify(
        await verifyManifest(
          JSON.parse(await readFile(manifestFile, "utf8")),
          root,
        ),
      ),
    );
    return;
  }
  const selectedId = option("--book", null);
  const concurrency = Number(option("--concurrency", "3"));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6)
    throw new Error("Download concurrency must be an integer from 1 to 6");
  const selected = selectedId
    ? CORPUS.filter((book) => book.id === selectedId)
    : CORPUS;
  if (!selected.length) throw new Error("Unknown corpus book");
  await mkdir(root, { recursive: true });
  const existingManifest = path.join(root, "manifest.json");
  const books = (await exists(existingManifest))
    ? JSON.parse(await readFile(existingManifest, "utf8")).books
    : [];
  if (
    !Array.isArray(books) ||
    books.some(
      (book) => !CORPUS.some((definition) => definition.id === book.id),
    )
  )
    throw new Error("Existing manifest has an unexpected book inventory");
  for (const book of selected) {
    const frozen = await acquireBook(root, book, concurrency);
    const existingIndex = books.findIndex((entry) => entry.id === book.id);
    if (existingIndex >= 0) books[existingIndex] = frozen;
    else books.push(frozen);
    books.sort(
      (a, b) =>
        CORPUS.findIndex((book) => book.id === a.id) -
        CORPUS.findIndex((book) => book.id === b.id),
    );
    await writeFile(
      path.join(root, "manifest.json.partial"),
      JSON.stringify(
        {
          schemaVersion: 1,
          corpusId: "avid-full-books-2026-10-19-original-mp3",
          baselineCommit: "654db63d2d7bc6abf991c7c60af7438796f3a526",
          frozenAt: new Date().toISOString(),
          completePrimaryInventory: books.length === CORPUS.length,
          productionRecognitionRun: false,
          books,
        },
        null,
        2,
      ) + "\n",
    );
    await rename(
      path.join(root, "manifest.json.partial"),
      path.join(root, "manifest.json"),
    );
  }
  const manifest = {
    schemaVersion: 1,
    corpusId: "avid-full-books-2026-10-19-original-mp3",
    baselineCommit: "654db63d2d7bc6abf991c7c60af7438796f3a526",
    frozenAt: new Date().toISOString(),
    completePrimaryInventory: books.length === CORPUS.length,
    productionRecognitionRun: false,
    toolVersions: {
      node: process.version,
      ffprobe: (await command("ffprobe", ["-version"])).split("\n")[0],
      curl: (await command("curl", ["--version"])).split("\n")[0],
    },
    books,
  };
  await verifyManifest(manifest, root);
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(path.join(root, "manifest.json.partial"), serialized);
  await rename(
    path.join(root, "manifest.json.partial"),
    path.join(root, "manifest.json"),
  );
  if (option("--evidence"))
    await writeFile(path.resolve(option("--evidence")), serialized);
  console.log(`Manifest frozen: ${path.join(root, "manifest.json")}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
