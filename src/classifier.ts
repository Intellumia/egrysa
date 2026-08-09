import {
  type DetectorErrorClass,
  DetectorExecutionError,
  type LocalDetector,
  runDetectorDetailed,
} from "./detectors.ts";
import { createSemanticDetector, REFERENCE_SEMANTIC_DETECTOR_ID } from "./semantic.ts";
import type { AppConfig, Finding, FindingKind } from "./types.ts";

// Vendor-namespaced credential prefixes. Each alternative is anchored on a
// literal issued by the provider, so broadening coverage here does not widen
// the match surface for ordinary high-entropy strings such as commit hashes,
// image digests, or build identifiers.
const CREDENTIAL_PREFIXES = [
  "sk-(?:proj-)?[A-Za-z0-9_-]{20,}", // OpenAI and Anthropic
  "AKIA[0-9A-Z]{16}", // AWS access key identifier
  "gh[opusr]_[A-Za-z0-9]{20,}", // GitHub classic token
  "github_pat_[A-Za-z0-9_]{20,}", // GitHub fine-grained token
  "glpat-[A-Za-z0-9_-]{16,}", // GitLab personal access token
  "AIza[0-9A-Za-z_-]{35}", // Google API key
  "xox[baprs]-[A-Za-z0-9-]{10,}", // Slack token
  "[sr]k_(?:live|test)_[A-Za-z0-9_-]{16,}", // Stripe secret and restricted keys
  "npm_[A-Za-z0-9]{30,}", // npm access token
  "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}", // SendGrid API key
  "AccountKey=[A-Za-z0-9+/]{60,}={0,2}", // Azure storage connection string
  "eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", // JSON Web Token
].join("|");

const patterns: Array<{
  kind: FindingKind;
  regex: RegExp;
  validate?: (value: string) => boolean;
  // Omitted means high. A low-precision pattern trades false positives for
  // reach, and what happens to its findings is chosen by policy.sensitivity
  // rather than decided here.
  precision?: "high" | "low";
}> = [
  {
    kind: "private_key",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: "api_secret",
    regex: new RegExp(`\\b(?:${CREDENTIAL_PREFIXES})`, "g"),
  },
  {
    // A password carried in a URL authority. Without this the credential
    // matches the email pattern instead, which routes the request to
    // transform rather than deny and understates the finding in the receipt.
    kind: "api_secret",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]{3,}@[^\s/?#]+/gi,
  },
  { kind: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  {
    kind: "ssn",
    regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  { kind: "iban", regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, validate: validateIban },
  {
    // Conventional printed grouping. Kept separate from the compact pattern
    // so a greedy run into adjacent uppercase text cannot fail validation and
    // discard an otherwise valid account number.
    kind: "iban",
    regex: /\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?\b/g,
    validate: validateIban,
  },
  { kind: "credit_card", regex: /\b(?:\d[ -]*?){13,19}\b/g, validate: luhn },
  { kind: "ipv4", regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, validate: validateIpv4 },
  {
    // A credential named by its assignment rather than its own format. This
    // reaches unprefixed values such as AWS secret access keys and generic
    // passwords, at the cost of matching benign configuration.
    kind: "api_secret",
    // The lookbehind keeps the key name out of the finding, and omitting a
    // word boundary lets it reach a suffix such as aws_secret_access_key.
    regex:
      /(?<=(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?)[A-Za-z0-9+/_-]{12,}/gi,
    precision: "low",
  },
  {
    kind: "phone",
    regex:
      /(?<!\w)(?<!\d[ -])(?:\+\d[\d .()-]{7,}\d|\(\d{2,4}\)[ -]?\d[\d -]{5,}\d|\d{3}[- ]\d{3}[- ]\d{4}|\d{3,4} \d{3,4} \d{4})(?!\w|[ -]\d)/g,
    validate: validatePhone,
  },
];

export async function classify(
  text: string,
  config: AppConfig,
  detectors: LocalDetector[] = createDetectors(config),
): Promise<Finding[]> {
  return (await classifyDetailed(text, config, detectors)).findings;
}

export interface DetectorExecution {
  id: string;
  version: string;
  latencyMs: number;
  findings: number;
  failureClass?: DetectorErrorClass;
}

export interface ClassificationResult {
  findings: Finding[];
  detectorExecutions: DetectorExecution[];
  detectorDegraded: boolean;
}

export async function classifyDetailed(
  text: string,
  config: AppConfig,
  detectors: LocalDetector[] = createDetectors(config),
): Promise<ClassificationResult> {
  const executions = await Promise.all(detectors.map(async (detector): Promise<
    DetectorExecution & {
      values: Finding[];
    }
  > => {
    try {
      const run = await runDetectorDetailed(detector, text);
      return {
        id: run.detectorId,
        version: run.detectorVersion,
        latencyMs: run.latencyMs,
        findings: run.findings.length,
        values: run.findings,
      };
    } catch (error) {
      if (
        error instanceof DetectorExecutionError &&
        error.detectorId === REFERENCE_SEMANTIC_DETECTOR_ID
      ) {
        return {
          id: error.detectorId,
          version: error.detectorVersion,
          latencyMs: error.latencyMs,
          findings: 0,
          failureClass: error.errorClass,
          values: [],
        };
      }
      throw error;
    }
  }));
  const detectorDegraded = executions.some((execution) => execution.failureClass !== undefined);
  const findings = executions.flatMap((execution) => execution.values).filter((finding) =>
    !detectorDegraded || finding.detectorId !== REFERENCE_SEMANTIC_DETECTOR_ID
  );
  return {
    findings: removeOverlaps(findings),
    detectorExecutions: executions.map(({ values: _values, ...execution }) => execution),
    detectorDegraded,
  };
}

export function createDetectors(config: AppConfig): LocalDetector[] {
  const semantic = createSemanticDetector(config);
  return [patternDetector(), sensitiveTermDetector(config), ...(semantic ? [semantic] : [])];
}

function patternDetector(): LocalDetector {
  return {
    manifest: {
      contractVersion: "1",
      id: "egrysa.deterministic.patterns",
      version: "1.1.0",
      provenance: "built-in",
      timeoutMs: 100,
    },
    detect({ text }) {
      const findings: Finding[] = [];
      for (const item of patterns) {
        item.regex.lastIndex = 0;
        for (const match of text.matchAll(item.regex)) {
          const value = match[0];
          const start = match.index;
          if (start === undefined || (item.validate && !item.validate(value))) continue;
          findings.push({
            kind: item.kind,
            start,
            end: start + value.length,
            value,
            confidence: item.precision === "low" ? 0.5 : 1,
            precision: item.precision ?? "high",
          });
        }
      }
      return { contractVersion: "1", findings };
    },
  };
}

function sensitiveTermDetector(config: AppConfig): LocalDetector {
  return {
    manifest: {
      contractVersion: "1",
      id: "egrysa.deterministic.sensitive-terms",
      version: "1.0.0",
      provenance: "operator-configured",
      timeoutMs: 100,
    },
    detect({ text }) {
      const findings: Finding[] = [];
      for (const item of config.policy.sensitiveTerms) {
        const escaped = item.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "gi");
        for (const match of text.matchAll(regex)) {
          const start = match.index;
          if (start !== undefined) {
            findings.push({
              kind: "confidential_term",
              start,
              end: start + match[0].length,
              value: match[0],
              label: item.label,
              confidence: 1,
              precision: "high",
            });
          }
        }
      }
      return { contractVersion: "1", findings };
    },
  };
}

export function removeOverlaps(findings: Finding[]): Finding[] {
  const priority: FindingKind[] = [
    "private_key",
    "api_secret",
    "credit_card",
    "ssn",
    "iban",
    "email",
    "phone",
    "ipv4",
    "confidential_term",
    "person_name",
    "physical_address",
    "semantic_confidential",
  ];
  const winner = (a: Finding, b: Finding) =>
    precisionPriority(a) - precisionPriority(b) || a.start - b.start ||
    priority.indexOf(a.kind) - priority.indexOf(b.kind) || b.end - a.end;
  const sorted = findings.map((finding, index) => ({ finding, index })).toSorted((a, b) =>
    winner(a.finding, b.finding) || a.index - b.index
  );
  const starts = [...new Set(findings.map((finding) => finding.start))].toSorted((a, b) => a - b);
  const acceptedByStart = new Array<Finding | undefined>(starts.length);
  const acceptedStarts = new FenwickTree(starts.length);

  for (const { finding: candidate } of sorted) {
    const insertionPoint = lowerBound(starts, candidate.start);
    const predecessors = acceptedStarts.countBefore(insertionPoint);
    const acceptedCount = acceptedStarts.countBefore(starts.length);
    const predecessor = predecessors > 0
      ? acceptedByStart[acceptedStarts.indexOfOrder(predecessors)]
      : undefined;
    const successor = acceptedCount > predecessors
      ? acceptedByStart[acceptedStarts.indexOfOrder(predecessors + 1)]
      : undefined;
    if (predecessor && predecessor.end > candidate.start) continue;
    if (successor && successor.start < candidate.end) continue;

    acceptedByStart[insertionPoint] = candidate;
    acceptedStarts.add(insertionPoint);
  }
  return acceptedByStart.filter((finding): finding is Finding => finding !== undefined);
}

class FenwickTree {
  readonly #tree: Uint32Array;

  constructor(size: number) {
    this.#tree = new Uint32Array(size + 1);
  }

  add(index: number): void {
    for (let cursor = index + 1; cursor < this.#tree.length; cursor += cursor & -cursor) {
      this.#tree[cursor] = this.#tree[cursor]! + 1;
    }
  }

  countBefore(end: number): number {
    let count = 0;
    for (let cursor = end; cursor > 0; cursor -= cursor & -cursor) {
      count += this.#tree[cursor]!;
    }
    return count;
  }

  indexOfOrder(order: number): number {
    let index = 0;
    for (let step = highestPowerOfTwoBelow(this.#tree.length); step > 0; step >>= 1) {
      const next = index + step;
      if (next < this.#tree.length && this.#tree[next]! < order) {
        index = next;
        order -= this.#tree[next]!;
      }
    }
    return index;
  }
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function highestPowerOfTwoBelow(value: number): number {
  let power = 1;
  while (power << 1 < value) power <<= 1;
  return power;
}

function precisionPriority(finding: Finding): number {
  if (finding.precision === undefined || finding.precision === "high") return 0;
  return finding.precision === "medium" ? 1 : 2;
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function luhn(value: string): boolean {
  const number = digits(value);
  if (number.length < 13 || number.length > 19 || /^(\d)\1+$/.test(number)) return false;
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let n = Number(number[i]);
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function validateIpv4(value: string): boolean {
  return value.split(".").every((part) => Number(part) <= 255);
}

function validatePhone(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  if (/^\d{3}-\d{2}-\d{4}$/.test(value)) return false;
  const number = digits(value);
  const structured = value.startsWith("+") || /[ .()-]/.test(value);
  return structured && number.length >= 8 && number.length <= 15;
}

function validateIban(value: string): boolean {
  const compact = value.replace(/\s/g, "").toUpperCase();
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = [...rearranged].map((c) => /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)).join(
    "",
  );
  let remainder = 0;
  for (const chunk of numeric) remainder = (remainder * 10 + Number(chunk)) % 97;
  return remainder === 1;
}
