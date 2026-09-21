// Receipt signing behind an interface, so the private key can live outside
// the gateway process.
//
// The local signer holds an Ed25519 private key from the environment, which
// is where every deployment starts and where the threat model's weakest link
// sits: anyone who can read the process environment can mint receipts that
// verify. The remote signer holds no private key at all. It sends the bytes
// to sign to a signing service over HTTPS, receives a signature, and checks
// that signature against the published public key before using it, so a
// misbehaving or substituted service cannot make the gateway emit a receipt
// that does not verify. The service can be an HSM front end, HashiCorp Vault
// Transit (which offers Ed25519), or a small adapter in front of a cloud KMS;
// AWS KMS and Google Cloud KMS do not offer Ed25519 natively, so an adapter
// there holds the key in the KMS-backed secret store and signs in a hardened
// process, which still keeps the key out of the gateway. The reference
// service in tools/reference_signer.ts implements the contract and is the
// template for such an adapter.
//
// Contract, version 1:
//   POST <url>          headers from an environment variable, "Name: value" per line
//   {"contractVersion":"1","algorithm":"Ed25519","keyId":"<id>","message":"<base64>"}
//   200 {"contractVersion":"1","keyId":"<id>","signature":"<base64>"}
// The message is the UTF-8 bytes of the string the gateway signs; the key id
// is the same identifier the receipts carry, derived from the public key.

import {
  base64ToBytes,
  bytesToBase64,
  ed25519Sign,
  ed25519Verify,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  sha256,
} from "./crypto.ts";

// Raised when a signer cannot produce a signature. The store does not fault
// on it (the chain on disk is intact), and the gateway fails the request
// closed with 503 so a signing outage is visible rather than silent.
export class SigningError extends Error {}

export interface ReceiptSigner {
  readonly keyId: string;
  readonly publicKeySpki: string;
  sign(message: string): Promise<string>;
}

export interface RemoteSignerConfig {
  kind: "remote";
  url: string;
  headersEnv?: string;
  timeoutMs?: number;
}

export interface LocalSignerConfig {
  kind: "local";
}

export type ReceiptSignerConfig = LocalSignerConfig | RemoteSignerConfig;

export const SIGNER_CONTRACT_VERSION = "1";

export async function signingKeyIdentifier(publicKeySpki: string): Promise<string> {
  return (await sha256(`egrysa/ed25519-spki/v1\0${publicKeySpki}`)).slice(0, 24);
}

export function validateReceiptSignerConfig(raw: unknown): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("receiptSigner must be an object");
  }
  const config = raw as Record<string, unknown>;
  if (config.kind === "local") {
    for (const key of Object.keys(config)) {
      if (key !== "kind") throw new Error(`receiptSigner has unknown field: ${key}`);
    }
    return;
  }
  if (config.kind !== "remote") throw new Error("receiptSigner.kind must be local or remote");
  const known = new Set(["kind", "url", "headersEnv", "timeoutMs"]);
  for (const key of Object.keys(config)) {
    if (!known.has(key)) throw new Error(`receiptSigner has unknown field: ${key}`);
  }
  let url: URL;
  try {
    url = new URL(String(config.url));
  } catch {
    throw new Error("receiptSigner.url must be a valid URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("receiptSigner.url must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.username || url.password) throw new Error("receiptSigner.url cannot carry credentials");
  if (config.headersEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(String(config.headersEnv))) {
    throw new Error("receiptSigner.headersEnv must be an environment variable name");
  }
  const timeout = config.timeoutMs;
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > 60_000)
  ) throw new Error("receiptSigner.timeoutMs must be an integer from 100 to 60000");
}

// Proves the signer holds the private half of the published public key. Run
// at startup for both signers, so a remote service with the wrong key is
// refused before the first receipt rather than discovered by an auditor.
async function checkPair(signer: ReceiptSigner): Promise<void> {
  const publicKey = await importEd25519PublicKey(signer.publicKeySpki);
  const proof = await signer.sign("egrysa/signing-key-pair-check/v1");
  if (!await ed25519Verify(publicKey, proof, "egrysa/signing-key-pair-check/v1")) {
    throw new Error("receipt Ed25519 public and private keys do not match");
  }
}

export async function createLocalSigner(
  privateKeyPkcs8: string,
  publicKeySpki: string,
): Promise<ReceiptSigner> {
  const privateKey = await importEd25519PrivateKey(privateKeyPkcs8);
  const signer: ReceiptSigner = {
    keyId: await signingKeyIdentifier(publicKeySpki),
    publicKeySpki,
    sign: (message) => ed25519Sign(privateKey, message),
  };
  await checkPair(signer);
  return signer;
}

function headersFromEnvironment(name: string | undefined): Record<string, string> {
  if (!name) return {};
  const headers: Record<string, string> = {};
  for (const line of (Deno.env.get(name) ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

export async function createRemoteSigner(
  config: RemoteSignerConfig,
  publicKeySpki: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReceiptSigner> {
  const publicKey = await importEd25519PublicKey(publicKeySpki);
  const keyId = await signingKeyIdentifier(publicKeySpki);
  const timeoutMs = config.timeoutMs ?? 5000;
  const encoder = new TextEncoder();
  const signer: ReceiptSigner = {
    keyId,
    publicKeySpki,
    async sign(message) {
      const body = JSON.stringify({
        contractVersion: SIGNER_CONTRACT_VERSION,
        algorithm: "Ed25519",
        keyId,
        message: bytesToBase64(encoder.encode(message).buffer as ArrayBuffer),
      });
      let response: Response;
      try {
        response = await fetchImpl(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersFromEnvironment(config.headersEnv),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new SigningError(`remote signer unreachable: ${(error as Error).message}`);
      }
      const data = await response.json().catch(() => null) as
        | { contractVersion?: unknown; keyId?: unknown; signature?: unknown }
        | null;
      if (!response.ok) {
        throw new SigningError(`remote signer refused to sign (${response.status})`);
      }
      if (
        data?.contractVersion !== SIGNER_CONTRACT_VERSION || data.keyId !== keyId ||
        typeof data.signature !== "string"
      ) throw new SigningError("remote signer returned an invalid response");
      let valid = false;
      try {
        valid = await ed25519Verify(publicKey, data.signature, message);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new SigningError("remote signer returned a signature that does not verify");
      }
      return data.signature;
    },
  };
  await checkPair(signer);
  return signer;
}

export async function createReceiptSigner(
  config: ReceiptSignerConfig | undefined,
  privateKeyPkcs8: string,
  publicKeySpki: string,
): Promise<ReceiptSigner> {
  if (config?.kind === "remote") {
    if (privateKeyPkcs8) {
      throw new Error(
        "EGRYSA_RECEIPT_ED25519_PRIVATE_KEY must not be set when receiptSigner is remote",
      );
    }
    return await createRemoteSigner(config, publicKeySpki);
  }
  return await createLocalSigner(privateKeyPkcs8, publicKeySpki);
}

// Ed25519 signature bytes are always 64; a signer response that is not is
// refused before verification is attempted.
export function plausibleSignature(signature: string): boolean {
  try {
    return base64ToBytes(signature).byteLength === 64;
  } catch {
    return false;
  }
}
