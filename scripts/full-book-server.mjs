// Explicit local-only production fixture. No .env or BookOrbit connection is loaded.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import {
  readFile,
  stat,
  mkdir,
  writeFile,
  rename,
  readdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { resolve, relative, extname, sep } from "node:path";
import { execFileSync } from "node:child_process";
import {
  fullBookAsset,
  safeReportName,
  sourceProof,
  hash,
} from "./full-book-support.mjs";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--corpus") || !process.argv.includes("--output"))
  throw Error("Provide --corpus and --output directories.");
const root = process.cwd(),
  corpus = resolve(arg("--corpus")),
  output = resolve(arg("--output"));
const port = process.argv.includes("--port") ? Number(arg("--port")) : 5184;
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid local port.");
const baseline = "654db63";
const proof = sourceProof(root, baseline);
if (proof.some((item) => !item.matchesBaseline))
  throw Error(
    "Production preparation sources differ from baseline; no baseline run started.",
  );
const commit =
  process.env.AVID_SOURCE_COMMIT ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
await mkdir(output, { recursive: true });
await mkdir(resolve(output, "fixture-run")); // Reserve once; retry into a new output directory.
const fixtureFiles = [
  "scripts/full-book-server.mjs",
  "scripts/full-book-support.mjs",
  "scripts/run-full-book-browser.mjs",
  "scripts/run-full-book-suite.mjs",
  "packages/readers/fixtures/full-book-harness.tsx",
  "packages/readers/fixtures/full-book.html",
];
const harnessProof = await Promise.all(
  fixtureFiles.map(async (path) => ({
    path,
    sha256: hash(await readFile(resolve(root, path))),
  })),
);
const modelRoot = process.env.AVID_MODEL_CACHE ?? "/tmp/avid-speech-models";
const model = {
  id: "Xenova/whisper-base.en",
  revision: "95bf40a508535962c6483ead40270b2e32267508",
};
const modelFiles = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer_config.json",
  "tokenizer.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];
const cachedModels = [];
for (const name of modelFiles) {
  const path = resolve(modelRoot, model.id, model.revision, name);
  try {
    const bytes = await readFile(path);
    cachedModels.push({
      name,
      path,
      sha256: hash(bytes),
      sizeBytes: bytes.length,
      url: `https://huggingface.co/${model.id}/resolve/${model.revision}/${name}`,
    });
  } catch {
    /* Missing assets use the production worker's normal public model request. */
  }
}
const manifestBytes = await readFile(resolve(corpus, "manifest.json"));
const corpusManifestSha256 = hash(manifestBytes);
const frozenManifest = JSON.parse(manifestBytes.toString("utf8"));
const manifest = async () => frozenManifest;
// A bundled fixture has no HMR, dependency discovery, live repository reload or user config.
const site = resolve(output, "site");
await build({
  configFile: false,
  envFile: false,
  root,
  publicDir: resolve(root, "apps/web/public"),
  plugins: [react()],
  resolve: {
    conditions: [
      "onnxruntime-web-use-extern-wasm",
      "module",
      "browser",
      "development|production",
    ],
  },
  worker: { format: "es" },
  build: {
    outDir: site,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, "packages/readers/fixtures/full-book.html"),
    },
  },
});
async function builtFiles(directory) {
  const items = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) items.push(...(await builtFiles(path)));
    else {
      const bytes = await readFile(path);
      items.push({
        path: relative(site, path),
        bytes: bytes.length,
        sha256: hash(bytes),
      });
    }
  }
  return items;
}
const buildProof = await builtFiles(site);
if (JSON.stringify(sourceProof(root, baseline)) !== JSON.stringify(proof))
  throw Error("Preparation sources changed during bundling.");
for (const item of harnessProof)
  if (hash(await readFile(resolve(root, item.path))) !== item.sha256)
    throw Error("Harness changed during bundling.");
await writeFile(
  resolve(output, "build-proof.json"),
  JSON.stringify(
    {
      commit,
      baseline,
      corpusManifestSha256,
      sourceProof: proof,
      harnessProof,
      buildProof,
    },
    null,
    2,
  ) + "\n",
);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg",
  ".svg": "image/svg+xml",
};
async function stream(path, res) {
  const info = await stat(path);
  if (!info.isFile()) throw Error("Not a file.");
  res.setHeader("Content-Length", info.size);
  res.setHeader(
    "Content-Type",
    types[extname(path)] ?? "application/octet-stream",
  );
  res.setHeader("Cache-Control", "no-store");
  createReadStream(path)
    .on("error", () => res.destroy())
    .pipe(res);
}
let writeSerial = 0;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (
      req.headers.host !== `127.0.0.1:${port}` ||
      (req.headers.origin && req.headers.origin !== url.origin)
    ) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/__fullbook/config") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          corpus: await manifest(),
          corpusManifestSha256,
          commit,
          baseline,
          sourceProof: proof,
          harnessProof,
          buildProof,
          model,
          modelCache: cachedModels.map(({ path, ...item }, i) => ({
            ...item,
            localUrl: `/__fullbook/model/${i}`,
          })),
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/__fullbook/asset") {
      await stream(
        fullBookAsset(
          corpus,
          await manifest(),
          url.searchParams.get("book"),
          url.searchParams.get("kind"),
          url.searchParams.get("index"),
        ),
        res,
      );
      return;
    }
    if (
      req.method === "GET" &&
      /^\/__fullbook\/model\/\d+$/.test(url.pathname)
    ) {
      const item = cachedModels[Number(url.pathname.split("/").at(-1))];
      if (!item) throw Error("Unknown model asset.");
      await stream(item.path, res);
      return;
    }
    if (
      req.method === "POST" &&
      ["/__fullbook/report", "/__fullbook/artifact"].includes(url.pathname)
    ) {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw Error("JSON required.");
      const name = safeReportName(url.searchParams.get("name")),
        chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (url.pathname.endsWith("artifact") ? 128 : 32) * 1024 * 1024)
          throw Error("Harness evidence size limit exceeded.");
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const directory = resolve(
        output,
        url.pathname.endsWith("artifact") ? "artifacts" : "reports",
      );
      await mkdir(directory, { recursive: true });
      const target = resolve(directory, name + ".json"),
        temp = target + "." + ++writeSerial + ".tmp";
      await writeFile(temp, JSON.stringify(data, null, 2) + "\n");
      await rename(temp, target);
      res.setHeader("Content-Type", "application/json");
      res.end('{"saved":true}');
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end("Unsupported fixture operation.");
      return;
    }
    const pathname = decodeURIComponent(
      url.pathname === "/"
        ? "/packages/readers/fixtures/full-book.html"
        : url.pathname,
    );
    const path = resolve(site, "." + pathname);
    if (!path.startsWith(site + sep)) throw Error("Path outside fixture.");
    await stream(path, res);
  } catch (error) {
    res.statusCode = 400;
    res.end(String(error));
  }
});
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Full-book fixture: http://127.0.0.1:${port}/packages/readers/fixtures/full-book.html\nReports: ${output}; bundled production baseline matches.`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit()));
