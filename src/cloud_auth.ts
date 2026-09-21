// Credentials for cloud-hosted model providers, built on WebCrypto only.
//
// Bedrock accepts a bearer API key, or an IAM credential pair that must sign
// each request with Signature Version 4. Vertex AI accepts an OAuth access
// token, or a service-account key whose private key signs a JWT that the
// token endpoint exchanges for an access token. Both are implemented here
// with the platform's crypto primitives, because the data plane carries no
// third-party runtime code, and both read secrets only from the environment
// variables the provider configuration names.

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value));
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// Percent-encodes a path segment the way SigV4 canonicalisation requires:
// RFC 3986 unreserved characters only, so a model id such as
// "anthropic.claude-3-5-sonnet-20241022-v2:0" encodes its colon.
export function awsEncodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Signs a request with AWS Signature Version 4 and returns the headers to
// send. The URL's path must already be encoded segment by segment.
export async function signAwsRequest(
  method: string,
  url: URL,
  body: string,
  credentials: AwsCredentials,
  region: string,
  service: string,
  now = new Date(),
): Promise<Headers> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}),
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [awsEncodeSegment(key), awsEncodeSegment(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname || "/",
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  let key: ArrayBuffer = encoder.encode(`AWS4${credentials.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [date, region, service, "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  const result = new Headers(headers);
  result.delete("host");
  result.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
  );
  return result;
}

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

// Builds and signs the JWT a Google service account presents to the token
// endpoint. The private key never leaves this process.
export async function googleServiceAccountAssertion(
  account: GoogleServiceAccount,
  scope: string,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(encoder.encode(JSON.stringify({
    iss: account.client_email,
    scope,
    aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: issuedAt,
    exp: issuedAt + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

// Exchanges a service-account assertion for an access token, cached until a
// minute before it expires. tokenUrl is overridable so a test can stand in
// for Google's endpoint; a deployment leaves it as the account's token_uri.
export async function googleAccessToken(
  account: GoogleServiceAccount,
  tokenUrl = account.token_uri ?? "https://oauth2.googleapis.com/token",
  signal?: AbortSignal,
): Promise<string> {
  const cacheKey = `${account.client_email}\0${tokenUrl}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const assertion = await googleServiceAccountAssertion(
    { ...account, token_uri: tokenUrl },
    "https://www.googleapis.com/auth/cloud-platform",
  );
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`token endpoint rejected the service account (${response.status})`);
  }
  const data = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("token endpoint returned no access token");
  }
  const lifetime = typeof data.expires_in === "number" ? data.expires_in : 3600;
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, lifetime - 60) * 1000,
  });
  return data.access_token;
}

export function clearGoogleTokenCache(): void {
  tokenCache.clear();
}
