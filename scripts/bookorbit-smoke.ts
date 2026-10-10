/** Disposable loopback integration fixture. Never point this script at a real library. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { BookOrbitClient, ReadOnlyError } from "../packages/core/src/bookorbit";
import type {
  Annotation,
  Book,
  ReadingAnchor,
  Session,
} from "../packages/core/src/types";

const rawTarget =
  process.env.AVID_BOOKORBIT_SMOKE_URL ?? "http://127.0.0.1:43120";
const target = new URL(rawTarget);
assert(
  ["127.0.0.1", "[::1]"].includes(target.hostname) &&
    target.protocol === "http:" &&
    Number(target.port) >= 1024 &&
    !target.username &&
    !target.password &&
    !target.search &&
    !target.hash &&
    target.pathname === "/",
  "Refusing writes: this smoke runner accepts only an explicit loopback HTTP port, without a path or credentials.",
);
assert(
  process.env.AVID_DISPOSABLE_BOOKORBIT === "1",
  "Set AVID_DISPOSABLE_BOOKORBIT=1 only for the disposable local fixture.",
);
const server = target.origin;
const fixtureRoot = resolve("/tmp/avid-bookorbit-data");
const credentialsPath = `/tmp/avid-bookorbit-smoke-${target.port}.json`;
const reportPath =
  process.env.AVID_BOOKORBIT_SMOKE_REPORT ??
  "/tmp/avid-bookorbit-smoke-report.json";
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const requests: { method: string; path: string; status: number }[] = [];
const report: {
  target: string;
  contract: string;
  runId: string;
  checkedAt: string;
  checks: { name: string; passed: boolean; detail?: string }[];
  requests: typeof requests;
} = {
  target: server,
  contract: "3.3.0 / e767358443419253eeed782518d6fc4f675d69fd",
  runId,
  checkedAt: new Date().toISOString(),
  checks: [],
  requests,
};
const transport: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(
    url.origin === server,
    "Refusing a request outside the disposable loopback server.",
  );
  const response = await fetch(input, {
    ...init,
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  requests.push({
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    path: url.pathname,
    status: response.status,
  });
  return response;
};
async function request(path: string, body?: unknown, session?: Session) {
  const response = await transport(`${server}/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(
      `Fixture ${path} returned ${response.status}: ${await response.text()}`,
    );
  return response.json();
}
async function check(name: string, action: () => Promise<void>) {
  try {
    await action();
    report.checks.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.checks.push({ name, passed: false, detail });
    console.error(`FAIL ${name}: ${detail}`);
  }
}
const fixtureFile = (name: string) =>
  resolve("packages/readers/fixtures", name);
async function main() {
  let credentials: { username: string; password: string; server: string };
  const status = await request("auth/setup-status");
  if (status.needsSetup) {
    credentials = {
      server,
      username: "avid_fixture_admin",
      password: `AvidFixture1-${randomBytes(24).toString("base64url")}`,
    };
    await request("auth/setup", {
      username: credentials.username,
      password: credentials.password,
      name: "Avid disposable fixture",
      email: "avid-fixture@example.invalid",
    });
    await writeFile(credentialsPath, JSON.stringify(credentials), {
      mode: 0o600,
    });
  } else {
    credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
    assert(
      credentials.server === server &&
        credentials.username === "avid_fixture_admin",
      "This is not the previously created disposable fixture account.",
    );
  }
  const session = await BookOrbitClient.login(
    {
      id: "avid-disposable-fixture",
      name: "Disposable BookOrbit",
      url: server,
      username: credentials.username,
    },
    credentials.password,
    { fetch: transport, clientKind: "native" },
  );
  const client = new BookOrbitClient(session, { fetch: transport });
  await check(
    "native password authentication and actual account identity",
    async () => {
      assert.equal((await client.getCurrentUser()).id, session.userId);
      assert(
        session.refreshToken,
        "Native login must return its explicit refresh token.",
      );
      assert.equal((await client.getServerInfo()).version, "3.3.0");
    },
  );
  const libraryFolder = resolve(fixtureRoot, `smoke-${runId}`);
  await mkdir(libraryFolder, { recursive: true });
  const library = await request(
    "libraries",
    {
      name: `Avid smoke ${runId}`,
      icon: "Library",
      type: "books",
      folders: [libraryFolder],
      watch: false,
      organizationMode: "book_per_file",
    },
    client.session,
  );
  assert(
    Number.isInteger(library.id),
    "Fixture library must be created before any upload.",
  );
  async function upload(name: string, source: string): Promise<Book> {
    const bytes = await readFile(source);
    const result = (await client.uploadBook(
      String(library.id),
      new File([bytes], name),
    )) as { bookId: number };
    assert(Number.isInteger(result.bookId), "Upload must return a book ID.");
    return client.getBook(String(result.bookId));
  }
  const epub = await upload(
    `avid-${runId}.epub`,
    fixtureFile("sample-aligned.epub"),
  );
  const pdf = await upload(`avid-${runId}.pdf`, fixtureFile("sample.pdf"));
  const epubFile = epub.files.find((file) => file.format === "EPUB")!;
  const pdfFile = pdf.files.find((file) => file.format === "PDF")!;
  assert(
    epubFile && pdfFile,
    "Uploaded fixture editions must expose their exact primary file IDs.",
  );
  await check(
    "EPUB and PDF upload, paginated catalog and exact source file IDs",
    async () => {
      const page = await client.listBooks({
        libraryId: String(library.id),
        size: 1,
        page: 1,
      });
      assert.equal(page.total, 2);
      assert.equal(page.page, 1);
      assert.equal(page.items.length, 1);
      const second = await client.listBooks({
        libraryId: String(library.id),
        size: 1,
        page: 2,
      });
      assert.equal(second.items.length, 1);
      assert.notEqual(page.items[0].id, second.items[0].id);
    },
  );
  const anchor: ReadingAnchor = {
    bookId: epub.id,
    fileId: epubFile.id,
    kind: "epub",
    locator: "epubcfi(/6/2!/4/2/1:0)",
    progress: 0.27,
    updatedAt: new Date().toISOString(),
  };
  await check("EPUB CFI and progress write/read", async () => {
    await client.saveProgress(anchor);
    const saved = await client.getProgress(anchor);
    assert(saved);
    assert.equal(saved.fileId, anchor.fileId);
    assert.equal(saved.locator, anchor.locator);
    assert.equal(saved.progress, anchor.progress);
  });
  await check("PDF page and percentage write/read", async () => {
    const position: ReadingAnchor = {
      bookId: pdf.id,
      fileId: pdfFile.id,
      kind: "pdf",
      locator: "2",
      progress: 0.5,
      updatedAt: new Date().toISOString(),
    };
    await client.saveProgress(position);
    const saved = await client.getProgress(position);
    assert(saved);
    assert.equal(saved.locator, "2");
    assert.equal(saved.progress, 0.5);
  });
  for (const [book, file, locator] of [
    [epub, epubFile, anchor.locator],
    [
      pdf,
      pdfFile,
      JSON.stringify({
        page: 0,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
      }),
    ],
  ] as const)
    await check(
      `${file.format} annotation create/edit/read/delete`,
      async () => {
        const now = new Date().toISOString();
        const draft: Annotation = {
          id: randomUUID(),
          bookId: book.id,
          fileId: file.id,
          kind: "note",
          quote: "Original Avid fixture text",
          text: "Fixture note",
          color: "yellow",
          locator,
          createdAt: now,
          updatedAt: now,
        };
        const created = await client.saveAnnotation(draft);
        assert.match(created.id, /^\d+$/);
        assert.equal(created.fileId, file.id);
        assert.equal(created.text, "Fixture note");
        const edited = await client.saveAnnotation({
          ...created,
          text: "Edited fixture note",
          updatedAt: new Date().toISOString(),
        });
        assert.equal(edited.id, created.id);
        assert.equal(edited.text, "Edited fixture note");
        assert(
          (await client.getAnnotations(book.id, file.id)).some(
            (note) => note.id === created.id && note.text === edited.text,
          ),
        );
        await client.deleteAnnotation(book.id, created.id);
        assert(
          !(await client.getAnnotations(book.id, file.id)).some(
            (note) => note.id === created.id,
          ),
        );
      },
    );
  await check("collection creation and membership add/remove", async () => {
    const collection = await client.createCollection({
      name: `Smoke collection ${runId}`,
    });
    await client.addCollectionBooks(collection.id, [epub.id, pdf.id]);
    assert.equal((await client.getCollectionBooks(collection.id)).total, 2);
    assert(
      (await client.getBookCollections(epub.id)).some(
        (row) => row.id === collection.id && row.bookIds.includes(epub.id),
      ),
    );
    await client.removeCollectionBooks(collection.id, [pdf.id]);
    assert.equal((await client.getCollectionBooks(collection.id)).total, 1);
    assert(
      !(await client.getBookCollections(pdf.id)).some(
        (row) => row.id === collection.id && row.bookIds.includes(pdf.id),
      ),
    );
  });
  await check(
    "raw reading statuses preserve want_to_read and reading",
    async () => {
      await client.setReadStatus(epub.id, "want_to_read");
      assert.equal(
        (await client.getBook(epub.id)).serverStatus,
        "want_to_read",
      );
      await client.setReadStatus(epub.id, "reading");
      assert.equal((await client.getBook(epub.id)).serverStatus, "reading");
    },
  );
  await check("reader preference patch/read", async () => {
    await client.patchPreferences(epubFile.id, { fontSize: 21 });
    const preferences = await client.getReaderPreferences(epubFile.id);
    assert(preferences.isCustomized);
    assert.equal(preferences.settings?.fontSize, 21);
  });
  await check(
    "activity source timestamps, retry idempotence, and server statistics",
    async () => {
      const before = await client.getBookSessions(epub.id);
      const activity = {
        id: randomUUID(),
        bookId: epub.id,
        kind: "reading" as const,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        duration: 42,
      };
      const options = {
        endedAt: new Date(Date.now() - 60_000).toISOString(),
        endProgress: 0.27,
        progressDelta: 0.1,
        source: "ios" as const,
      };
      await client.saveReadingSession(activity, epubFile.id, options);
      await client.saveReadingSession(activity, epubFile.id, options);
      const after = await client.getBookSessions(epub.id);
      assert.equal(after.total, before.total + 1);
      assert(
        after.items.some(
          (row) =>
            row.durationSeconds === 42 &&
            row.source === "ios" &&
            Date.parse(row.startedAt) === Date.parse(activity.startedAt),
        ),
      );
      const statistics = await client.getReadingStatistics();
      assert(statistics.snapshot.today.readingSeconds >= 42);
    },
  );
  await check(
    "original audio upload, revisioned playback position and audio note CRUD",
    async () => {
      const audioPath = resolve("/tmp", `avid-original-audio-${runId}.mp3`);
      const conversion = spawnSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          fixtureFile("audio1.wav"),
          "-codec:a",
          "libmp3lame",
          audioPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(
        conversion.status,
        0,
        "ffmpeg must convert the original Avid WAV fixture.",
      );
      const audio = await upload(`avid-${runId}.mp3`, audioPath);
      const file = audio.files.find((row) => row.format === "AUDIO");
      assert(file);
      let manifest = await client.getAudioManifest(audio.id);
      for (
        let attempt = 0;
        attempt < 20 && !manifest.totalDurationMs;
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        manifest = await client.getAudioManifest(audio.id);
      }
      assert(
        manifest.totalDurationMs > 1000,
        "Server metadata extraction must provide actual audio duration.",
      );
      const asset = manifest.assets[0];
      const position: ReadingAnchor = {
        bookId: audio.id,
        fileId: file.id,
        kind: "audio",
        locator: JSON.stringify({
          version: 1,
          trackId: String(asset.fileId),
          trackTime: 1,
          time: 1,
          manifestRevision: manifest.revision,
        }),
        progress: 1000 / manifest.totalDurationMs,
        updatedAt: new Date().toISOString(),
      };
      await client.saveProgress(position, { operationId: randomUUID() });
      const saved = await client.getProgress(position);
      assert(saved);
      assert.equal(JSON.parse(saved.locator).trackTime, 1);
      const now = new Date().toISOString();
      const note = await client.saveAnnotation({
        id: randomUUID(),
        bookId: audio.id,
        fileId: file.id,
        kind: "audio",
        quote: "Fixture audio note",
        text: "Original narration",
        color: "yellow",
        locator: position.locator,
        createdAt: now,
        updatedAt: now,
      });
      assert(
        (await client.getAudioAnnotations(audio.id, file.id)).some(
          (row) => row.id === note.id,
        ),
      );
      const edited = await client.saveAnnotation({
        ...note,
        text: "Edited audio note",
      });
      assert.equal(edited.text, "Edited audio note");
      await client.deleteAnnotation(audio.id, note.id, "audio");
      assert(
        !(await client.getAudioAnnotations(audio.id, file.id)).some(
          (row) => row.id === note.id,
        ),
      );
    },
  );
  await check("read-only client blocks writes before HTTP", async () => {
    const readOnly = new BookOrbitClient(client.session, {
      fetch: transport,
      readOnly: true,
    });
    const count = requests.length;
    await assert.rejects(() => readOnly.saveProgress(anchor), ReadOnlyError);
    await assert.rejects(
      () => readOnly.createCollection({ name: "Must not exist" }),
      ReadOnlyError,
    );
    await assert.rejects(
      () => readOnly.setReadStatus(epub.id, "read"),
      ReadOnlyError,
    );
    assert.equal(requests.length, count);
  });
  await check(
    "native refresh-token rotation and current-user verification",
    async () => {
      const prior = client.session.refreshToken;
      client.session = {
        ...client.session,
        accessToken: "deliberately-expired-fixture-access-token",
      };
      assert.equal((await client.getCurrentUser()).id, session.userId);
      assert(
        client.session.refreshToken && client.session.refreshToken !== prior,
      );
    },
  );
  await check("fixture sign-out revokes its session", async () => {
    await client.logout();
  });
}
try {
  await main();
} catch (error) {
  report.checks.push({
    name: "fixture bootstrap",
    passed: false,
    detail: error instanceof Error ? error.message : String(error),
  });
  console.error("Fixture bootstrap failed. See the local smoke report.");
}
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
const passed = report.checks.filter((row) => row.passed).length;
console.log(
  `${passed}/${report.checks.length} checks passed. Report: ${reportPath}`,
);
if (report.checks.some((row) => !row.passed)) process.exitCode = 1;
