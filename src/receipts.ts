import {
  ed25519Sign,
  ed25519Verify,
  hmacSha256,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  sha256,
} from "./crypto.ts";
import type {
  Decision,
  EgressOutcome,
  Finding,
  PrivacyReceipt,
  ReceiptCheckpoint,
  ReceiptDetector,
} from "./types.ts";

interface ReceiptInput {
  requestCanonical: string;
  workloadId: string;
  decision: Decision;
  provider: string | null;
  model: string;
  findings: Finding[];
  transformedFields: number;
  detectors?: ReceiptDetector[];
  detectorDegraded?: boolean;
  egress?: EgressOutcome;
}

export interface ReceiptStoreOptions {
  fingerprintKey: string;
  privateKeyPkcs8: string;
  publicKeySpki: string;
  chainId: string;
  logPath: string;
  capacity: number;
  maxLogBytes: number;
}

export class ReceiptStore {
  #receipts = new Map<string, PrivacyReceipt>();
  #previousHash: string | null = null;
  #sequence = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #file: Deno.FsFile | undefined;
  #logBytes = 0;
  #activeReceiptCount = 0;
  #closing = false;
  #pending: string[] = [];
  #syncing: Promise<void> | undefined;
  #waiting: Promise<void> | undefined;
  #fault: Error | undefined;

  private constructor(
    private readonly options: ReceiptStoreOptions,
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    readonly signingKeyId: string,
  ) {}

  static async open(options: ReceiptStoreOptions): Promise<ReceiptStore> {
    if (options.fingerprintKey.length < 32) {
      throw new Error("EGRYSA_RECEIPT_FINGERPRINT_KEY must be at least 32 characters");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.chainId)) {
      throw new Error("receiptChainId must be a stable identifier");
    }
    if (
      !Number.isInteger(options.maxLogBytes) || options.maxLogBytes < 1024 ||
      options.maxLogBytes > 1024 * 1024 * 1024
    ) throw new Error("receipt maxLogBytes must be between 1 KiB and 1 GiB");
    const privateKey = await importEd25519PrivateKey(options.privateKeyPkcs8);
    const publicKey = await importEd25519PublicKey(options.publicKeySpki);
    const signingKeyId = await signingKeyIdentifier(options.publicKeySpki);
    const proof = await ed25519Sign(privateKey, "egrysa/signing-key-pair-check/v1");
    if (!await ed25519Verify(publicKey, proof, "egrysa/signing-key-pair-check/v1")) {
      throw new Error("receipt Ed25519 public and private keys do not match");
    }
    const store = new ReceiptStore(options, privateKey, publicKey, signingKeyId);
    await store.#load();
    await store.#openLog();
    return store;
  }

  create(input: ReceiptInput): Promise<PrivacyReceipt> {
    if (this.#closing) return Promise.reject(new Error("receipt store is closed"));
    if (this.#fault) return Promise.reject(this.#fault);
    // Building and signing stay serialized so the chain is ordered. Waiting for
    // durability does not: one write and one fsync commit every receipt queued
    // while the previous commit was in flight, and each caller still resolves
    // only after a commit that includes its own receipt.
    const staged = this.#queue.then(() => this.#stage(input));
    this.#queue = staged.catch(() => undefined);
    return staged.then(async ({ receipt, durable }) => {
      await durable;
      return receipt;
    });
  }

  get(id: string): PrivacyReceipt | undefined {
    return this.#receipts.get(id);
  }

  publicKeyInfo(): Record<string, string> {
    return {
      algorithm: "Ed25519",
      format: "spki-base64",
      keyId: this.signingKeyId,
      publicKey: this.options.publicKeySpki,
    };
  }

  checkpoint(): Promise<ReceiptCheckpoint> {
    if (this.#fault) return Promise.reject(this.#fault);
    const operation = this.#queue.then(() => this.#buildCheckpoint());
    this.#queue = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.#closing) {
      await this.#queue;
      return;
    }
    this.#closing = true;
    const operation = this.#queue.then(() => this.#closeLog());
    this.#queue = operation.catch(() => undefined);
    await operation;
  }

  async #buildCheckpoint(): Promise<ReceiptCheckpoint> {
    // A checkpoint names the durable chain head, so wait for any group fsync
    // that has not yet covered the latest append.
    await this.#settle();
    if (this.#fault) throw this.#fault;
    const unsigned = {
      version: "1" as const,
      chainId: this.options.chainId,
      sequence: this.#sequence,
      receiptHash: this.#previousHash,
      timestamp: new Date().toISOString(),
      signingKeyId: this.signingKeyId,
    };
    return {
      ...unsigned,
      signature: await ed25519Sign(this.privateKey, JSON.stringify(unsigned)),
    };
  }

  async #stage(
    input: ReceiptInput,
  ): Promise<{ receipt: PrivacyReceipt; durable: Promise<void> }> {
    if (this.#fault) throw this.#fault;
    const findingCounts: PrivacyReceipt["findingCounts"] = {};
    for (const finding of input.findings) {
      findingCounts[finding.kind] = (findingCounts[finding.kind] ?? 0) + 1;
    }
    const id = crypto.randomUUID();
    const common = {
      id,
      chainId: this.options.chainId,
      sequence: this.#sequence + 1,
      timestamp: new Date().toISOString(),
      workloadId: input.workloadId,
      requestFingerprint: await hmacSha256(
        this.options.fingerprintKey,
        `egrysa/request-fingerprint/v2\0${id}\0${input.requestCanonical}`,
      ),
      decision: input.decision,
      provider: input.provider,
      model: input.model,
      findingCounts,
      transformedFields: input.transformedFields,
    };
    const tail = {
      rawContentPersisted: false as const,
      providerStoreRequested: false as const,
      previousReceiptHash: this.#previousHash,
      signingKeyId: this.signingKeyId,
    };
    const detectors = input.detectors === undefined ? undefined : uniqueDetectors(input.detectors);
    const detectorEvidence = detectors === undefined
      ? {}
      : { detectors, detectorDegraded: input.detectorDegraded ?? false };
    const unsigned = input.egress !== undefined
      ? {
        version: "4" as const,
        ...common,
        egress: input.egress,
        ...detectorEvidence,
        ...tail,
      }
      : detectors === undefined
      ? { version: "2" as const, ...common, ...tail }
      : {
        version: "3" as const,
        ...common,
        ...detectorEvidence,
        ...tail,
      };
    const receiptHash = await sha256(JSON.stringify(unsigned));
    const receipt = {
      ...unsigned,
      receiptHash,
      signature: await ed25519Sign(this.privateKey, receiptHash),
    } as PrivacyReceipt;
    const { durable } = await this.#append(receipt);
    this.#sequence = receipt.sequence;
    this.#previousHash = receiptHash;
    this.#remember(receipt);
    return { receipt, durable };
  }

  // Group commit. The caller's line is already in the pending list. If a
  // commit is scheduled but has not started it will take that line, so join
  // it; otherwise schedule one to run after the commit in flight. A commit
  // writes every pending line in one call and fsyncs once. A failed commit
  // leaves the on-disk chain unknown, so it faults the store rather than
  // letting later receipts chain onto receipts that may never have reached
  // the disk. The stage never touches the file, so signing the next receipt
  // proceeds while the disk is busy.
  #commit(): Promise<void> {
    if (!this.#file) return Promise.resolve();
    if (this.#waiting) return this.#waiting;
    const previous = this.#syncing ?? Promise.resolve();
    const next: Promise<void> = previous.catch(() => undefined).then(async () => {
      this.#waiting = undefined;
      this.#syncing = next;
      try {
        if (this.#fault) throw this.#fault;
        await this.#flushPending();
      } catch (error) {
        this.#fault = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        if (this.#syncing === next) this.#syncing = undefined;
      }
    });
    this.#waiting = next;
    return next;
  }

  async #flushPending(): Promise<void> {
    const file = this.#file;
    if (!file) throw new Error("receipt log is not open");
    const lines = this.#pending;
    this.#pending = [];
    if (lines.length > 0) await writeAll(file, encoder.encode(lines.join("")));
    await file.sync();
  }

  async #settle(): Promise<void> {
    // Failures are recorded as a store fault by the commit that raised them.
    await Promise.allSettled([this.#syncing, this.#waiting]);
  }

  // Queues one line and returns the promise for the commit that will carry it.
  #enqueue(line: string): Promise<void> {
    this.#pending.push(line);
    this.#logBytes += encoder.encode(line).byteLength;
    return this.#commit();
  }

  async #load(): Promise<void> {
    if (this.options.logPath === ":memory:") return;
    let content: string;
    try {
      content = await Deno.readTextFile(this.options.logPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        await this.#assertNoInterruptedRotation();
        return;
      }
      throw error;
    }
    const lines = content.split("\n").filter((line) => line.trim());
    if (lines.length === 0) await this.#assertNoInterruptedRotation();
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`receipt log contains invalid JSON at line ${index + 1}`);
      }
      if (index === 0 && isCheckpoint(parsed)) {
        await this.#loadCheckpoint(parsed);
        continue;
      }
      const receipt = parsed as PrivacyReceipt;
      await this.#verifyNext(receipt, index + 1);
      this.#sequence = receipt.sequence;
      this.#previousHash = receipt.receiptHash;
      this.#remember(receipt);
      this.#activeReceiptCount++;
    }
  }

  async #assertNoInterruptedRotation(): Promise<void> {
    const separator = this.options.logPath.lastIndexOf("/");
    const directory = separator < 0 ? "." : this.options.logPath.slice(0, separator) || "/";
    const basename = separator < 0
      ? this.options.logPath
      : this.options.logPath.slice(separator + 1);
    const rotated: Array<{ name: string; sequence: number }> = [];
    try {
      for await (const entry of Deno.readDir(directory)) {
        if (!entry.isFile) continue;
        const suffix = entry.name.slice(`${basename}.`.length);
        if (!entry.name.startsWith(`${basename}.`) || !/^\d+$/.test(suffix)) continue;
        rotated.push({ name: entry.name, sequence: Number(suffix) });
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    if (rotated.length === 0) return;
    rotated.sort((left, right) => right.sequence - left.sequence);
    const newest = `${directory === "." ? "" : `${directory}/`}${rotated[0]!.name}`;
    throw new Error(
      `receipt head log is missing after an interrupted rotation; recover by renaming ${newest} ` +
        `to ${this.options.logPath}, or explicitly start a fresh chain with a new receiptChainId ` +
        "and log path",
    );
  }

  async #loadCheckpoint(checkpoint: ReceiptCheckpoint): Promise<void> {
    if (
      checkpoint.chainId !== this.options.chainId ||
      checkpoint.signingKeyId !== this.signingKeyId || !Number.isInteger(checkpoint.sequence) ||
      checkpoint.sequence < 0 ||
      (checkpoint.receiptHash !== null && !/^[a-f0-9]{64}$/.test(checkpoint.receiptHash)) ||
      !await ed25519Verify(
        this.publicKey,
        checkpoint.signature,
        JSON.stringify(unsignedCheckpoint(checkpoint)),
      )
    ) throw new Error("receipt log checkpoint verification failed at line 1");
    this.#sequence = checkpoint.sequence;
    this.#previousHash = checkpoint.receiptHash;
  }

  async #verifyNext(receipt: PrivacyReceipt, line: number): Promise<void> {
    if (
      !validReceiptVersion(receipt) || receipt.chainId !== this.options.chainId ||
      receipt.signingKeyId !== this.signingKeyId || receipt.sequence !== this.#sequence + 1 ||
      receipt.previousReceiptHash !== this.#previousHash
    ) throw new Error(`receipt log continuity check failed at line ${line}`);
    const expectedHash = await sha256(JSON.stringify(unsignedReceipt(receipt)));
    if (
      expectedHash !== receipt.receiptHash ||
      !await ed25519Verify(this.publicKey, receipt.signature, receipt.receiptHash)
    ) throw new Error(`receipt log signature check failed at line ${line}`);
  }

  // Returns the commit promise inside an object so the async boundary does not
  // flatten it; the caller must be able to hold it without awaiting it yet.
  async #append(receipt: PrivacyReceipt): Promise<{ durable: Promise<void> }> {
    if (this.options.logPath === ":memory:") return { durable: Promise.resolve() };
    const line = `${JSON.stringify(receipt)}\n`;
    const lineBytes = encoder.encode(line).byteLength;
    if (
      this.#activeReceiptCount > 0 &&
      this.#logBytes + lineBytes > this.options.maxLogBytes
    ) {
      await this.#rotate();
    }
    this.#activeReceiptCount++;
    return { durable: this.#enqueue(line) };
  }

  async #rotate(): Promise<void> {
    const sequence = this.#sequence;
    const rotatedPath = `${this.options.logPath}.${sequence}`;
    try {
      await Deno.stat(rotatedPath);
      throw new Error(`receipt rotation target already exists for sequence ${sequence}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const checkpoint = await this.#buildCheckpoint();
    await this.#closeLog();
    await Deno.rename(this.options.logPath, rotatedPath);
    this.#logBytes = 0;
    this.#activeReceiptCount = 0;
    await this.#openLog();
    await this.#enqueue(`${JSON.stringify(checkpoint)}\n`);
  }

  async #openLog(): Promise<void> {
    if (this.options.logPath === ":memory:") return;
    const separator = this.options.logPath.lastIndexOf("/");
    if (separator > 0) {
      await Deno.mkdir(this.options.logPath.slice(0, separator), { recursive: true });
    }
    this.#file = await Deno.open(this.options.logPath, {
      append: true,
      create: true,
      write: true,
    });
    this.#logBytes = (await this.#file.stat()).size;
  }

  async #closeLog(): Promise<void> {
    const file = this.#file;
    if (!file) return;
    await this.#settle();
    this.#file = undefined;
    try {
      if (this.#pending.length > 0 && !this.#fault) {
        const lines = this.#pending;
        this.#pending = [];
        await writeAll(file, encoder.encode(lines.join("")));
      }
      await file.sync();
    } finally {
      file.close();
    }
  }

  #remember(receipt: PrivacyReceipt): void {
    this.#receipts.set(receipt.id, receipt);
    while (this.#receipts.size > this.options.capacity) {
      this.#receipts.delete(this.#receipts.keys().next().value!);
    }
  }
}

const encoder = new TextEncoder();

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes.subarray(offset));
    if (written === 0) throw new Error("receipt log write made no progress");
    offset += written;
  }
}

export async function verifyReceipt(
  receipt: PrivacyReceipt,
  publicKeySpki: string,
): Promise<boolean> {
  if (!validReceiptVersion(receipt)) return false;
  const publicKey = await importEd25519PublicKey(publicKeySpki);
  const expectedHash = await sha256(JSON.stringify(unsignedReceipt(receipt)));
  return receipt.signingKeyId === await signingKeyIdentifier(publicKeySpki) &&
    expectedHash === receipt.receiptHash &&
    await ed25519Verify(publicKey, receipt.signature, receipt.receiptHash);
}

async function signingKeyIdentifier(publicKeySpki: string): Promise<string> {
  return (await sha256(`egrysa/ed25519-spki/v1\0${publicKeySpki}`)).slice(0, 24);
}

function unsignedReceipt(
  receipt: PrivacyReceipt,
): Record<string, unknown> {
  return {
    version: receipt.version,
    id: receipt.id,
    chainId: receipt.chainId,
    sequence: receipt.sequence,
    timestamp: receipt.timestamp,
    workloadId: receipt.workloadId,
    requestFingerprint: receipt.requestFingerprint,
    decision: receipt.decision,
    provider: receipt.provider,
    model: receipt.model,
    findingCounts: receipt.findingCounts,
    transformedFields: receipt.transformedFields,
    ...(receipt.version === "4" ? { egress: receipt.egress } : {}),
    ...(receipt.version === "3" ||
        (receipt.version === "4" && receipt.detectors !== undefined)
      ? { detectors: receipt.detectors, detectorDegraded: receipt.detectorDegraded }
      : {}),
    rawContentPersisted: receipt.rawContentPersisted,
    providerStoreRequested: receipt.providerStoreRequested,
    previousReceiptHash: receipt.previousReceiptHash,
    signingKeyId: receipt.signingKeyId,
  };
}

function uniqueDetectors(detectors: ReceiptDetector[]): ReceiptDetector[] {
  const unique = new Map<string, ReceiptDetector>();
  for (const detector of detectors) unique.set(`${detector.id}\0${detector.version}`, detector);
  return [...unique.values()].sort((a, b) =>
    a.id.localeCompare(b.id) || a.version.localeCompare(b.version)
  );
}

function validReceiptVersion(receipt: PrivacyReceipt): boolean {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  const commonKeys = [
    "version",
    "id",
    "chainId",
    "sequence",
    "timestamp",
    "workloadId",
    "requestFingerprint",
    "decision",
    "provider",
    "model",
    "findingCounts",
    "transformedFields",
    "rawContentPersisted",
    "providerStoreRequested",
    "previousReceiptHash",
    "receiptHash",
    "signingKeyId",
    "signature",
  ];
  if (receipt.version === "2") {
    return hasExactKeys(receipt, commonKeys);
  }
  if (receipt.version === "3") {
    return hasExactKeys(receipt, [...commonKeys, "detectors", "detectorDegraded"]) &&
      validDetectorEvidence(receipt.detectors, receipt.detectorDegraded);
  }
  if (receipt.version !== "4" || !["completed", "failed", "started"].includes(receipt.egress)) {
    return false;
  }
  const hasDetectors = "detectors" in receipt;
  const hasDegraded = "detectorDegraded" in receipt;
  if (hasDetectors !== hasDegraded) return false;
  return hasExactKeys(
    receipt,
    [...commonKeys, "egress", ...(hasDetectors ? ["detectors", "detectorDegraded"] : [])],
  ) && (!hasDetectors || validDetectorEvidence(receipt.detectors, receipt.detectorDegraded));
}

function validDetectorEvidence(detectors: unknown, degraded: unknown): boolean {
  return typeof degraded === "boolean" && Array.isArray(detectors) &&
    detectors.every((detector) =>
      detector && typeof detector === "object" && !Array.isArray(detector) &&
      typeof detector.id === "string" && !!detector.id &&
      typeof detector.version === "string" && !!detector.version &&
      hasExactKeys(detector, ["id", "version"])
    );
}

function isCheckpoint(value: unknown): value is ReceiptCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return checkpoint.version === "1" &&
    hasExactKeys(checkpoint, [
      "version",
      "chainId",
      "sequence",
      "receiptHash",
      "timestamp",
      "signingKeyId",
      "signature",
    ]) && typeof checkpoint.chainId === "string" &&
    typeof checkpoint.timestamp === "string" && typeof checkpoint.signingKeyId === "string" &&
    typeof checkpoint.signature === "string";
}

function unsignedCheckpoint(checkpoint: ReceiptCheckpoint): Record<string, unknown> {
  return {
    version: checkpoint.version,
    chainId: checkpoint.chainId,
    sequence: checkpoint.sequence,
    receiptHash: checkpoint.receiptHash,
    timestamp: checkpoint.timestamp,
    signingKeyId: checkpoint.signingKeyId,
  };
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}
