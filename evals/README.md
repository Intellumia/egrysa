# Synthetic exposure benchmark

`cases.jsonl` is the versioned, publishable baseline for deterministic detector and policy behavior.
Each line contains an ID, scenario, synthetic prompt, exact expected finding kinds, and expected
policy decision. Fixtures must never contain customer prompts or live credentials.

`deno task eval` reports case accuracy, decision accuracy, per-class precision and recall,
false-positive cases, high-severity routing failures, transformation leakage, deterministic
round-trip fidelity, local classifier/policy time, and an offline semantic report from
`semantic_cases.jsonl` using the deterministic CI stub.

`semantic_cases.jsonl` is a separate 18-case semantic suite: four labelled positives for each
reference semantic kind and six negatives. `deno task eval:semantic` runs the same cases against the
enabled customer-local model selected by `EGRYSA_CONFIG`; it is evidence-only and does not gate
release recall.

`conformance/` holds dated, content-free provider reports produced by
`deno task conformance -- --provider <id>`. Wire checks gate that individual run; surrogate fidelity
is informational. No live report is committed until its provider endpoint has actually been tested.
See [`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md) for the report and contribution workflow.

Contribution rules:

1. Prefer adversarial and false-positive cases over repetitions of obvious formats.
2. Use reserved documentation values for payment cards and network addresses. Write credentials as
   seeded placeholders, `{{rand:<alphabet>:<length>}}`, expanded by `src/corpus.ts` at load time:
   the committed file then holds nothing a scanner flags, while the measurement runs on values a
   scanner takes seriously. Every report prints the corpus SHA-256 it measured.
3. Label independently when a fixture is intended to support an external evaluation claim.
4. Keep model-answer utility and semantic-inference suites separate from this exact-token baseline.
5. Record known limitations; a passing implementation-authored corpus is not real-world recall.
