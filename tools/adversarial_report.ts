// Measures the deterministic detector floor against the adversarial corpus.
//
// This is a measurement tool, not a release gate. It always exits 0 so that a
// known gap cannot silently become a CI failure. The gating regression suite
// remains `deno task eval` over `evals/cases.jsonl`.
import { classify, createDetectors } from "../src/classifier.ts";
import { loadConfig } from "../src/config.ts";
import { decide } from "../src/policy.ts";
import { FINDING_KINDS, type FindingKind, SENSITIVITIES, type Sensitivity } from "../src/types.ts";

interface Case {
  id: string;
  category: string;
  scenario: string;
  prompt: string;
  expectedKinds: string[];
  expectedDecision: string;
  documentedGap?: string;
}

interface Miss {
  id: string;
  category: string;
  scenario: string;
  missing: string[];
  observed: string[];
  documentedGap?: string;
}

const supported = new Set<string>(FINDING_KINDS);
const requested = Deno.args.find((arg) => arg.startsWith("--sensitivity="))?.split("=")[1];
if (requested !== undefined && !SENSITIVITIES.includes(requested as Sensitivity)) {
  console.error(`--sensitivity must be one of ${SENSITIVITIES.join(", ")}`);
  Deno.exit(2);
}
const loaded = await loadConfig("config/egrysa.example.json");
const config = requested
  ? { ...loaded, policy: { ...loaded.policy, sensitivity: requested as Sensitivity } }
  : loaded;
const sensitivity = config.policy.sensitivity ?? "balanced";
const detectors = createDetectors(config);
const cases = (await Deno.readTextFile("evals/adversarial.jsonl"))
  .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case);

const counts = new Map<string, { tp: number; fp: number; fn: number }>();
const byCategory = new Map<string, { total: number; detected: number }>();
const undisclosedMisses: Miss[] = [];
const disclosedMisses: Miss[] = [];
const falsePositives: Miss[] = [];
let decisionMatches = 0;

const bump = (kind: string, field: "tp" | "fp" | "fn") => {
  const row = counts.get(kind) ?? { tp: 0, fp: 0, fn: 0 };
  row[field]++;
  counts.set(kind, row);
};

for (const item of cases) {
  const findings = await classify(item.prompt, config, detectors);
  const observed = new Set(findings.map((finding) => finding.kind as string));
  const expected = new Set(item.expectedKinds);

  for (const kind of new Set([...observed, ...expected])) {
    if (observed.has(kind) && expected.has(kind)) bump(kind, "tp");
    else if (observed.has(kind)) bump(kind, "fp");
    else bump(kind, "fn");
  }

  const missing = [...expected].filter((kind) => !observed.has(kind));
  // A negative control that fired has not "passed", even though it is missing
  // nothing. Counting it as clean would report a false positive as a success.
  const falsePositive = expected.size === 0 && observed.size > 0;
  const category = byCategory.get(item.category) ?? { total: 0, detected: 0 };
  category.total++;
  if (missing.length === 0 && !falsePositive) category.detected++;
  byCategory.set(item.category, category);

  if (missing.length > 0) {
    // A kind the engine does not model yet cannot be an undisclosed miss.
    const unsupported = missing.some((kind) => !supported.has(kind));
    const miss: Miss = {
      id: item.id,
      category: item.category,
      scenario: item.scenario,
      missing,
      observed: [...observed],
      ...(item.documentedGap ? { documentedGap: item.documentedGap } : {}),
    };
    (item.documentedGap || unsupported ? disclosedMisses : undisclosedMisses).push(miss);
  }

  if (expected.size === 0 && observed.size > 0) {
    falsePositives.push({
      id: item.id,
      category: item.category,
      scenario: item.scenario,
      missing: [],
      observed: [...observed],
    });
  }

  const policy = decide(findings, null, config);
  if (policy.decision === item.expectedDecision) decisionMatches++;
}

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? 1 : numerator / denominator;

const perKind = [...counts.entries()]
  .filter(([kind]) => supported.has(kind as FindingKind))
  .map(([kind, value]) => ({
    kind,
    ...value,
    precision: ratio(value.tp, value.tp + value.fp),
    recall: ratio(value.tp, value.tp + value.fn),
  }))
  .sort((left, right) => left.recall - right.recall);

const detected = cases.length - undisclosedMisses.length - disclosedMisses.length;
const report = {
  suite: "egrysa-adversarial-v1",
  sensitivity,
  note: "Measurement only. Not a release gate. Semantic detector off, shipped example config.",
  cases: cases.length,
  detected,
  undisclosedMisses: undisclosedMisses.length,
  disclosedMisses: disclosedMisses.length,
  falsePositiveCases: falsePositives.length,
  decisionAccuracy: ratio(decisionMatches, cases.length),
  perKind,
  byCategory: Object.fromEntries(
    [...byCategory.entries()].map(([name, value]) => [name, {
      ...value,
      rate: ratio(value.detected, value.total),
    }]),
  ),
  undisclosed: undisclosedMisses,
  disclosed: disclosedMisses,
  falsePositives,
};

if (Deno.args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(`\nEgrysa adversarial detector report (${report.suite}, sensitivity=${sensitivity})`);
  console.log(`${report.note}\n`);
  console.log(
    `  cases ${report.cases}   fully detected ${detected}   ` +
      `undisclosed misses ${report.undisclosedMisses}   ` +
      `disclosed gaps ${report.disclosedMisses}   ` +
      `false positives ${report.falsePositiveCases}`,
  );
  console.log(`  decision accuracy ${pct(report.decisionAccuracy)}\n`);

  console.log("  Per kind (lowest recall first)");
  for (const row of perKind) {
    console.log(
      `    ${row.kind.padEnd(20)} recall ${pct(row.recall).padStart(6)}   ` +
        `precision ${pct(row.precision).padStart(6)}   tp ${row.tp} fp ${row.fp} fn ${row.fn}`,
    );
  }

  console.log("\n  Per category");
  for (const [name, value] of Object.entries(report.byCategory)) {
    console.log(`    ${name.padEnd(22)} ${value.detected}/${value.total}  ${pct(value.rate)}`);
  }

  if (undisclosedMisses.length) {
    console.log("\n  UNDISCLOSED MISSES (not covered by a documented exclusion)");
    for (const miss of undisclosedMisses) {
      const found = miss.observed.length ? miss.observed.join(",") : "nothing";
      console.log(`    ${miss.id.padEnd(10)} ${miss.scenario}`);
      console.log(`               missing ${miss.missing.join(",")} | found ${found}`);
    }
  }

  if (falsePositives.length) {
    console.log("\n  FALSE POSITIVES (negative controls that matched)");
    for (const miss of falsePositives) {
      console.log(`    ${miss.id.padEnd(10)} ${miss.scenario} -> ${miss.observed.join(",")}`);
    }
  }

  console.log("\n  Disclosed gaps behaving as documented");
  for (const miss of disclosedMisses) {
    console.log(`    ${miss.id.padEnd(10)} ${miss.scenario}`);
  }
  console.log("");
}
