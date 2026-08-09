import { recompose, recomposeChecked, transform } from "../src/surrogate.ts";
import type { Finding } from "../src/types.ts";

Deno.test("surrogates are consistent within one request and recompose locally", () => {
  const text = "Email a@example.com, then confirm with a@example.com";
  const first = text.indexOf("a@example.com");
  const second = text.lastIndexOf("a@example.com");
  const findings: Finding[] = [first, second].map((start) => ({
    kind: "email",
    start,
    end: start + 13,
    value: "a@example.com",
  }));
  const result = transform(text, findings, new Set(["email"]));
  if (result.mapping.size !== 1) throw new Error("expected one reusable mapping");
  const token = [...result.mapping.keys()][0]!;
  if (result.text.split(token).length !== 3) throw new Error("token was not reused");
  if (recompose(result.text, result.mapping) !== text) throw new Error("recomposition failed");
});

Deno.test("recomposition reports provider-mutated surrogate residue", () => {
  const token = "__EGRYSA_EMAIL_0001_aabbccddeeff__";
  const mapping = new Map([[token, "a@example.com"]]);
  const result = recomposeChecked(token.toLowerCase(), mapping);
  if (!result.residueDetected || result.text.includes("a@example.com")) {
    throw new Error("mutated surrogate residue was not detected");
  }
});

Deno.test("recomposition catches residue with the full leading prefix stripped", () => {
  const token = "__EGRYSA_EMAIL_0001_aabbccddeeff__";
  const mapping = new Map([[token, "a@example.com"]]);
  const result = recomposeChecked("EGRYSA_PII_0__", mapping);
  if (!result.residueDetected) {
    throw new Error("bare surrogate residue was not detected");
  }
  const prose = recomposeChecked("Egrysa is a gateway", mapping);
  if (prose.residueDetected || prose.text !== "Egrysa is a gateway") {
    throw new Error("ordinary product-name prose was mistaken for surrogate residue");
  }
});

Deno.test("transformation rejects overlapping findings defensively", () => {
  let rejected = false;
  try {
    transform("alex@example.com", [
      { kind: "email", start: 0, end: 16, value: "alex@example.com" },
      { kind: "person_name", start: 0, end: 4, value: "alex" },
    ], new Set(["email", "person_name"]));
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("overlap");
  }
  if (!rejected) throw new Error("overlapping transformation findings were accepted");
});

Deno.test("the residue audit ignores ordinary text naming the product", () => {
  const token = "__EGRYSA_EMAIL_0001_aabbccddeeff__";
  const mapping = new Map([[token, "a@example.com"]]);
  // Every form below hard-failed with 502 before the audit keyed on surrogate
  // structure instead of the bare product name.
  for (
    const text of [
      "Mail the team re (egrysa-gateway) today.",
      'Check "egrysa-gateway" before the release.',
      "Logs are under /opt/egrysa-gateway/data.",
      "The model:egrysa-stub entry is unrelated.",
      "Read egrysa_config_file for the settings.",
      "Egrysa is a gateway",
    ]
  ) {
    const result = recomposeChecked(text, mapping);
    if (result.residueDetected) throw new Error(`ordinary text flagged as residue: ${text}`);
    if (result.text !== text) throw new Error(`ordinary text was rewritten: ${text}`);
  }
});

Deno.test("the residue audit still catches a mutated surrogate", () => {
  const token = "__EGRYSA_EMAIL_0001_aabbccddeeff__";
  const mapping = new Map([[token, "a@example.com"]]);
  for (
    const mutated of [
      token.toLowerCase(),
      "__EGRYSA_EMAIL_0001_aabbccddeeff",
      "EGRYSA-EMAIL-0001-aabbccddeeff",
      "EGRYSA_CREDIT_CARD_0003_ff",
      "EGRYSA_PII_0__",
    ]
  ) {
    if (!recomposeChecked(mutated, mapping).residueDetected) {
      throw new Error(`mutated surrogate escaped the audit: ${mutated}`);
    }
  }
});
