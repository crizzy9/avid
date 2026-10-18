import { describe, it, expect } from "vitest";
import { allowsReadOnlyBookOrbitRequest as allowed } from "./bookorbit-readonly-policy";
describe("BookOrbit read-only development proxy policy", () => {
  it.each([
    "/api/v1/book-requests/availability",
    "/api/v1/tts/synthesize/captioned",
  ])("allows the verified explicit read operation %s", (path) => {
    expect(allowed("POST", path)).toBe(true);
    expect(allowed("POST", `${path}?client=avid`)).toBe(true);
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", undefined])
      expect(allowed(method, path)).toBe(false);
  });
  it.each([
    "/api/v1/book-requests",
    "/api/v1/book-requests/pairs",
    "/api/v1/book-requests/1/approve",
    "/api/v1/books/files/1/progress",
    "/api/v1/books/1/annotations",
    "/api/v1/books/1/status",
    "/api/v1/books/1/audiobook/state",
    "/api/v1/collections/1/books",
    "/api/v1/books/upload",
    "/api/v1/tts/preferences",
    "/api/v1/tts/preferences/book/1",
    "/api/v1/tts/position/1",
    "/api/v1/tts/synthesize",
    "/api/v1/tts/preview",
  ])("keeps mutations and unapproved adjacent routes blocked: %s", (path) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(allowed(method, path), `${method} ${path}`).toBe(false);
  });
  it("requires exact safe paths rather than prefix, suffix or decoded-path matching", () => {
    for (const path of [
      "/api/v1/book-requests/availability/approve",
      "/api/v1/book-requests/availability/",
      "/api/v1/book-requests/availability/../pairs",
      "/api/v1/book-requests/%61vailability",
      "/api/v1/tts/synthesize/captioned/preferences",
      "/api/v1/tts/synthesize/captioned#fragment",
      "/api/v1/tts/synthesize/captioned%3fignored",
      "/api/v1/tts/synthesize//captioned",
      "https://server.example/api/v1/tts/synthesize/captioned",
      "/bookorbit/api/v1/tts/synthesize/captioned",
      undefined,
    ])
      expect(allowed("POST", path), path).toBe(false);
  });
  it("preserves existing authentication and bounded catalogue query exceptions", () => {
    for (const path of [
      "/api/v1/auth/login",
      "/api/v1/auth/refresh",
      "/api/v1/auth/oidc/example-provider/state",
      "/api/v1/auth/oidc/callback",
      "/api/v1/books/query",
      "/api/v1/libraries/12/books",
      "/api/v1/collections/23/books/query",
    ])
      expect(allowed("POST", path), path).toBe(true);
    expect(allowed("POST", "/api/v1/auth/oidc/provider/settings")).toBe(false);
    expect(allowed("POST", "/api/v1/libraries/name/books")).toBe(false);
    expect(allowed("POST", undefined)).toBe(false);
  });
  it("continues to permit GET and HEAD metadata reads without broadening write verbs", () => {
    for (const method of ["GET", "HEAD"])
      for (const path of [
        "/api/v1/book-requests",
        "/api/v1/tts/providers",
        "/api/v1/tts/voices",
      ])
        expect(allowed(method, path)).toBe(true);
  });
});
