import { validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { OidcVerifier, resolveOidcConfig } from "../src/oidc.ts";
import type { AppConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Issuer {
  issuer: string;
  jwks: { keys: JsonWebKey[] };
  sign: (claims: Record<string, unknown>, kid?: string, alg?: "RS256" | "ES256") => Promise<string>;
  close: () => Promise<void>;
  requests: string[];
}

async function startIssuer(): Promise<Issuer> {
  const rsa = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const ec = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const rsaJwk = {
    ...await crypto.subtle.exportKey("jwk", rsa.publicKey),
    kid: "rsa-1",
    use: "sig",
    alg: "RS256",
  };
  const ecJwk = { ...await crypto.subtle.exportKey("jwk", ec.publicKey), kid: "ec-1", use: "sig" };
  delete (rsaJwk as Record<string, unknown>).key_ops;
  delete (ecJwk as Record<string, unknown>).key_ops;
  const jwks = { keys: [rsaJwk, ecJwk] as JsonWebKey[] };
  const requests: string[] = [];
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let issuer = "";
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, (request) => {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (url.pathname === "/.well-known/openid-configuration") {
      return Response.json({ issuer, jwks_uri: `${issuer}/keys` });
    }
    if (url.pathname === "/keys") return Response.json(jwks);
    return new Response("not found", { status: 404 });
  });
  issuer = `http://127.0.0.1:${await port}`;
  const sign = async (
    claims: Record<string, unknown>,
    kid = "rsa-1",
    alg: "RS256" | "ES256" = "RS256",
  ) => {
    const header = base64Url(encoder.encode(JSON.stringify({ alg, typ: "JWT", kid })));
    const payload = base64Url(encoder.encode(JSON.stringify(claims)));
    const data = encoder.encode(`${header}.${payload}`);
    const signature = alg === "RS256"
      ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, data)
      : await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, data);
    return `${header}.${payload}.${base64Url(signature)}`;
  };
  return { issuer, jwks, sign, requests, close: () => server.shutdown() };
}

function claims(issuer: Issuer, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer.issuer,
    aud: "egrysa",
    sub: "finance-app",
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

Deno.test("OIDC tokens verify against discovered keys and map claims to a workload and role", async () => {
  const issuer = await startIssuer();
  try {
    const verifier = new OidcVerifier(resolveOidcConfig({
      issuer: issuer.issuer,
      audience: "egrysa",
      roleClaim: "roles",
      auditorRole: "egrysa:auditor",
    }));
    const caller = await verifier.authorize(await issuer.sign(claims(issuer)));
    const auditor = await verifier.authorize(
      await issuer.sign(claims(issuer, { sub: "audit-team", roles: ["reader", "egrysa:auditor"] })),
    );
    const ecCaller = await verifier.authorize(
      await issuer.sign(claims(issuer, { sub: "ec-app" }), "ec-1", "ES256"),
    );
    if (caller?.workloadId !== "finance-app" || caller.role !== "caller") {
      throw new Error("caller token failed");
    }
    if (auditor?.workloadId !== "audit-team" || auditor.role !== "auditor") {
      throw new Error("auditor token failed");
    }
    if (ecCaller?.workloadId !== "ec-app") throw new Error("ES256 token failed");
    const jwksFetches = issuer.requests.filter((path) => path === "/keys").length;
    if (jwksFetches !== 1) {
      throw new Error(`JWKS fetched ${jwksFetches} times; expected one cached fetch`);
    }
    const rejected: Array<[string, string]> = [
      ["expired", await issuer.sign(claims(issuer, { exp: Math.floor(Date.now() / 1000) - 600 }))],
      ["wrong audience", await issuer.sign(claims(issuer, { aud: "other" }))],
      ["wrong issuer", await issuer.sign(claims(issuer, { iss: "https://evil.example" }))],
      ["unknown kid", await issuer.sign(claims(issuer), "rsa-9")],
      ["bad workload id", await issuer.sign(claims(issuer, { sub: "not valid!" }))],
      ["tampered", (await issuer.sign(claims(issuer))).replace(/\.[^.]+$/, ".AAAA")],
      ["not a jwt", "a-static-looking-key-that-is-long-enough"],
    ];
    for (const [name, token] of rejected) {
      if (await verifier.authorize(token) !== null) throw new Error(`${name} token was accepted`);
    }
  } finally {
    await issuer.close();
  }
});

Deno.test("the gateway accepts an OIDC bearer for a workload and applies its policy and receipts", async () => {
  await configureTestEnvironment();
  const issuer = await startIssuer();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, () =>
    Response.json({
      id: "p",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
  try {
    const config: AppConfig = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    config.oidc = { issuer: issuer.issuer, audience: "egrysa", roleClaim: "roles" };
    config.workloads = { "finance-app": { sensitivity: "strict" } };
    const gateway = await Gateway.create(config);
    const token = await issuer.sign(claims(issuer));
    const response = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "Summarise." }],
        }),
      }),
    );
    await response.text();
    if (response.status !== 200) throw new Error(`OIDC caller refused: ${response.status}`);
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${response.headers.get("x-egrysa-receipt")}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )).json();
    if (receipt.workloadId !== "finance-app") {
      throw new Error("receipt not attributed to the token's workload");
    }
    const auditorToken = await issuer.sign(
      claims(issuer, { sub: "audit-team", roles: ["egrysa:auditor"] }),
    );
    const asAuditor = await gateway.handle(
      new Request(`http://gateway/v1/receipts/${receipt.id}`, {
        headers: { authorization: `Bearer ${auditorToken}` },
      }),
    );
    await asAuditor.text();
    if (asAuditor.status !== 200) throw new Error("OIDC auditor could not read the receipt");
    const staticKey = await gateway.handle(
      new Request("http://gateway/v1/models", {
        headers: { authorization: "Bearer a-test-client-key-that-is-long-enough" },
      }),
    );
    await staticKey.text();
    if (staticKey.status !== 200) throw new Error("static keys stopped working alongside OIDC");
    const expired = await gateway.handle(
      new Request("http://gateway/v1/models", {
        headers: { authorization: `Bearer ${await issuer.sign(claims(issuer, { exp: 1 }))}` },
      }),
    );
    await expired.text();
    if (expired.status !== 401) throw new Error("expired token was accepted");
    await gateway.close();
  } finally {
    await provider.shutdown();
    await issuer.close();
  }
});

Deno.test("OIDC configuration is validated", () => {
  for (
    const bad of [
      { issuer: "http://idp.example", audience: "a" },
      { issuer: "https://idp.example", audience: "" },
      { issuer: "https://idp.example", audience: "a", workloadClaim: "bad claim" },
      { issuer: "https://idp.example", audience: "a", clockSkewSeconds: 10_000 },
      { issuer: "https://idp.example", audience: "a", extra: 1 },
    ] as never[]
  ) {
    const config = testConfig();
    config.oidc = bad;
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
  const good = testConfig();
  good.oidc = {
    issuer: "https://idp.example",
    audience: "egrysa",
    jwksUrl: "https://idp.example/keys",
  };
  validateConfig(good);
});
