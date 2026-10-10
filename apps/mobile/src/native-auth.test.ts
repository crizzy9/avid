import { describe, expect, it, vi } from "vitest";
import {
  createNativeAuthFetch,
  createNativeSessionRefresh,
  nativeAuthScope,
  type NativeAuthPlugin,
} from "./native-auth";
import type { Session } from "../../../packages/core/src/types";
import type { NativeSessionRecord } from "./native-session";

const session: Session = {
  profile: {
    id: "books",
    name: "Books",
    url: "https://BOOKS.test/base/api/v1/",
  },
  userId: "7",
  accessToken: "old",
  clientKind: "web",
};
const record: NativeSessionRecord = {
  generation: "native-generation",
  readOnly: true,
  session: {
    ...session,
    profile: { ...session.profile, url: "https://books.test/base" },
    accessToken: "new",
  },
};
function fixture() {
  const plugin = {
    refresh: vi
      .fn<NativeAuthPlugin["refresh"]>()
      .mockResolvedValue(structuredClone(record)),
    authenticate: vi
      .fn<NativeAuthPlugin["authenticate"]>()
      .mockResolvedValue({
        status: 200,
        body: { accessToken: "fixture", user: { id: 7, username: "reader" } },
      }),
    addListener: vi
      .fn<NativeAuthPlugin["addListener"]>()
      .mockResolvedValue({ remove: async () => {} }),
  } satisfies NativeAuthPlugin;
  const onRecord =
    vi.fn<(value: NativeSessionRecord) => void | Promise<void>>();
  const fallback = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ ok: true }));
  return { plugin, onRecord, fallback };
}
describe("native refresh adapter", () => {
  it("requests an exact account scope and awaits cursor adoption before returning credentials", async () => {
    const f = fixture();
    let finish!: () => void;
    f.onRecord.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createNativeSessionRefresh(f);
    let completed = false;
    const pending = refresh(session).then((value) => {
      completed = true;
      return value;
    });
    await vi.waitFor(() => expect(f.onRecord).toHaveBeenCalledTimes(1));
    expect(f.plugin.refresh).toHaveBeenCalledWith({
      accountScope: '["https://books.test/base","7"]',
      force: true,
    });
    expect(completed).toBe(false);
    finish();
    expect((await pending).accessToken).toBe("new");
    expect(f.onRecord.mock.calls[0][0].readOnly).toBe(true);
  });
  it.each([
    { ...record, session: { ...record.session!, userId: "other" } },
    {
      ...record,
      session: {
        ...record.session!,
        profile: { ...session.profile, url: "https://other.test" },
      },
    },
    {
      ...record,
      session: {
        ...record.session!,
        profile: { ...session.profile, id: "other" },
      },
    },
    {
      ...record,
      session: { ...record.session!, clientKind: "native" as const },
    },
    { generation: "empty" },
  ])(
    "rejects wrong-account and cleared-vault results before adoption",
    async (next) => {
      const f = fixture();
      f.plugin.refresh.mockResolvedValue(next);
      await expect(
        createNativeSessionRefresh(f)(session),
      ).rejects.toMatchObject({ status: 401 });
      expect(f.onRecord).not.toHaveBeenCalled();
    },
  );
  it("propagates native failures and cursor-adoption failures without another refresh", async () => {
    const f = fixture();
    f.plugin.refresh.mockRejectedValueOnce(new Error("Vault changed"));
    const refresh = createNativeSessionRefresh(f);
    await expect(refresh(session)).rejects.toThrow("Vault changed");
    f.onRecord.mockRejectedValueOnce(new Error("Stale record"));
    await expect(refresh(session)).rejects.toThrow("Stale record");
    expect(f.plugin.refresh).toHaveBeenCalledTimes(2);
  });
});
describe("generation-bound native authentication transport", () => {
  it.each(["login", "oidc/callback"] as const)(
    "isolates %s cookies behind the originally captured generation",
    async (path) => {
      const f = fixture(),
        fetch = createNativeAuthFetch(
          "captured-generation",
          f.fallback,
          f.plugin,
        );
      const body = JSON.stringify(
        path === "login"
          ? { username: "reader", password: "fixture" }
          : { code: "fixture-code", state: "fixture-state" },
      );
      const result = await fetch(
        `https://books.test/base/api/v1/auth/${path}`,
        { method: "POST", body, credentials: "include" },
      );
      expect(f.plugin.authenticate).toHaveBeenCalledWith({
        expectedGeneration: "captured-generation",
        serverUrl: "https://books.test/base",
        path,
        body,
      });
      expect(await result.json()).toMatchObject({ accessToken: "fixture" });
      expect(f.fallback).not.toHaveBeenCalled();
    },
  );
  it("passes ordinary read requests through without touching the native authentication bridge", async () => {
    const f = fixture(),
      fetch = createNativeAuthFetch("captured", f.fallback, f.plugin);
    await fetch("https://books.test/api/v1/auth/login-options", {
      credentials: "include",
    });
    expect(f.fallback).toHaveBeenCalledTimes(1);
    expect(f.plugin.authenticate).not.toHaveBeenCalled();
  });
  it("never falls back to a global-cookie login after a stale-generation native rejection", async () => {
    const f = fixture(),
      fetch = createNativeAuthFetch("old-generation", f.fallback, f.plugin);
    f.plugin.authenticate.mockRejectedValue(new Error("Generation changed"));
    await expect(
      fetch("https://books.test/api/v1/auth/login", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("Generation changed");
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it.each([
    "/bookorbit/api/v1/auth/login",
    "https://books.test/api/v1/auth/login?extra=1",
  ])("rejects ambiguous native authentication routes: %s", async (url) => {
    const f = fixture(),
      fetch = createNativeAuthFetch("captured", f.fallback, f.plugin);
    await expect(
      fetch(url, { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.plugin.authenticate).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("retains error responses for the core contract parser without exposing cookie headers", async () => {
    const f = fixture(),
      fetch = createNativeAuthFetch("captured", f.fallback, f.plugin);
    f.plugin.authenticate.mockResolvedValue({
      status: 401,
      body: { message: "Invalid credentials" },
    });
    const response = await fetch("https://books.test/api/v1/auth/login", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Invalid credentials" });
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });
  it("uses both server and user identity in the callback scope", () => {
    expect(nativeAuthScope(session)).not.toBe(
      nativeAuthScope({ ...session, userId: "8" }),
    );
    expect(nativeAuthScope(session)).not.toBe(
      nativeAuthScope({
        ...session,
        profile: { ...session.profile, url: "https://elsewhere.test" },
      }),
    );
  });
});
