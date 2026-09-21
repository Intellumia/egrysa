import { validateConfig } from "../src/config.ts";
import { ed25519Verify, importEd25519PublicKey } from "../src/crypto.ts";
import { Gateway } from "../src/gateway.ts";
import { ReceiptStore, verifyReceipt } from "../src/receipts.ts";
import { createLocalSigner, createRemoteSigner, SIGNER_CONTRACT_VERSION } from "../src/signer.ts";
import type { AppConfig, PrivacyReceipt } from "../src/types.ts";
import { configureTestEnvironment, testKeys } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";

interface SigningService {
  url: string;
  requests: number;
  mode: "honest" | "garbage" | "down";
  close: () => Promise<void>;
}

async function startSigningService(privateKey: string, publicKey: string): Promise<SigningService> {
  const signer = await createLocalSigner(privateKey, publicKey);
  const service: SigningService = { url: "", requests: 0, mode: "honest", close: async () => {} };
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    service.requests++;
    if (request.headers.get("authorization") !== "Bearer signer-secret") {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await request.json() as { keyId: string; message: string };
    if (service.mode === "down") return new Response("unavailable", { status: 503 });
    const message = new TextDecoder().decode(
      Uint8Array.from(atob(body.message), (char) => char.charCodeAt(0)),
    );
    const signature = service.mode === "honest"
      ? await signer.sign(message)
      : await signer.sign(`${message}-tampered`);
    return Response.json({
      contractVersion: SIGNER_CONTRACT_VERSION,
      keyId: body.keyId,
      signature,
    });
  });
  service.url = `http://127.0.0.1:${await port}/sign`;
  service.close = () => server.shutdown();
  return service;
}

Deno.test("a remote signer signs receipts the public key verifies and its output is checked", async () => {
  const keys = await testKeys();
  const service = await startSigningService(keys.privateKey, keys.publicKey);
  Deno.env.set("SIGNER_TEST_HEADERS", "Authorization: Bearer signer-secret");
  try {
    const signer = await createRemoteSigner(
      { kind: "remote", url: service.url, headersEnv: "SIGNER_TEST_HEADERS", timeoutMs: 2000 },
      keys.publicKey,
    );
    const signature = await signer.sign("hello");
    if (!await ed25519Verify(await importEd25519PublicKey(keys.publicKey), signature, "hello")) {
      throw new Error("remote signature did not verify");
    }
    service.mode = "garbage";
    let refused = false;
    try {
      await signer.sign("hello");
    } catch (error) {
      refused = (error as Error).message.includes("does not verify");
    }
    if (!refused) throw new Error("a bad signature from the service was accepted");
    service.mode = "down";
    let failed = false;
    try {
      await signer.sign("hello");
    } catch (error) {
      failed = (error as Error).message.includes("503");
    }
    if (!failed) throw new Error("an unavailable service did not fail the signing call");
    service.mode = "honest";
    const other = await testKeys();
    let mismatch = false;
    try {
      await createRemoteSigner(
        { kind: "remote", url: service.url, headersEnv: "SIGNER_TEST_HEADERS" },
        other.publicKey,
      );
    } catch (error) {
      mismatch = /do not match|does not verify/.test((error as Error).message);
    }
    if (!mismatch) throw new Error("a service holding the wrong key passed the startup check");
  } finally {
    Deno.env.delete("SIGNER_TEST_HEADERS");
    await service.close();
  }
});

Deno.test("the gateway runs with a remote signer and no private key in its environment", async () => {
  await configureTestEnvironment();
  const privateKey = Deno.env.get("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY")!;
  const publicKey = Deno.env.get("EGRYSA_RECEIPT_ED25519_PUBLIC_KEY")!;
  const service = await startSigningService(privateKey, publicKey);
  Deno.env.set("SIGNER_TEST_HEADERS", "Authorization: Bearer signer-secret");
  Deno.env.delete("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY");
  try {
    const config: AppConfig = testConfig();
    config.receiptSigner = { kind: "remote", url: service.url, headersEnv: "SIGNER_TEST_HEADERS" };
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "Use card 4111 1111 1111 1111" }],
        }),
      }),
    );
    const denied = await response.json() as { receiptId: string };
    if (response.status !== 403) throw new Error(`expected a deny, got ${response.status}`);
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${denied.receiptId}`, {
        headers: { authorization: AUTH },
      }),
    )).json() as PrivacyReceipt;
    if (!await verifyReceipt(receipt, publicKey)) throw new Error("remote-signed receipt failed");
    service.mode = "down";
    const during = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await during.text();
    if (during.status !== 503) {
      throw new Error(`request without a signer should fail closed, got ${during.status}`);
    }
    service.mode = "honest";
    const after = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "Use card 4111 1111 1111 1111" }],
        }),
      }),
    );
    const recovered = await after.json() as { receiptId?: string };
    if (after.status !== 403 || !recovered.receiptId) {
      throw new Error(`store did not recover once the signer returned: ${after.status}`);
    }
    await gateway.close();
  } finally {
    Deno.env.set("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY", privateKey);
    Deno.env.delete("SIGNER_TEST_HEADERS");
    await service.close();
  }
});

Deno.test("a chain suffix from the environment gives each replica its own chain and log", async () => {
  await configureTestEnvironment();
  const dir = await Deno.makeTempDir();
  Deno.env.set("EGRYSA_RECEIPT_CHAIN_SUFFIX", "egrysa-0");
  try {
    const config = testConfig();
    config.receiptLogPath = `${dir}/receipts.jsonl`;
    config.receiptChainId = "pilot";
    const gateway = await Gateway.create(config);
    const checkpoint = await (await gateway.handle(
      new Request("http://gateway/v1/receipts/checkpoint", { headers: { authorization: AUTH } }),
    )).json();
    await gateway.close();
    if (checkpoint.chainId !== "pilot.egrysa-0") {
      throw new Error(`chain id not suffixed: ${checkpoint.chainId}`);
    }
    await Deno.stat(`${dir}/receipts.egrysa-0.jsonl`);
    Deno.env.set("EGRYSA_RECEIPT_CHAIN_SUFFIX", "bad suffix!");
    let refused = false;
    try {
      await Gateway.create(config);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("an invalid suffix was accepted");
  } finally {
    Deno.env.delete("EGRYSA_RECEIPT_CHAIN_SUFFIX");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("receipt signer configuration is validated and the store accepts an explicit signer", async () => {
  for (
    const bad of [
      { kind: "kms" },
      { kind: "remote", url: "http://signer.internal/sign" },
      { kind: "remote", url: "https://signer.internal/sign", timeoutMs: 1 },
      { kind: "local", url: "https://x" },
    ] as never[]
  ) {
    const config = testConfig();
    config.receiptSigner = bad;
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
  const keys = await testKeys();
  const dir = await Deno.makeTempDir();
  try {
    const store = await ReceiptStore.open({
      fingerprintKey: "fingerprint-key-that-is-long-enough-for-tests",
      signer: await createLocalSigner(keys.privateKey, keys.publicKey),
      publicKeySpki: keys.publicKey,
      chainId: "explicit-signer",
      logPath: `${dir}/receipts.jsonl`,
      capacity: 10,
      maxLogBytes: 1024 * 1024,
    });
    const receipt = await store.create({
      requestCanonical: "{}",
      workloadId: "w",
      decision: "allow_raw",
      provider: "local",
      model: "m",
      findings: [],
      transformedFields: 0,
    });
    await store.close();
    if (!await verifyReceipt(receipt, keys.publicKey)) throw new Error("receipt did not verify");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
