// Verify a receipt log offline against the published public key.
//
//   deno task receipts:verify <log path> <public key SPKI base64 | path to public-key JSON> [chain id]
//
// The public key argument is either the base64 SPKI string itself or the
// path to a file holding either that string or the JSON that
// /v1/receipts/public-key returns. Exits 0 when every line verifies and the
// chain is continuous, 1 with the failing line and the last good sequence
// otherwise. Rotated segments (<path>.<sequence>) verify the same way; the
// checkpoint that opens a later segment names the head of the one before it.

import { ReceiptLogError, verifyReceiptLog } from "../src/receipt_log.ts";

const [logPath, keyArgument, chainId] = Deno.args;
if (!logPath || !keyArgument) {
  console.error("usage: verify_receipt_log.ts <log path> <public key or key file> [chain id]");
  Deno.exit(2);
}

async function publicKey(argument: string): Promise<string> {
  let text = argument;
  try {
    text = await Deno.readTextFile(argument);
  } catch {
    // Not a file: treat the argument as the key itself.
  }
  text = text.trim();
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text) as { publicKey?: string };
    if (typeof parsed.publicKey !== "string") throw new Error("key file has no publicKey field");
    return parsed.publicKey;
  }
  return text;
}

try {
  const summary = await verifyReceiptLog(
    await Deno.readTextFile(logPath),
    await publicKey(keyArgument),
    chainId,
  );
  console.log(JSON.stringify({ ok: true, path: logPath, ...summary }, null, 2));
} catch (error) {
  if (error instanceof ReceiptLogError) {
    console.log(JSON.stringify(
      {
        ok: false,
        path: logPath,
        line: error.line,
        error: error.message,
        lastGoodSequence: error.lastGoodSequence,
      },
      null,
      2,
    ));
  } else {
    console.log(JSON.stringify({ ok: false, path: logPath, error: (error as Error).message }));
  }
  Deno.exit(1);
}
