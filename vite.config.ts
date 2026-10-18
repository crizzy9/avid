import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { offlineShell } from "./scripts/offline-shell";
import { allowsReadOnlyBookOrbitRequest } from "./scripts/bookorbit-readonly-policy";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_BOOKORBIT_PROXY_ORIGIN;
  return {
    root: "apps/web",
    envDir: process.cwd(),
    resolve: {
      conditions: [
        "onnxruntime-web-use-extern-wasm",
        "module",
        "browser",
        "development|production",
      ],
    },
    plugins: [
      react(),
      offlineShell(),
      {
        name: "avid-read-only-test-proxy",
        configureServer(server) {
          if (!target || env.AVID_PROXY_READ_ONLY === "false") return;
          server.middlewares.use("/bookorbit", (req, res, next) => {
            if (allowsReadOnlyBookOrbitRequest(req.method, req.url))
              return next();
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                message:
                  "This development connection is strictly read-only. Server mutations are disabled.",
              }),
            );
          });
        },
      },
    ],
    build: { outDir: "../../dist", emptyOutDir: true },
    worker: { format: "es" },
    server: {
      port: 5173,
      strictPort: true,
      proxy: target
        ? {
            "/bookorbit": {
              target,
              changeOrigin: true,
              cookiePathRewrite: {
                "/api": "/bookorbit/api",
                "/api/v1/auth": "/bookorbit/api/v1/auth",
              },
              rewrite: (path: string) => path.replace(/^\/bookorbit/, ""),
            },
          }
        : undefined,
    },
  };
});
