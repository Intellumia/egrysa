// OpenID Connect bearer tokens as an alternative to static workload keys.
//
// A static key per workload is the right control for a service that has no
// identity provider; an enterprise has one, and wants the gateway to trust
// the tokens it already issues. This verifies a JWT from a configured issuer
// against the issuer's published keys, checks issuer, audience, and time,
// and maps a claim to the workload id the rest of the gateway already keys
// policy, receipts, and rate limits on. A second claim can mark the caller
// as an auditor.
//
// Keys are fetched from the issuer's JWKS, discovered through the OpenID
// configuration document unless a JWKS URL is given, cached, and refreshed
// at most once a minute when a token names an unknown key id. Only RS256
// and ES256 are accepted. Everything is WebCrypto.

import type { Role } from "./auth.ts";

export interface OidcConfig {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  workloadClaim?: string;
  roleClaim?: string;
  auditorRole?: string;
  clockSkewSeconds?: number;
  jwksTtlSeconds?: number;
}

export interface ResolvedOidcConfig {
  issuer: string;
  audience: string;
  jwksUrl: string | null;
  workloadClaim: string;
  roleClaim: string | null;
  auditorRole: string;
  clockSkewSeconds: number;
  jwksTtlSeconds: number;
}

export function resolveOidcConfig(raw: OidcConfig): ResolvedOidcConfig {
  return {
    issuer: raw.issuer,
    audience: raw.audience,
    jwksUrl: raw.jwksUrl ?? null,
    workloadClaim: raw.workloadClaim ?? "sub",
    roleClaim: raw.roleClaim ?? null,
    auditorRole: raw.auditorRole ?? "egrysa:auditor",
    clockSkewSeconds: raw.clockSkewSeconds ?? 60,
    jwksTtlSeconds: raw.jwksTtlSeconds ?? 3600,
  };
}

const WORKLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLAIM_NAME = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/;

export function validateOidcConfig(raw: unknown): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("oidc must be an object");
  }
  const config = raw as Record<string, unknown>;
  const known = new Set([
    "issuer",
    "audience",
    "jwksUrl",
    "workloadClaim",
    "roleClaim",
    "auditorRole",
    "clockSkewSeconds",
    "jwksTtlSeconds",
  ]);
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`oidc has unknown field: ${key}`);
  }
  for (const key of ["issuer", "jwksUrl"] as const) {
    const value = config[key];
    if (value === undefined && key === "jwksUrl") continue;
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      throw new Error(`oidc.${key} must be a valid URL`);
    }
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`oidc.${key} must use HTTPS; HTTP is allowed only on loopback`);
    }
    if (url.username || url.password || url.hash) {
      throw new Error(`oidc.${key} cannot carry credentials or a fragment`);
    }
  }
  if (typeof config.audience !== "string" || !config.audience) {
    throw new Error("oidc.audience is required");
  }
  for (const key of ["workloadClaim", "roleClaim", "auditorRole"] as const) {
    const value = config[key];
    if (value !== undefined && (typeof value !== "string" || !CLAIM_NAME.test(value))) {
      throw new Error(`oidc.${key} must be a claim name`);
    }
  }
  for (
    const [key, low, high] of [["clockSkewSeconds", 0, 600], [
      "jwksTtlSeconds",
      60,
      86_400,
    ]] as const
  ) {
    const value = config[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (value as number) < low || (value as number) > high)
    ) {
      throw new Error(`oidc.${key} must be an integer from ${low} to ${high}`);
    }
  }
}

export interface OidcIdentity {
  workloadId: string;
  role: Role;
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// True when a bearer credential has the shape of a JWT, so the caller can
// decide whether to try OIDC after the static keys did not match.
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) && token.length < 16_384;
}

export class OidcVerifier {
  #keys = new Map<string, CryptoKey>();
  #jwksUrl: string | null;
  #fetchedAt = 0;
  #lastRefreshAttempt = 0;
  #loading: Promise<void> | null = null;

  constructor(
    readonly settings: ResolvedOidcConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.#jwksUrl = settings.jwksUrl;
  }

  async #discoverJwks(): Promise<string> {
    if (this.#jwksUrl) return this.#jwksUrl;
    const base = this.settings.issuer.replace(/\/$/, "");
    const response = await this.fetchImpl(`${base}/.well-known/openid-configuration`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const document = await response.json().catch(() => null) as { jwks_uri?: unknown } | null;
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok || typeof document?.jwks_uri !== "string") {
      throw new Error("OpenID configuration did not provide jwks_uri");
    }
    this.#jwksUrl = document.jwks_uri;
    return document.jwks_uri;
  }

  async #loadKeys(): Promise<void> {
    const url = await this.#discoverJwks();
    const response = await this.fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const document = await response.json().catch(() => null) as { keys?: unknown } | null;
    if (!response.ok || !Array.isArray(document?.keys)) throw new Error("JWKS unavailable");
    const keys = new Map<string, CryptoKey>();
    for (const candidate of document.keys as Jwk[]) {
      if (!candidate || typeof candidate !== "object" || !candidate.kid) continue;
      if (candidate.use !== undefined && candidate.use !== "sig") continue;
      try {
        if (candidate.kty === "RSA" && (candidate.alg === undefined || candidate.alg === "RS256")) {
          keys.set(
            candidate.kid,
            await crypto.subtle.importKey(
              "jwk",
              candidate as JsonWebKey,
              { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
              false,
              ["verify"],
            ),
          );
        } else if (candidate.kty === "EC" && candidate.crv === "P-256") {
          keys.set(
            candidate.kid,
            await crypto.subtle.importKey(
              "jwk",
              candidate as JsonWebKey,
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["verify"],
            ),
          );
        }
      } catch {
        // A key the platform cannot import is a key that cannot verify a token.
      }
    }
    this.#keys = keys;
    this.#fetchedAt = this.now();
  }

  async #key(kid: string): Promise<CryptoKey | null> {
    const stale = this.now() - this.#fetchedAt > this.settings.jwksTtlSeconds * 1000;
    const missing = !this.#keys.has(kid);
    const refreshAllowed = this.now() - this.#lastRefreshAttempt > 60_000;
    if ((stale || (missing && refreshAllowed)) && !this.#loading) {
      this.#lastRefreshAttempt = this.now();
      this.#loading = this.#loadKeys().finally(() => this.#loading = null);
    }
    if (this.#loading) {
      try {
        await this.#loading;
      } catch {
        // Keep whatever was cached; the token may still verify.
      }
    }
    return this.#keys.get(kid) ?? null;
  }

  // Returns the identity a valid token carries, or null. Never throws: an
  // unverifiable token is an unauthenticated request, whatever the reason.
  async authorize(token: string): Promise<OidcIdentity | null> {
    if (!looksLikeJwt(token)) return null;
    const [headerPart, payloadPart, signaturePart] = token.split(".") as [string, string, string];
    const header = parseJson(base64UrlDecode(headerPart));
    const payload = parseJson(base64UrlDecode(payloadPart));
    if (!header || !payload) return null;
    const alg = header.alg;
    const kid = header.kid;
    if ((alg !== "RS256" && alg !== "ES256") || typeof kid !== "string" || !kid) return null;
    let key: CryptoKey | null;
    try {
      key = await this.#key(kid);
    } catch {
      return null;
    }
    if (!key) return null;
    const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const signature = base64UrlDecode(signaturePart);
    if (alg === "ES256" && signature.length !== 64) return null;
    let valid = false;
    try {
      valid = alg === "RS256"
        ? await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data)
        : await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, data);
    } catch {
      valid = false;
    }
    if (!valid) return null;
    const nowSeconds = Math.floor(this.now() / 1000);
    const skew = this.settings.clockSkewSeconds;
    if (payload.iss !== this.settings.issuer) return null;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.settings.audience)) return null;
    if (typeof payload.exp !== "number" || payload.exp + skew < nowSeconds) return null;
    if (typeof payload.nbf === "number" && payload.nbf - skew > nowSeconds) return null;
    if (typeof payload.iat === "number" && payload.iat - skew > nowSeconds) return null;
    const workloadId = payload[this.settings.workloadClaim];
    if (typeof workloadId !== "string" || !WORKLOAD_ID.test(workloadId)) return null;
    let role: Role = "caller";
    if (this.settings.roleClaim) {
      const roles = payload[this.settings.roleClaim];
      const list = Array.isArray(roles) ? roles : typeof roles === "string" ? roles.split(" ") : [];
      if (list.includes(this.settings.auditorRole)) role = "auditor";
    }
    return { workloadId, role };
  }
}
