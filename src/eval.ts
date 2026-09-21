import { classify } from "./classifier.ts";
import { loadConfig } from "./config.ts";
import { loadCorpus } from "./corpus.ts";
import { decide } from "./policy.ts";
import {
  loadSemanticEvalCases,
  offlineSemanticEvalDetector,
  runSemanticEvaluation,
} from "./semantic_eval.ts";
import { recompose, transform } from "./surrogate.ts";
import { type Decision, FINDING_KINDS, type FindingKind } from "./types.ts";

interface EvalCase {
  id: string;
  scenario: string;
  prompt: string;
  expectedKinds: FindingKind[];
  expectedDecision: Decision;
}

const config = await loadConfig("config/egrysa.example.json");
const corpus = await loadCorpus<EvalCase>("evals/cases.jsonl");
const rows = corpus.cases;
const counts = Object.fromEntries(
  FINDING_KINDS.map((kind) => [kind, { tp: 0, fp: 0, fn: 0 }]),
) as Record<FindingKind, { tp: number; fp: number; fn: number }>;
let exactKindCases = 0;
let correctDecisions = 0;
let highSeverityLeaks = 0;
let falsePositiveCases = 0;
let transformCases = 0;
let successfulRoundTrips = 0;
let transformLeakage = 0;
const started = performance.now();

for (const row of rows) {
  const findings = await classify(row.prompt, config);
  const actual = new Set(findings.map((finding) => finding.kind));
  const expected = new Set(row.expectedKinds);
  for (const kind of FINDING_KINDS) {
    if (actual.has(kind) && expected.has(kind)) counts[kind].tp++;
    else if (actual.has(kind)) counts[kind].fp++;
    else if (expected.has(kind)) counts[kind].fn++;
  }
  const exact = actual.size === expected.size && [...actual].every((kind) => expected.has(kind));
  if (exact) exactKindCases++;
  if (!expected.size && actual.size) falsePositiveCases++;
  const policy = decide(findings, null, config);
  if (policy.decision === row.expectedDecision) correctDecisions++;
  if (
    [
      "credit_card",
      "private_key",
      "api_secret",
      "ssn",
      "aadhaar",
      "india_pan",
      "uk_nino",
      "nhs_number",
      "passport",
      "bank_account",
      "prompt_injection",
    ].some((kind) => row.expectedKinds.includes(kind as FindingKind)) && policy.decision !== "deny"
  ) highSeverityLeaks++;
  if (policy.decision === "transform") {
    transformCases++;
    const result = transform(row.prompt, findings, new Set(config.policy.transformKinds));
    if ([...result.mapping.values()].some((raw) => result.text.includes(raw))) transformLeakage++;
    if (recompose(result.text, result.mapping) === row.prompt) successfulRoundTrips++;
  }
}

const elapsed = performance.now() - started;
const semantic = await runSemanticEvaluation(
  await loadSemanticEvalCases(),
  offlineSemanticEvalDetector(),
  "offline",
  "egrysa.eval.semantic-stub@1.0.0",
);
const perKind = Object.fromEntries(
  Object.entries(counts).map(([kind, value]) => {
    const precision = ratio(value.tp, value.tp + value.fp);
    const recall = ratio(value.tp, value.tp + value.fn);
    return [kind, { ...value, precision, recall }];
  }),
);
const measured = Object.values(perKind).filter((value) => value.tp + value.fp + value.fn > 0);
const macroPrecision = measured.reduce((sum, value) => sum + value.precision, 0) / measured.length;
const macroRecall = measured.reduce((sum, value) => sum + value.recall, 0) / measured.length;
const report = {
  suite: "egrysa-synthetic-v2",
  corpusDigest: corpus.digest,
  cases: rows.length,
  exactKindCaseAccuracy: exactKindCases / rows.length,
  decisionAccuracy: correctDecisions / rows.length,
  macroPrecision,
  macroRecall,
  perKind,
  falsePositiveCases,
  highSeverityLeaks,
  transformLeakage,
  transformationRoundTripAccuracy: ratio(successfulRoundTrips, transformCases),
  meanClassifierPolicyMs: elapsed / rows.length,
  rawPromptsPersisted: false,
  semantic,
};
console.log(JSON.stringify(report, null, 2));
if (
  report.macroPrecision < 0.95 || report.macroRecall < 0.95 ||
  report.decisionAccuracy < 0.95 || highSeverityLeaks > 0 || transformLeakage > 0 ||
  report.transformationRoundTripAccuracy < 1 ||
  semantic.macroPrecision < 0.95 || semantic.macroRecall < 0.95 ||
  semantic.falsePositiveRate > 0 || semantic.detectorFailures > 0
) Deno.exit(1);

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}
