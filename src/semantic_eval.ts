import type { LocalDetector } from "./detectors.ts";
import { runDetector } from "./detectors.ts";
import { type FindingKind, SEMANTIC_FINDING_KINDS } from "./types.ts";

export interface SemanticEvalCase {
  id: string;
  scenario: string;
  prompt: string;
  expectedKinds: FindingKind[];
}

export interface SemanticEvalReport {
  suite: "egrysa-semantic-v1";
  mode: "offline" | "live";
  detector: string;
  model: string;
  cases: number;
  perKind: Record<string, {
    tp: number;
    fp: number;
    fn: number;
    precision: number;
    recall: number;
  }>;
  macroPrecision: number;
  macroRecall: number;
  falsePositiveRate: number;
  p95AddedLatencyMs: number;
  detectorFailures: number;
  rawPromptsPersisted: false;
}

const STUB_LEXICON: Array<{ kind: FindingKind; text: string }> = [
  { kind: "person_name", text: "Maya Chen" },
  { kind: "person_name", text: "Ada Lovelace" },
  { kind: "person_name", text: "Grace Hopper" },
  { kind: "person_name", text: "Ravi Narayanan" },
  { kind: "physical_address", text: "221B Baker Street, London" },
  {
    kind: "physical_address",
    text: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
  },
  { kind: "physical_address", text: "44 West Cedar Avenue, Apt 7C, Boston, MA 02114" },
  { kind: "physical_address", text: "12 Residency Road, Bengaluru 560025" },
  { kind: "semantic_confidential", text: "acquisition of Northstar" },
  { kind: "semantic_confidential", text: "eliminate 120 roles next Tuesday" },
  {
    kind: "semantic_confidential",
    text: "Unreleased quarterly revenue missed the internal forecast",
  },
  {
    kind: "semantic_confidential",
    text: "production signing key was exposed, and the incident has not been disclosed",
  },
];

export function offlineSemanticEvalDetector(): LocalDetector {
  return {
    manifest: {
      contractVersion: "1",
      id: "egrysa.eval.semantic-stub",
      version: "1.0.0",
      provenance: "evaluation",
      timeoutMs: 100,
    },
    detect({ text }) {
      return {
        contractVersion: "1",
        findings: STUB_LEXICON.flatMap((candidate) => {
          const findings = [];
          let start = text.indexOf(candidate.text);
          while (start !== -1) {
            findings.push({
              kind: candidate.kind,
              start,
              end: start + candidate.text.length,
              value: candidate.text,
              confidence: 1,
              precision: "low" as const,
            });
            start = text.indexOf(candidate.text, start + 1);
          }
          return findings;
        }),
      };
    },
  };
}

export async function loadSemanticEvalCases(
  path = "evals/semantic_cases.jsonl",
): Promise<SemanticEvalCase[]> {
  return (await Deno.readTextFile(path)).trim().split("\n").map((line) =>
    JSON.parse(line) as SemanticEvalCase
  );
}

export async function runSemanticEvaluation(
  rows: SemanticEvalCase[],
  detector: LocalDetector,
  mode: "offline" | "live",
  model: string,
  // The kinds the detector under test claims. Expectations for other kinds
  // are ignored so a detector is scored on its own contract, not on another's.
  kinds: readonly FindingKind[] = SEMANTIC_FINDING_KINDS,
): Promise<SemanticEvalReport> {
  const counts = Object.fromEntries(
    kinds.map((kind) => [kind, { tp: 0, fp: 0, fn: 0 }]),
  ) as Record<string, { tp: number; fp: number; fn: number }>;
  const latencies: number[] = [];
  let negativeCases = 0;
  let falsePositiveCases = 0;
  let detectorFailures = 0;
  for (const row of rows) {
    const started = performance.now();
    let findings = [] as Awaited<ReturnType<typeof runDetector>>;
    try {
      findings = await runDetector(detector, row.prompt);
    } catch {
      detectorFailures++;
    }
    latencies.push(performance.now() - started);
    const actual = new Set(findings.map((finding) => finding.kind));
    const expected = new Set(row.expectedKinds.filter((kind) => kinds.includes(kind)));
    for (const kind of kinds) {
      if (actual.has(kind) && expected.has(kind)) counts[kind]!.tp++;
      else if (actual.has(kind)) counts[kind]!.fp++;
      else if (expected.has(kind)) counts[kind]!.fn++;
    }
    if (expected.size === 0) {
      negativeCases++;
      if (actual.size > 0) falsePositiveCases++;
    }
  }
  const perKind = Object.fromEntries(
    Object.entries(counts).map(([kind, count]) => [kind, {
      ...count,
      precision: ratio(count.tp, count.tp + count.fp),
      recall: ratio(count.tp, count.tp + count.fn),
    }]),
  ) as SemanticEvalReport["perKind"];
  const values = Object.values(perKind);
  const orderedLatency = latencies.toSorted((a, b) => a - b);
  return {
    suite: "egrysa-semantic-v1",
    mode,
    detector: `${detector.manifest.id}@${detector.manifest.version}`,
    model,
    cases: rows.length,
    perKind,
    macroPrecision: values.reduce((sum, value) => sum + value.precision, 0) / values.length,
    macroRecall: values.reduce((sum, value) => sum + value.recall, 0) / values.length,
    falsePositiveRate: ratio(falsePositiveCases, negativeCases),
    p95AddedLatencyMs: orderedLatency[Math.max(0, Math.ceil(orderedLatency.length * 0.95) - 1)] ??
      0,
    detectorFailures,
    rawPromptsPersisted: false,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
