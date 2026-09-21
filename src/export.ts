// Evidence export to a SIEM or an OpenTelemetry collector.
//
// Everything the gateway records is content-free by construction: signed
// receipts, signed chain checkpoints, and structured events such as a
// degraded detector or a rate-limited workload. This module ships those
// records to an HTTP sink so they live somewhere the gateway cannot alter,
// which is what turns a local receipt log into evidence an auditor can rely
// on. Two wire formats: JSON lines, which Splunk HEC-style collectors and
// most log pipelines accept, and OTLP/HTTP JSON log records for an
// OpenTelemetry collector.
//
// Delivery is asynchronous and bounded. Records queue in memory, are sent
// in batches, retried with backoff on failure, and dropped oldest-first with
// a counted metric if the sink stays unreachable; a request never waits on
// the sink. The receipt log on disk remains the primary record, and a
// checkpoint is exported every N receipts and at shutdown so a gap in the
// export can be reconciled against the signed chain.

import type { AppConfig, PrivacyReceipt, ReceiptCheckpoint } from "./types.ts";

export interface ExportConfig {
  url: string;
  format?: "jsonl" | "otlp";
  headersEnv?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  queueCapacity?: number;
  checkpointEveryReceipts?: number;
  timeoutMs?: number;
}

export interface ExportRecord {
  kind: "receipt" | "checkpoint" | "event";
  body: Record<string, unknown>;
}

export interface ExporterStats {
  queued: number;
  sent: number;
  dropped: number;
  failedBatches: number;
}

const DEFAULTS = {
  format: "jsonl" as const,
  batchSize: 100,
  flushIntervalMs: 2000,
  queueCapacity: 10_000,
  checkpointEveryReceipts: 1000,
  timeoutMs: 5000,
};

export function resolveExportConfig(config: AppConfig): Required<ExportConfig> | null {
  const raw = config.export;
  if (!raw) return null;
  return {
    url: raw.url,
    format: raw.format ?? DEFAULTS.format,
    headersEnv: raw.headersEnv ?? "",
    batchSize: raw.batchSize ?? DEFAULTS.batchSize,
    flushIntervalMs: raw.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
    queueCapacity: raw.queueCapacity ?? DEFAULTS.queueCapacity,
    checkpointEveryReceipts: raw.checkpointEveryReceipts ?? DEFAULTS.checkpointEveryReceipts,
    timeoutMs: raw.timeoutMs ?? DEFAULTS.timeoutMs,
  };
}

export function validateExportConfig(config: AppConfig): void {
  const raw = config.export;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("export must be an object");
  }
  const known = new Set([
    "url",
    "format",
    "headersEnv",
    "batchSize",
    "flushIntervalMs",
    "queueCapacity",
    "checkpointEveryReceipts",
    "timeoutMs",
  ]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new Error(`export has unknown field: ${key}`);
  }
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error("export.url must be a valid URL");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("export.url must use HTTPS; HTTP is allowed only on loopback");
  }
  if (url.username || url.password) throw new Error("export.url cannot carry credentials");
  if (raw.format !== undefined && !["jsonl", "otlp"].includes(raw.format)) {
    throw new Error("export.format must be jsonl or otlp");
  }
  if (raw.headersEnv !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(raw.headersEnv)) {
    throw new Error("export.headersEnv must be an environment variable name");
  }
  const bounds: Array<[keyof ExportConfig, number, number]> = [
    ["batchSize", 1, 10_000],
    ["flushIntervalMs", 100, 600_000],
    ["queueCapacity", 10, 1_000_000],
    ["checkpointEveryReceipts", 1, 1_000_000],
    ["timeoutMs", 100, 60_000],
  ];
  for (const [key, low, high] of bounds) {
    const value = raw[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || (value as number) < low || (value as number) > high)
    ) {
      throw new Error(`export.${key} must be an integer from ${low} to ${high}`);
    }
  }
}

// Header lines from an environment variable, "Name: value" per line, so a
// sink token such as a Splunk HEC key or a collector bearer token never
// appears in the configuration file.
function headersFromEnvironment(name: string): Record<string, string> {
  if (!name) return {};
  const raw = Deno.env.get(name) ?? "";
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function otlpValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null || value === undefined) return { stringValue: "" };
  return { stringValue: JSON.stringify(value) };
}

// One OTLP/HTTP JSON ExportLogsServiceRequest for a batch. Each record is a
// log record whose attributes are the record's top-level fields and whose
// body is the full JSON, so a collector can route on attributes and archive
// the signed document intact.
export function toOtlpLogs(records: ExportRecord[], now = Date.now()): Record<string, unknown> {
  return {
    resourceLogs: [{
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "egrysa" } }],
      },
      scopeLogs: [{
        scope: { name: "egrysa.evidence" },
        logRecords: records.map((record) => ({
          timeUnixNano: String(BigInt(now) * 1_000_000n),
          severityText: "INFO",
          body: { stringValue: JSON.stringify(record.body) },
          attributes: [
            { key: "egrysa.record", value: { stringValue: record.kind } },
            ...Object.entries(record.body)
              .filter(([, value]) => typeof value !== "object" || value === null)
              .map(([key, value]) => ({ key: `egrysa.${key}`, value: otlpValue(value) })),
          ],
        })),
      }],
    }],
  };
}

export class Exporter {
  readonly #queue: ExportRecord[] = [];
  readonly stats: ExporterStats = { queued: 0, sent: 0, dropped: 0, failedBatches: 0 };
  #timer: ReturnType<typeof setTimeout> | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #backoffMs = 0;
  #receiptsSinceCheckpoint = 0;
  #closed = false;

  constructor(
    private readonly settings: Required<ExportConfig>,
    private readonly checkpoint: () => Promise<ReceiptCheckpoint>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  receipt(receipt: PrivacyReceipt): void {
    this.#enqueue({ kind: "receipt", body: receipt as unknown as Record<string, unknown> });
    if (++this.#receiptsSinceCheckpoint >= this.settings.checkpointEveryReceipts) {
      this.#receiptsSinceCheckpoint = 0;
      void this.anchor();
    }
  }

  event(body: Record<string, unknown>): void {
    this.#enqueue({ kind: "event", body: { timestamp: new Date().toISOString(), ...body } });
  }

  // Exports the current signed chain head so a reader of the sink can tie the
  // exported receipts to the chain on disk.
  async anchor(): Promise<void> {
    try {
      const checkpoint = await this.checkpoint();
      this.#enqueue({ kind: "checkpoint", body: checkpoint as unknown as Record<string, unknown> });
    } catch {
      // A faulted receipt store already refuses requests; nothing to add.
    }
  }

  #enqueue(record: ExportRecord): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.settings.queueCapacity) {
      this.#queue.shift();
      this.stats.dropped++;
    }
    this.#queue.push(record);
    this.stats.queued = this.#queue.length;
    if (this.#queue.length >= this.settings.batchSize) this.#schedule(0);
    else this.#schedule(this.settings.flushIntervalMs);
  }

  #schedule(delayMs: number): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flushing.then(() => this.#flushOnce());
    }, Math.max(delayMs, this.#backoffMs));
  }

  async #flushOnce(): Promise<void> {
    if (this.#queue.length === 0) return;
    const batch = this.#queue.slice(0, this.settings.batchSize);
    const ok = await this.#send(batch);
    if (ok) {
      this.#queue.splice(0, batch.length);
      this.stats.sent += batch.length;
      this.#backoffMs = 0;
    } else {
      this.stats.failedBatches++;
      this.#backoffMs = Math.min(60_000, Math.max(1000, this.#backoffMs * 2));
    }
    this.stats.queued = this.#queue.length;
    if (this.#queue.length > 0 && !this.#closed) this.#schedule(ok ? 0 : this.#backoffMs);
  }

  async #send(batch: ExportRecord[]): Promise<boolean> {
    const headers: Record<string, string> = {
      "content-type": this.settings.format === "otlp" ? "application/json" : "application/x-ndjson",
      ...headersFromEnvironment(this.settings.headersEnv),
    };
    const body = this.settings.format === "otlp"
      ? JSON.stringify(toOtlpLogs(batch))
      : batch.map((record) => JSON.stringify({ record: record.kind, ...record.body })).join("\n") +
        "\n";
    try {
      const response = await this.fetchImpl(this.settings.url, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  // Flushes what it can within the deadline; a sink that is down at shutdown
  // does not hold the process, and what remains is reported in the stats.
  async close(deadlineMs = 5000): Promise<void> {
    if (this.#closed) return;
    await this.anchor();
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const deadline = Date.now() + deadlineMs;
    await this.#flushing;
    while (this.#queue.length > 0 && Date.now() < deadline) {
      const before = this.#queue.length;
      await this.#flushOnce();
      if (this.#queue.length === before) break;
    }
  }
}
