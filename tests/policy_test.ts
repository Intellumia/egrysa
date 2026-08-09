import { decide } from "../src/policy.ts";
import type { Finding, FindingKind } from "../src/types.ts";
import { testConfig } from "./fixtures.ts";

const finding = (kind: FindingKind): Finding => ({ kind, start: 0, end: 1, value: "x" });

Deno.test("policy denies secrets before provider routing", () => {
  const result = decide([finding("credit_card")], null, testConfig());
  if (result.decision !== "deny" || result.provider !== null) {
    throw new Error("secret was not denied");
  }
});

Deno.test("policy forces confidential terms to local inference", () => {
  const result = decide([finding("confidential_term")], "remote", testConfig());
  if (result.decision !== "local_only" || result.provider?.id !== "local") {
    throw new Error("local route was not enforced");
  }
});

Deno.test("policy transforms PII and fails closed on unclassified raw remote egress", () => {
  if (decide([finding("email")], null, testConfig()).decision !== "transform") {
    throw new Error("PII was not transformed");
  }
  if (decide([], null, testConfig()).decision !== "deny") {
    throw new Error("raw remote egress did not fail closed");
  }
});

Deno.test("low-precision blocked candidates route locally instead of denying", () => {
  const candidate = {
    ...finding("credit_card"),
    precision: "low" as const,
    confidence: 0.6,
  };
  const result = decide([candidate], "remote", testConfig());
  if (result.decision !== "local_only" || result.provider?.id !== "local") {
    throw new Error("low-precision blocked candidate was allowed to hard-deny or leave locally");
  }
});

Deno.test("low-precision semantic findings retain their configured transform action", () => {
  const candidate = {
    ...finding("person_name"),
    precision: "low" as const,
    confidence: 0.7,
  };
  if (decide([candidate], null, testConfig()).decision !== "transform") {
    throw new Error("semantic transform policy was not preserved");
  }
});

Deno.test("sensitivity switches how a low-precision blocked finding is handled", async () => {
  const { classify } = await import("../src/classifier.ts");
  const base = testConfig();
  const findings = await classify(
    "Set aws_secret_access_key=wJalrXUtnFEMI/K7MDENGbPxRfiCYEXAMPLEKEY now.",
    base,
  );
  const low = findings.filter((finding) => finding.precision === "low");
  if (low.length === 0) throw new Error("expected a low-precision finding");

  const at = (sensitivity: "strict" | "balanced" | "review") =>
    decide(findings, null, { ...base, policy: { ...base.policy, sensitivity } });

  if (at("strict").decision !== "deny") throw new Error("strict must deny");
  if (at("balanced").decision !== "local_only") throw new Error("balanced must route local");
  if (at("balanced").reviewRequired) throw new Error("balanced must not hold");
  if (!at("review").reviewRequired) throw new Error("review must hold");
  if (at("review").decision !== "local_only") {
    throw new Error("review must carry the decision that applies once acknowledged");
  }
});

Deno.test("omitted sensitivity behaves exactly as balanced", async () => {
  const { classify } = await import("../src/classifier.ts");
  const base = testConfig();
  const findings = await classify("token=abcdefghijklmnop", base);
  const implicit = decide(findings, null, base);
  const explicit = decide(findings, null, {
    ...base,
    policy: { ...base.policy, sensitivity: "balanced" as const },
  });
  if (implicit.decision !== explicit.decision) throw new Error("default drifted from balanced");
  if (implicit.reviewRequired) throw new Error("default must not hold");
});

Deno.test("a high-precision blocked finding denies in every sensitivity", async () => {
  const { classify } = await import("../src/classifier.ts");
  const base = testConfig();
  const findings = await classify("Secret sk-proj-abcdefghijklmnopqrstuvwxyz123456.", base);
  for (const sensitivity of ["strict", "balanced", "review"] as const) {
    const result = decide(findings, null, { ...base, policy: { ...base.policy, sensitivity } });
    if (result.decision !== "deny") throw new Error(`${sensitivity} failed to deny`);
    if (result.reviewRequired) throw new Error(`${sensitivity} offered review for a hard deny`);
  }
});
