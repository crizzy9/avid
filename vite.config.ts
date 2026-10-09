import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_BOOKORBIT_PROXY_ORIGIN;
  return {
    root: "apps/web",
    envDir: process.cwd(),
    plugins: [
      react(),
      {
        name: "avid-read-only-test-proxy",
        configureServer(server) {
          if (!target || env.AVID_PROXY_READ_ONLY === "false") return;
          server.middlewares.use("/bookorbit", (req, res, next) => {
            const path = (req.url ?? "").split("?")[0];
            const readPost =
              req.method === "POST" &&
              (/^\/api\/v1\/auth\/(login|refresh)$/.test(path) ||
                path === "/api/v1/books/query" ||
                /^\/api\/v1\/libraries\/\d+\/books$/.test(path) ||
                /^\/api\/v1\/collections\/\d+\/books\/query$/.test(path));
            if (req.method === "GET" || req.method === "HEAD" || readPost)
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
