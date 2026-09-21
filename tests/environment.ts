import { bytesToBase64 } from "../src/crypto.ts";

let signingKeys: Promise<{ privateKey: string; publicKey: string }> | undefined;

export async function configureTestEnvironment(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  Deno.env.set(
    "EGRYSA_INBOUND_KEYS",
    "test-workload=a-test-client-key-that-is-long-enough",
  );
  Deno.env.set(
    "EGRYSA_RECEIPT_FINGERPRINT_KEY",
    "a-test-fingerprint-key-that-is-at-least-32-characters",
  );
  signingKeys ??= createSigningKeys();
  const keys = await signingKeys;
  Deno.env.set("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY", keys.privateKey);
  Deno.env.set("EGRYSA_RECEIPT_ED25519_PUBLIC_KEY", keys.publicKey);
  return keys;
}

export function testKeys(): Promise<{ privateKey: string; publicKey: string }> {
  return createSigningKeys();
}

async function createSigningKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  return {
    privateKey: bytesToBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: bytesToBase64(await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}
