// Reference adapter for a customer-local named-entity detector.
//
// The semantic detector asks a chat model to find names and addresses. That
// works with a large model and fails with a small one, and even the large
// model needs seconds per request. A purpose-built entity model finds the
// same values in tens of milliseconds, but it is a Python artefact, and the
// data plane carries no third-party runtime code. So the model runs in a
// separate process inside the customer boundary, exactly as Ollama does for
// the semantic detector, and this adapter speaks a small versioned contract
// to it over loopback HTTP.
//
// The contract is one request, POST {baseUrl}/v1/detect:
//
//   {"contractVersion":"1","kinds":["person_name","physical_address"],"text":"..."}
//
// and one response:
//
//   {"contractVersion":"1","detector":{"id":"...","version":"..."},
//    "findings":[{"kind":"person_name","text":"Maya Chen","confidence":0.91}]}
//
// Offsets are deliberately absent. A Python service counts code points and
// this runtime counts UTF-16 units, so an offset would be wrong on the first
// emoji. A candidate is accepted only if its text occurs literally in the
// chunk it was reported for, which also discards anything the model invented,
// and it is located here by searching the surface. Every safeguard the
// semantic detector has applies unchanged: bounded input and response sizes,
// per-chunk and per-surface deadlines, a cap on candidates and occurrences,
// low precision so a finding can never hard-deny by itself, and no content in
// logs, metrics, or receipts.
import { resolveNerDetectorConfig, validateNerDetectorConfig } from "./config.ts";
import type { ResolvedNerDetectorConfig } from "./config.ts";
import { BodySizeLimitError, readBoundedText } from "./bounded.ts";
import { DetectorImplementationError, type LocalDetector } from "./detectors.ts";
import { splitText } from "./semantic.ts";
import type { AppConfig, Finding, NerFindingKind } from "./types.ts";

export const REFERENCE_NER_DETECTOR_ID = "egrysa.reference.local-ner";
export const REFERENCE_NER_DETECTOR_VERSION = "0.1.0";
export const NER_CONTRACT_VERSION = "1";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOTAL_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_CANDIDATES_PER_CHUNK = 512;
const MAX_OCCURRENCES_PER_CANDIDATE = 64;
const MAX_FINDINGS_PER_SURFACE = 512;
const MAX_CANDIDATE_LENGTH = 16_384;
const encoder = new TextEncoder();

interface Candidate {
  kind: NerFindingKind;
  text: string;
  confidence: number;
}

export function createNerDetector(config: AppConfig): LocalDetector | null {
  validateNerDetectorConfig(config);
  const settings = resolveNerDetectorConfig(config);
  if (!settings.enabled) return null;
  return new ReferenceNerDetector(settings);
}

class ReferenceNerDetector implements LocalDetector {
  readonly manifest;
  readonly #kinds: ReadonlySet<NerFindingKind>;
  readonly #endpoint: string;

  constructor(private readonly settings: ResolvedNerDetectorConfig) {
    this.manifest = {
      contractVersion: "1" as const,
      id: REFERENCE_NER_DETECTOR_ID,
      version: REFERENCE_NER_DETECTOR_VERSION,
      provenance: "reference",
      timeoutMs: settings.totalTimeoutMs,
    };
    this.#kinds = new Set(settings.kinds);
    this.#endpoint = `${settings.baseUrl.replace(/\/$/, "")}/v1/detect`;
  }

  async detect({ text }: { text: string }, signal: AbortSignal) {
    if (encoder.encode(text).byteLength > MAX_TOTAL_INPUT_BYTES) {
      throw new DetectorImplementationError("oversized_input");
    }
    const candidates = new Map<string, Candidate>();
    for (const chunk of splitText(text, this.settings.maxInputBytes)) {
      const response = await this.#invoke(chunk.text, signal);
      for (const candidate of parseCandidates(response, this.#kinds, chunk.text)) {
        if (candidate.confidence < this.settings.minConfidence) continue;
        const key = `${candidate.kind}\0${candidate.text}`;
        const current = candidates.get(key);
        if (!current || candidate.confidence > current.confidence) candidates.set(key, candidate);
      }
    }
    const findings: Finding[] = [];
    for (const candidate of candidates.values()) {
      let start = text.indexOf(candidate.text);
      let occurrences = 0;
      while (start !== -1) {
        if (
          occurrences >= MAX_OCCURRENCES_PER_CANDIDATE ||
          findings.length >= MAX_FINDINGS_PER_SURFACE
        ) throw new DetectorImplementationError("oversized_findings");
        findings.push({
          kind: candidate.kind,
          start,
          end: start + candidate.text.length,
          value: candidate.text,
          confidence: candidate.confidence,
          precision: "low",
        });
        occurrences++;
        start = text.indexOf(candidate.text, start + 1);
      }
    }
    return { contractVersion: "1" as const, findings };
  }

  async #invoke(text: string, signal: AbortSignal): Promise<unknown> {
    const chunkSignal = AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]);
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractVersion: NER_CONTRACT_VERSION,
          kinds: [...this.#kinds],
          text,
        }),
        signal: chunkSignal,
        redirect: "error",
      });
    } catch (error) {
      if (isAbortError(error)) throw new DetectorImplementationError("timeout");
      throw new DetectorImplementationError("connection");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DetectorImplementationError("endpoint");
    }
    let raw: string;
    try {
      raw = await readBoundedText(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof BodySizeLimitError) {
        throw new DetectorImplementationError("response_too_large");
      }
      if (isAbortError(error)) throw new DetectorImplementationError("timeout");
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new DetectorImplementationError("schema");
    }
  }
}

function parseCandidates(
  value: unknown,
  enabledKinds: ReadonlySet<NerFindingKind>,
  chunk: string,
): Candidate[] {
  if (
    !isRecord(value) || value.contractVersion !== NER_CONTRACT_VERSION ||
    !Array.isArray(value.findings) ||
    Object.keys(value).some((key) => !["contractVersion", "detector", "findings"].includes(key))
  ) throw new DetectorImplementationError("schema");
  if (value.findings.length > MAX_CANDIDATES_PER_CHUNK) {
    throw new DetectorImplementationError("schema");
  }
  const candidates: Candidate[] = [];
  for (const item of value.findings) {
    if (
      !isRecord(item) || Object.keys(item).length !== 3 ||
      Object.keys(item).some((key) => !["kind", "text", "confidence"].includes(key)) ||
      !enabledKinds.has(item.kind as NerFindingKind) ||
      typeof item.text !== "string" || !item.text || item.text.length > MAX_CANDIDATE_LENGTH ||
      typeof item.confidence !== "number" || !Number.isFinite(item.confidence)
    ) continue;
    // A candidate the chunk does not literally contain is either invented or
    // normalised by the model. Neither can be located, so neither is a finding.
    if (!chunk.includes(item.text)) continue;
    candidates.push({
      kind: item.kind as NerFindingKind,
      text: item.text,
      confidence: Math.min(1, Math.max(0, item.confidence)),
    });
  }
  return candidates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name);
}
