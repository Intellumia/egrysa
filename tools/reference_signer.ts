// Reference remote signing service for receipts.
//
// Holds the receipt Ed25519 private key and answers the contract in
// src/signer.ts, so the gateway can run with receiptSigner.kind = "remote"
// and no private key in its own environment. It is the template for an
// adapter in front of an HSM, Vault Transit, or a cloud KMS: replace the
// local sign() with the call into that system and keep everything else.
//
// Usage: EGRYSA_RECEIPT_ED25519_PRIVATE_KEY and EGRYSA_RECEIPT_ED25519_PUBLIC_KEY
// in the environment; optionally EGRYSA_SIGNER_TOKEN, which callers must
// present as "Authorization: Bearer <token>". Listens on 127.0.0.1:11437.

import { constantTimeEqual } from "../src/crypto.ts";
import { createLocalSigner, SIGNER_CONTRACT_VERSION } from "../src/signer.ts";

const signer = await createLocalSigner(
  Deno.env.get("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY") ?? "",
  Deno.env.get("EGRYSA_RECEIPT_ED25519_PUBLIC_KEY") ?? "",
);
const token = Deno.env.get("EGRYSA_SIGNER_TOKEN") ?? "";
const port = Number(Deno.env.get("EGRYSA_SIGNER_PORT") ?? "11437");
let signed = 0;

Deno.serve({ hostname: "127.0.0.1", port }, async (request) => {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (token) {
    const presented = request.headers.get("authorization") ?? "";
    if (!constantTimeEqual(presented, `Bearer ${token}`)) {
      return new Response("unauthorized", { status: 401 });
    }
  }
  const body = await request.json().catch(() => null) as
    | { contractVersion?: unknown; algorithm?: unknown; keyId?: unknown; message?: unknown }
    | null;
  if (
    body?.contractVersion !== SIGNER_CONTRACT_VERSION || body.algorithm !== "Ed25519" ||
    body.keyId !== signer.keyId || typeof body.message !== "string"
  ) return Response.json({ error: "invalid signing request" }, { status: 400 });
  let message: string;
  try {
    message = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(body.message), (char) => char.charCodeAt(0)),
    );
  } catch {
    return Response.json({ error: "message must be base64 UTF-8" }, { status: 400 });
  }
  signed++;
  return Response.json({
    contractVersion: SIGNER_CONTRACT_VERSION,
    keyId: signer.keyId,
    signature: await signer.sign(message),
  });
});
console.log(
  JSON.stringify({ level: "info", event: "signer_listening", port, keyId: signer.keyId }),
);
globalThis.addEventListener("unload", () => {
  console.log(JSON.stringify({ level: "info", event: "signer_stopped", signed }));
});
