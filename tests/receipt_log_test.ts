// The offline receipt-log verifier, which the restore runbook depends on.

import { ReceiptLogError, verifyReceiptLog } from "../src/receipt_log.ts";
import { ReceiptStore } from "../src/receipts.ts";
import { testKeys } from "./environment.ts";

const fixtures = new URL("fixtures/receipts-alpha5/", import.meta.url);

async function fixture(): Promise<{ text: string; publicKey: string; chainId: string }> {
  const keys = JSON.parse(await Deno.readTextFile(new URL("keys.json", fixtures))) as {
    publicKeySpki: string;
    chainId: string;
  };
  return {
    text: await Deno.readTextFile(new URL("receipts.jsonl", fixtures)),
    publicKey: keys.publicKeySpki,
    chainId: keys.chainId,
  };
}

Deno.test("a restored receipt log verifies end to end and reports its head", async () => {
  const { text, publicKey, chainId } = await fixture();
  const summary = await verifyReceiptLog(text, publicKey, chainId);
  if (summary.receipts !== 4 || summary.head.sequence !== 4 || summary.chainId !== chainId) {
    throw new Error(`unexpected summary ${JSON.stringify(summary)}`);
  }
  if (Object.keys(summary.versions).sort().join(",") !== "2,3,4,5") {
    throw new Error("fixture versions not all counted");
  }
});

Deno.test("tampering, truncation, reordering, and a foreign chain are reported with the last good line", async () => {
  const { text, publicKey, chainId } = await fixture();
  const lines = text.split("\n").filter(Boolean);
  const cases: Array<[string, string, number]> = [
    [
      "field edited",
      [
        lines[0],
        lines[1]!.replace('"decision":"transform"', '"decision":"allow_raw"'),
        ...lines.slice(2),
      ].join("\n"),
      1,
    ],
    ["line removed", [lines[0], lines[2], lines[3]].join("\n"), 1],
    ["line reordered", [lines[0], lines[2], lines[1], lines[3]].join("\n"), 1],
    ["invalid json", [lines[0], "{not json"].join("\n"), 1],
  ];
  for (const [name, mutated, lastGood] of cases) {
    let error: ReceiptLogError | null = null;
    try {
      await verifyReceiptLog(mutated, publicKey, chainId);
    } catch (thrown) {
      if (thrown instanceof ReceiptLogError) error = thrown;
    }
    if (!error) throw new Error(`${name}: verified although it should not`);
    if (error.lastGoodSequence !== lastGood) {
      throw new Error(
        `${name}: last good sequence ${error.lastGoodSequence}, expected ${lastGood}`,
      );
    }
  }
  let foreign = false;
  try {
    await verifyReceiptLog(text, publicKey, "some-other-chain");
  } catch (thrown) {
    foreign = thrown instanceof ReceiptLogError && thrown.line === 1;
  }
  if (!foreign) throw new Error("a log from another chain was accepted");
  const other = await testKeys();
  let wrongKey = false;
  try {
    await verifyReceiptLog(text, other.publicKey, chainId);
  } catch (thrown) {
    wrongKey = thrown instanceof ReceiptLogError;
  }
  if (!wrongKey) throw new Error("a log verified under an unrelated public key");
});

Deno.test("a rotated segment opening with a checkpoint verifies and names the previous head", async () => {
  const keys = await testKeys();
  const dir = await Deno.makeTempDir();
  const path = `${dir}/receipts.jsonl`;
  try {
    const store = await ReceiptStore.open({
      fingerprintKey: "a-test-fingerprint-key-that-is-at-least-32-characters",
      privateKeyPkcs8: keys.privateKey,
      publicKeySpki: keys.publicKey,
      chainId: "rotation-verify",
      logPath: path,
      capacity: 10,
      maxLogBytes: 1024,
    });
    for (let index = 0; index < 6; index++) {
      await store.create({
        requestCanonical: "{}",
        workloadId: "w",
        decision: "deny",
        provider: null,
        model: "m",
        findings: [],
        transformedFields: 0,
      });
    }
    await store.close();
    const segments: string[] = [];
    for await (const entry of Deno.readDir(dir)) segments.push(entry.name);
    const rotated = segments.filter((name) => name !== "receipts.jsonl").sort();
    if (rotated.length === 0) throw new Error("no rotation happened at a 1 KiB limit");
    const first = await verifyReceiptLog(
      await Deno.readTextFile(`${dir}/${rotated[0]}`),
      keys.publicKey,
      "rotation-verify",
    );
    const active = await verifyReceiptLog(
      await Deno.readTextFile(path),
      keys.publicKey,
      "rotation-verify",
    );
    if (!active.startedFromCheckpoint && rotated.length === 1) {
      throw new Error("active segment did not open with a checkpoint");
    }
    if (first.head.sequence < 1 || active.head.sequence !== 6) {
      throw new Error(
        `segments do not cover the chain: ${first.head.sequence}, ${active.head.sequence}`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
