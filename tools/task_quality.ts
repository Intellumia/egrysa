// Task-quality measurement: does routing a request through Egrysa change the
// answer the model gives?
//
// This is CISO-brief acceptance gate 3, the one gate nobody had measured. The
// question it answers is narrow and falsifiable: for the same prompt and the
// same model, does the surrogate round trip degrade the result? Each case runs
// twice, once straight to the provider and once through an in-process gateway
// that transforms the sensitive values on the way out and restores them on the
// way back, and both answers are scored against the same assertions.
//
// Scoring is deterministic. Every case carries assertions about what a correct
// answer must contain, must not contain, must order, or must shape as JSON;
// there is no model judging another model. Alongside the pass rates it reports
// a lexical similarity between the two answers, any case where a surrogate
// token survived into the final answer, and the latency of each arm. Models
// are stochastic, so each case runs several times and the spread is reported.
//
// Run with `deno task eval:quality`. It needs a configured provider that can
// actually answer, so it is opt-in and is skipped by the evidence bundle
// unless one is named.
//
// Flags:
//   --config=PATH      gateway configuration (default: $EGRYSA_CONFIG or config/egrysa.example.json)
//   --provider=ID      provider id from that configuration (default: policy.defaultProvider)
//   --model=NAME       model to use (default: that provider's first allowed model)
//   --repeats=N        runs per case per arm (default 3)
//   --cases=PATH       corpus (default evals/task_quality.jsonl)
//   --out=PATH         also write the JSON report here
//
// Nothing printed carries a prompt or an answer: the report holds identifiers,
// counts, scores, and timings. The corpus values are synthetic and use
// documentation-reserved domains, numbers, and addresses.

import { Gateway } from "../src/gateway.ts";
import { loadConfig } from "../src/config.ts";
import { bytesToBase64, sha256 } from "../src/crypto.ts";
import { invokeProvider } from "../src/providers.ts";
import type { AppConfig, ChatMessage, ChatTool, ProviderConfig } from "../src/types.ts";

interface Assertion {
  type: "contains" | "absent" | "order" | "jsonKeys";
  value?: string;
  values?: string[];
  keys?: string[];
}

interface Case {
  id: string;
  category: string;
  scenario: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  must: Assertion[];
}

interface ArmRun {
  score: number;
  passed: boolean;
  ms: number;
  answer: string;
  decision: string;
  failed: string[];
  error?: string;
}

interface CaseResult {
  id: string;
  category: string;
  baseline: { passRate: number; meanScore: number; p50Ms: number };
  gateway: { passRate: number; meanScore: number; p50Ms: number; decisions: string[] };
  similarity: number;
  surrogateResidue: number;
  failedAssertions: { baseline: string[]; gateway: string[] };
}

const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 400;

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    if (arg === "--") continue;
    const separator = arg.indexOf("=");
    const name = separator < 0 ? arg : arg.slice(0, separator);
    const value = separator < 0 ? undefined : arg.slice(separator + 1);
    if (!name.startsWith("--") || value === undefined) {
      console.error(`unknown argument: ${arg}`);
      Deno.exit(2);
    }
    out[name.slice(2)] = value;
  }
  return out;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// The gateway reads its keys from the environment, exactly as in deployment.
async function configureEnvironment(): Promise<string> {
  const clientKey = randomHex(24);
  Deno.env.set("EGRYSA_INBOUND_KEYS", `quality-workload=${clientKey}`);
  Deno.env.set("EGRYSA_RECEIPT_FINGERPRINT_KEY", randomHex(32));
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  Deno.env.set(
    "EGRYSA_RECEIPT_ED25519_PRIVATE_KEY",
    bytesToBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  Deno.env.set(
    "EGRYSA_RECEIPT_ED25519_PUBLIC_KEY",
    bytesToBase64(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  return clientKey;
}

// Everything the model produced that a user would read or act on: the reply
// text and any tool-call arguments, which carry values just as content does.
function answerText(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const parts: string[] = [];
  for (const choice of choices) {
    const message = (choice as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (typeof message?.content === "string") parts.push(message.content);
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const call of calls) {
      const fn = (call as Record<string, unknown>).function as Record<string, unknown> | undefined;
      if (typeof fn?.arguments === "string") parts.push(fn.arguments);
    }
  }
  return parts.join("\n");
}

function check(answer: string, assertion: Assertion): { ok: boolean; label: string } {
  switch (assertion.type) {
    case "contains":
      return { ok: answer.includes(assertion.value ?? ""), label: `contains(${assertion.value})` };
    case "absent":
      return { ok: !answer.includes(assertion.value ?? ""), label: `absent(${assertion.value})` };
    case "order": {
      let cursor = -1;
      for (const value of assertion.values ?? []) {
        const index = answer.indexOf(value, cursor + 1);
        if (index <= cursor) return { ok: false, label: `order(${assertion.values?.join(",")})` };
        cursor = index;
      }
      return { ok: true, label: `order(${assertion.values?.join(",")})` };
    }
    case "jsonKeys": {
      const start = answer.indexOf("{");
      const end = answer.lastIndexOf("}");
      if (start < 0 || end <= start) return { ok: false, label: "jsonKeys(no object)" };
      try {
        const parsed = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>;
        const missing = (assertion.keys ?? []).filter((key) => !(key in parsed));
        return { ok: missing.length === 0, label: `jsonKeys(${missing.join(",") || "ok"})` };
      } catch {
        return { ok: false, label: "jsonKeys(unparseable)" };
      }
    }
  }
}

function score(answer: string, must: Assertion[]): { score: number; failed: string[] } {
  const failed: string[] = [];
  for (const assertion of must) {
    const result = check(answer, assertion);
    if (!result.ok) failed.push(result.label);
  }
  return { score: (must.length - failed.length) / must.length, failed };
}

// Token-level F1 between the two arms' answers. It says how far the wording
// moved, not whether the answer is right; the assertions above say that.
function similarity(a: string, b: string): number {
  const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}@._+-]+/gu) ?? [];
  const left = tokens(a);
  const right = tokens(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  let overlap = 0;
  for (const token of right) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      overlap++;
      counts.set(token, remaining - 1);
    }
  }
  const precision = overlap / right.length;
  const recall = overlap / left.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function runBaseline(
  provider: ProviderConfig,
  model: string,
  testCase: Case,
): Promise<ArmRun> {
  const started = performance.now();
  try {
    const invocation = await invokeProvider(provider, {
      model,
      messages: testCase.messages,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      ...(testCase.tools ? { tools: testCase.tools } : {}),
    }, TIMEOUT_MS);
    if (invocation.type !== "json") throw new Error("expected a non-streaming response");
    const answer = answerText(invocation.data);
    const scored = score(answer, testCase.must);
    return {
      ...scored,
      passed: scored.failed.length === 0,
      ms: performance.now() - started,
      answer,
      decision: "direct",
    };
  } catch (error) {
    return {
      score: 0,
      failed: ["error"],
      passed: false,
      ms: performance.now() - started,
      answer: "",
      decision: "error",
      error: (error as Error).message,
    };
  }
}

async function runGateway(
  gateway: Gateway,
  clientKey: string,
  model: string,
  testCase: Case,
): Promise<ArmRun> {
  const started = performance.now();
  const response = await gateway.handle(
    new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: testCase.messages,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        ...(testCase.tools ? { tools: testCase.tools } : {}),
      }),
    }),
  );
  const ms = performance.now() - started;
  const decision = response.headers.get("x-egrysa-decision") ?? `http_${response.status}`;
  const text = await response.text();
  if (response.status !== 200) {
    // A refusal is a task-quality outcome like any other: the caller gets no
    // answer. Name it by the gateway's own problem type, so a fail-closed
    // recomposition refusal is distinguishable from a policy denial.
    let named = decision;
    try {
      named = (JSON.parse(text) as { title?: string }).title ?? decision;
    } catch {
      // A non-JSON body leaves the status as the label.
    }
    return {
      score: 0,
      failed: [`refused(${named})`],
      passed: false,
      ms,
      answer: "",
      decision: named,
      error: named,
    };
  }
  const answer = answerText(JSON.parse(text) as Record<string, unknown>);
  const scored = score(answer, testCase.must);
  return { ...scored, passed: scored.failed.length === 0, ms, answer, decision };
}

const args = parseArgs(Deno.args);
const configPath = args.config ?? Deno.env.get("EGRYSA_CONFIG") ?? "config/egrysa.example.json";
const casesPath = args.cases ?? "evals/task_quality.jsonl";
const repeats = Math.max(1, Number(args.repeats ?? 3) || 3);

const config: AppConfig = await loadConfig(configPath);
const providerId = args.provider ?? config.policy.defaultProvider;
const provider = config.providers.find((candidate) => candidate.id === providerId);
if (!provider) {
  console.error(`provider ${providerId} is not in ${configPath}`);
  Deno.exit(2);
}
const model = args.model ?? provider.allowedModels[0]!;
if (!provider.allowedModels.includes(model)) {
  console.error(`model ${model} is not allowed for provider ${providerId}`);
  Deno.exit(2);
}

const corpusText = await Deno.readTextFile(casesPath);
const cases: Case[] = corpusText.split("\n").filter((line) => line.trim()).map((line) =>
  JSON.parse(line)
);
const corpusDigest = await sha256(corpusText);

const clientKey = await configureEnvironment();
const gatewayConfig: AppConfig = {
  ...structuredClone(config),
  receiptLogPath: ":memory:",
  policy: { ...structuredClone(config.policy), defaultProvider: providerId },
};
const gateway = await Gateway.create(gatewayConfig);

const results: CaseResult[] = [];
let residueTotal = 0;
try {
  for (const testCase of cases) {
    const baseline: ArmRun[] = [];
    const gatewayRuns: ArmRun[] = [];
    for (let run = 0; run < repeats; run++) {
      baseline.push(await runBaseline(provider, model, testCase));
      gatewayRuns.push(await runGateway(gateway, clientKey, model, testCase));
    }
    const residue = gatewayRuns.filter((run) => /__EGRYSA_/.test(run.answer)).length;
    residueTotal += residue;
    results.push({
      id: testCase.id,
      category: testCase.category,
      baseline: {
        passRate: mean(baseline.map((run) => (run.passed ? 1 : 0))),
        meanScore: mean(baseline.map((run) => run.score)),
        p50Ms: median(baseline.map((run) => run.ms)),
      },
      gateway: {
        passRate: mean(gatewayRuns.map((run) => (run.passed ? 1 : 0))),
        meanScore: mean(gatewayRuns.map((run) => run.score)),
        p50Ms: median(gatewayRuns.map((run) => run.ms)),
        decisions: [...new Set(gatewayRuns.map((run) => run.decision))],
      },
      similarity: mean(
        baseline.map((run, index) => similarity(run.answer, gatewayRuns[index]!.answer)),
      ),
      surrogateResidue: residue,
      failedAssertions: {
        baseline: [...new Set(baseline.flatMap((run) => run.failed))],
        gateway: [...new Set(gatewayRuns.flatMap((run) => run.failed))],
      },
    });
    const last = results[results.length - 1]!;
    console.error(
      `  ${last.id.padEnd(8)} ${last.category.padEnd(14)} baseline ${
        (last.baseline.passRate * 100).toFixed(0).padStart(3)
      }%  gateway ${(last.gateway.passRate * 100).toFixed(0).padStart(3)}%  similarity ${
        last.similarity.toFixed(2)
      }`,
    );
  }
} finally {
  await gateway.close();
}

const categories = [...new Set(results.map((result) => result.category))].sort();
const baselinePass = mean(results.map((result) => result.baseline.passRate));
const gatewayPass = mean(results.map((result) => result.gateway.passRate));
const report = {
  schemaVersion: "1" as const,
  generatedAt: new Date().toISOString(),
  suite: "egrysa-task-quality-v1",
  provider: { id: providerId, kind: provider.kind, model },
  repeats,
  corpus: { path: casesPath, cases: cases.length, sha256: corpusDigest },
  summary: {
    baselinePassRate: baselinePass,
    gatewayPassRate: gatewayPass,
    degradation: baselinePass - gatewayPass,
    meanSimilarity: mean(results.map((result) => result.similarity)),
    surrogateResidueRuns: residueTotal,
    baselineP50Ms: median(results.map((result) => result.baseline.p50Ms)),
    gatewayP50Ms: median(results.map((result) => result.gateway.p50Ms)),
  },
  categories: categories.map((category) => {
    const inCategory = results.filter((result) => result.category === category);
    return {
      category,
      baselinePassRate: mean(inCategory.map((result) => result.baseline.passRate)),
      gatewayPassRate: mean(inCategory.map((result) => result.gateway.passRate)),
      meanSimilarity: mean(inCategory.map((result) => result.similarity)),
    };
  }),
  cases: results,
};

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  await Deno.writeTextFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`\nreport written to ${args.out}`);
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
console.error(`
Egrysa task quality (${report.suite}), ${providerId}/${model}, ${repeats} runs per case
Corpus ${casesPath} sha256 ${corpusDigest}

  baseline pass rate   ${percent(baselinePass)}
  gateway pass rate    ${percent(gatewayPass)}
  degradation          ${percent(report.summary.degradation)}  (acceptance gate: under 10%)
  mean similarity      ${report.summary.meanSimilarity.toFixed(3)}
  surrogate residue    ${residueTotal} runs
  p50 latency          ${report.summary.baselineP50Ms.toFixed(0)} ms direct, ${
  report.summary.gatewayP50Ms.toFixed(0)
} ms through the gateway

  Per category (baseline -> gateway)`);
for (const category of report.categories) {
  console.error(
    `    ${category.category.padEnd(14)} ${percent(category.baselinePassRate).padStart(6)} -> ${
      percent(category.gatewayPassRate).padStart(6)
    }   similarity ${category.meanSimilarity.toFixed(2)}`,
  );
}
if (residueTotal > 0) {
  console.error("\n  A surrogate token survived into an answer. That is a recomposition failure.");
  Deno.exit(1);
}
