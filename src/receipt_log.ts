// Offline verification of a receipt log: every line verifies against the
// public key and every receipt chains onto the one before it. This is what
// an operator runs on a restored backup before trusting it, what an auditor
// runs on an exported segment, and what CI runs on the frozen fixture chain.
// It needs only the log and the public key, never the private key.

import { verifyCheckpoint, verifyReceipt } from "./receipts.ts";
import type { PrivacyReceipt, ReceiptCheckpoint } from "./types.ts";

export interface ReceiptLogSummary {
  chainId: string | null;
  receipts: number;
  versions: Record<string, number>;
  head: { sequence: number; receiptHash: string | null };
  startedFromCheckpoint: ReceiptCheckpoint | null;
}

export class ReceiptLogError extends Error {
  constructor(readonly line: number, message: string, readonly lastGoodSequence: number) {
    super(`line ${line}: ${message}`);
  }
}

export async function verifyReceiptLog(
  text: string,
  publicKeySpki: string,
  expectedChainId?: string,
): Promise<ReceiptLogSummary> {
  const lines = text.split("\n").filter((line) => line.trim());
  let chainId: string | null = expectedChainId ?? null;
  let sequence = 0;
  let previousHash: string | null = null;
  let startedFromCheckpoint: ReceiptCheckpoint | null = null;
  const versions: Record<string, number> = {};
  let receipts = 0;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ReceiptLogError(number, "invalid JSON", sequence);
    }
    const record = parsed as Record<string, unknown>;
    if (index === 0 && record.version === "1" && "receiptHash" in record && !("id" in record)) {
      const checkpoint = record as unknown as ReceiptCheckpoint;
      if (!await verifyCheckpoint(checkpoint, publicKeySpki)) {
        throw new ReceiptLogError(number, "checkpoint signature does not verify", sequence);
      }
      if (chainId !== null && checkpoint.chainId !== chainId) {
        throw new ReceiptLogError(number, `checkpoint belongs to chain ${checkpoint.chainId}`, 0);
      }
      chainId = checkpoint.chainId;
      sequence = checkpoint.sequence;
      previousHash = checkpoint.receiptHash;
      startedFromCheckpoint = checkpoint;
      continue;
    }
    const receipt = record as unknown as PrivacyReceipt;
    if (chainId !== null && receipt.chainId !== chainId) {
      throw new ReceiptLogError(number, `receipt belongs to chain ${receipt.chainId}`, sequence);
    }
    chainId = receipt.chainId;
    if (receipt.sequence !== sequence + 1) {
      throw new ReceiptLogError(
        number,
        `sequence ${receipt.sequence} does not follow ${sequence}`,
        sequence,
      );
    }
    if (receipt.previousReceiptHash !== previousHash) {
      throw new ReceiptLogError(number, "previous receipt hash does not match the chain", sequence);
    }
    if (!await verifyReceipt(receipt, publicKeySpki)) {
      throw new ReceiptLogError(number, "receipt hash or signature does not verify", sequence);
    }
    sequence = receipt.sequence;
    previousHash = receipt.receiptHash;
    versions[receipt.version] = (versions[receipt.version] ?? 0) + 1;
    receipts++;
  }
  return {
    chainId,
    receipts,
    versions,
    head: { sequence, receiptHash: previousHash },
    startedFromCheckpoint,
  };
}
