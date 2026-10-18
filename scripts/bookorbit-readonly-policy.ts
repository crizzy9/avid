/**
 * Request policy for the development proxy, relative to its /bookorbit mount.
 * Authentication is an existing exception. Query/availability POSTs read data;
 * explicitly selected captioned speech produces ephemeral audio, not library edits.
 * Keep exact route matching: no prefix, decoded-path, or arbitrary TTS exemption.
 */
export function allowsReadOnlyBookOrbitRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (method !== "POST") return false;
  const path = (url ?? "").split("?")[0];
  return (
    /^\/api\/v1\/auth\/(login|refresh)$/.test(path) ||
    /^\/api\/v1\/auth\/oidc\/(?:[a-zA-Z0-9_-]+\/state|callback)$/.test(path) ||
    path === "/api/v1/books/query" ||
    /^\/api\/v1\/libraries\/\d+\/books$/.test(path) ||
    /^\/api\/v1\/collections\/\d+\/books\/query$/.test(path) ||
    path === "/api/v1/book-requests/availability" ||
    path === "/api/v1/tts/synthesize/captioned"
  );
}
