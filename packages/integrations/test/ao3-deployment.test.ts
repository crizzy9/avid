import {
  createServer as createHttpsServer,
  request as httpsRequest,
  type Server as HttpsServer,
} from "node:https";
import {
  request as httpRequest,
  type Server,
  type IncomingMessage,
} from "node:http";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Ao3SessionService, createAo3Companion } from "../companion/ao3Server";
import {
  createAo3AccessPolicy,
  normalizeAo3PublicOrigin,
} from "../companion/deployment";
import { greeting, loginForm } from "./fixtures/ao3";

const servers: (Server | HttpsServer)[] = [];
let certificateDirectory: string | undefined;
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (certificateDirectory)
    rmSync(certificateDirectory, { recursive: true, force: true });
  certificateDirectory = undefined;
});
async function listen(server: Server | HttpsServer) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener.");
  return address.port;
}
function request(
  headers: Record<string, string>,
  remote = "127.0.0.1",
  port = 43119,
) {
  return {
    headers,
    socket: { remoteAddress: remote, localPort: port },
  } as unknown as IncomingMessage;
}
function openssl() {
  if (process.env.AVID_TEST_OPENSSL) return process.env.AVID_TEST_OPENSSL;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return "openssl";
  } catch {
    /* Nix exposes tools in immutable package paths. */
  }
  if (existsSync("/nix/store")) {
    const directory = readdirSync("/nix/store").find(
      (name) =>
        /-openssl-[\d.]+-bin$/.test(name) &&
        existsSync(`/nix/store/${name}/bin/openssl`),
    );
    if (directory) return `/nix/store/${directory}/bin/openssl`;
  }
  throw new Error(
    "The local TLS fixture requires OpenSSL (or AVID_TEST_OPENSSL). No TLS verification may be disabled.",
  );
}
describe("explicit AO3 HTTPS deployment", () => {
  it("accepts only canonical HTTPS public origins and exact allowlisted client origins", () => {
    expect(normalizeAo3PublicOrigin("https://ao3-companion.example:8443")).toBe(
      "https://ao3-companion.example:8443",
    );
    for (const origin of [
      "http://ao3.example",
      "https://a.example/",
      "https://a.example/path",
      "https://a.example/../",
      "https://user@a.example",
      "https://a.example?x",
      "https://a.example:0",
      "https://a.example:443",
    ])
      expect(() => normalizeAo3PublicOrigin(origin)).toThrow();
    expect(() => createAo3AccessPolicy(["*"])).toThrow();
    expect(() => createAo3AccessPolicy(["null"])).toThrow();
    expect(() =>
      createAo3AccessPolicy(["https://avid.example/path"]),
    ).toThrow();
    expect(() => createAo3AccessPolicy(["capacitor://evil.example"])).toThrow();
  });
  it("rejects forwarding headers by default and requires configured proxy peer, host and protocol together", () => {
    const local = createAo3AccessPolicy(["https://avid.example"]);
    expect(
      local(
        request({ host: "127.0.0.1:43119", origin: "https://avid.example" }),
      ),
    ).toBe("https://avid.example");
    expect(() =>
      local(
        request({ host: "127.0.0.1:43120", origin: "https://avid.example" }),
      ),
    ).toThrow();
    expect(() =>
      local(
        request({
          host: "127.0.0.1:43119",
          origin: "https://avid.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow();
    const policy = createAo3AccessPolicy(
      ["capacitor://localhost", "https://localhost"],
      {
        publicOrigin: "https://companion.example",
        trustedProxyAddress: "127.0.0.1",
      },
    );
    const headers = {
      host: "companion.example",
      origin: "capacitor://localhost",
      "x-forwarded-host": "companion.example",
      "x-forwarded-proto": "https",
    };
    expect(policy(request(headers, "::ffff:127.0.0.1"))).toBe(
      "capacitor://localhost",
    );
    expect(() => policy(request(headers, "192.168.1.2"))).toThrow();
    const overrides: Record<string, string>[] = [
      { host: "other.example" },
      { "x-forwarded-host": "other.example" },
      { "x-forwarded-proto": "http" },
      { "x-forwarded-proto": "https,http" },
      { forwarded: "proto=https" },
      { origin: "https://unrelated.example" },
      { origin: "null" },
    ];
    for (const override of overrides)
      expect(() => policy(request({ ...headers, ...override }))).toThrow();
  });
  it("runs an ephemeral verified TLS proxy and enforces native-origin pairing before fixture login", async () => {
    certificateDirectory = mkdtempSync(join(tmpdir(), "avid-ao3-tls-"));
    const keyPath = join(certificateDirectory, "key.pem"),
      certPath = join(certificateDirectory, "cert.pem");
    execFileSync(
      openssl(),
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=companion.example",
        "-addext",
        "subjectAltName=DNS:companion.example",
      ],
      { stdio: "ignore" },
    );
    const key = readFileSync(keyPath),
      cert = readFileSync(certPath),
      pairing = "p".repeat(48);
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://archiveofourown.org")
        throw new Error("Unexpected upstream.");
      if (init?.method === "POST")
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/users/reader",
            "Set-Cookie":
              "_otwarchive_session=fixture; Path=/; Secure; HttpOnly",
          },
        });
      return new Response(
        url.pathname === "/users/login" ? loginForm : greeting(),
        { headers: { "Content-Type": "text/html" } },
      );
    });
    const backendPort = await listen(
      createAo3Companion({
        pairingToken: pairing,
        origins: ["capacitor://localhost", "https://localhost"],
        proxy: {
          publicOrigin: "https://companion.example",
          trustedProxyAddress: "127.0.0.1",
        },
        service: new Ao3SessionService({
          fetch: transport,
          minimumIntervalMs: 0,
        }),
      }),
    );
    const tlsPort = await listen(
      createHttpsServer({ key, cert }, (incoming, response) => {
        const headers = {
          ...incoming.headers,
          host: "companion.example",
          "x-forwarded-host": "companion.example",
          "x-forwarded-proto": "https",
        };
        delete headers.forwarded;
        const forwarded = httpRequest(
          {
            hostname: "127.0.0.1",
            port: backendPort,
            path: incoming.url,
            method: incoming.method,
            headers,
          },
          (upstream) => {
            response.writeHead(upstream.statusCode ?? 502, upstream.headers);
            upstream.pipe(response);
          },
        );
        forwarded.on("error", () => {
          response.writeHead(502);
          response.end();
        });
        incoming.pipe(forwarded);
      }),
    );
    const call = (origin: string, bearer = pairing, method = "POST") =>
      new Promise<{
        status: number;
        headers: IncomingMessage["headers"];
        body: string;
      }>((resolve, reject) => {
        const connection = httpsRequest(
          {
            hostname: "127.0.0.1",
            servername: "companion.example",
            port: tlsPort,
            ca: cert,
            rejectUnauthorized: true,
            path: "/v1/session",
            method,
            headers: {
              Origin: origin,
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
              "X-Forwarded-Host": "attacker.example",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (bytes) => chunks.push(bytes));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
            response.on("error", reject);
          },
        );
        connection.on("error", reject);
        connection.end(
          method === "POST"
            ? JSON.stringify({
                login: "reader",
                password: "fixture-only-password",
              })
            : undefined,
        );
      });
    expect((await call("https://unrelated.example")).status).toBe(403);
    expect((await call("capacitor://localhost", "incorrect")).status).toBe(401);
    const preflight = await call("capacitor://localhost", "", "OPTIONS");
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "capacitor://localhost",
    );
    expect(transport).not.toHaveBeenCalled();
    const accepted = await call("capacitor://localhost");
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({ username: "reader" });
    expect(accepted.body).not.toContain("fixture-only-password");
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(
      transport.mock.calls.every(
        ([input]) =>
          new URL(String(input)).origin === "https://archiveofourown.org",
      ),
    ).toBe(true);
    const direct = await fetch(`http://127.0.0.1:${backendPort}/v1/session`, {
      method: "POST",
      headers: {
        Origin: "capacitor://localhost",
        Authorization: `Bearer ${pairing}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(direct.status).toBe(403);
  }, 15_000);
});
