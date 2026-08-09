# CISO brief

## Decision

Approve a bounded technical evaluation, not production deployment. The evaluation should answer one
question: can a customer-owned gateway materially reduce sensitive-data exposure without
unacceptable answer degradation or operational friction?

## Risk addressed

Enterprise AI requests may contain regulated data, credentials, internal identifiers, strategic
plans, and patterns that reveal how the organization operates. Provider promises reduce risk but do
not give the customer an independent enforcement point or request-level evidence.

Egrysa inserts that enforcement point inside the customer boundary. It blocks secrets, replaces
selected identifiers with request-scoped surrogates, forces designated topics to local inference,
restricts models and endpoints, and records what policy was applied without recording content.

## Evidence available now

| Control                      | Repository evidence                                                                                                                                                                           | Residual risk                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| No raw content logging       | Structured logger records event type only; receipts contain keyed fingerprints and counts                                                                                                     | Runtime or host compromise can still observe process memory                                                                  |
| Secret denial                | Deterministic rules plus regression tests                                                                                                                                                     | Unknown secret formats and obfuscation may evade rules                                                                       |
| PII transformation           | Request-scoped surrogate map and local recomposition                                                                                                                                          | Entity detection is not comprehensive; output quality may change                                                             |
| Confidential routing         | Configured terms force a local provider                                                                                                                                                       | Taxonomy must be maintained; conceptual references may evade exact terms                                                     |
| Provider restriction         | HTTPS, model allowlists, fixed base URLs, no redirects                                                                                                                                        | DNS, CA, provider account, and contract remain external dependencies                                                         |
| Provider non-storage request | `store:false` forced for OpenAI-compatible calls                                                                                                                                              | This is not proof of deletion or ZDR entitlement                                                                             |
| Audit evidence               | Durable Ed25519 receipts; workload ID; keyed fingerprint; signed chain checkpoint                                                                                                             | Single-writer log; external anchoring remains operator-owned                                                                 |
| Runtime confinement          | Deno scoped permissions; Kubernetes non-root/read-only/seccomp/network policy                                                                                                                 | Cluster and host controls remain customer responsibilities                                                                   |
| Supply chain                 | Zero third-party runtime packages, pinned CI actions, SBOM and provenance workflows                                                                                                           | Base images and build platform still require verification                                                                    |
| Human decision on ambiguity  | `policy.sensitivity: review` holds a low-precision finding, returns 409 with a receipt identifier and no matched value, and proceeds only on a single-use acknowledgement naming that receipt | Holds are tracked in memory and cleared by a restart; the acknowledging identity is the calling workload, not a named person |
| Measured detection coverage  | Published per-class recall and precision against an adversarial corpus, reproducible with `deno task eval:adversarial` ([detection coverage](DETECTION_COVERAGE.md))                          | The corpus is maintainer-authored; encoding and obfuscation are open measured gaps                                           |

## Evaluation boundary

Use synthetic data, one business workflow, one local model, and one contracted remote API project.
Do not connect productivity suites, tools, file uploads, or durable memory. Do not process PHI,
payment-card data, export-controlled data, or production secrets.

## Acceptance gates

These are the gates for approving an evaluation. Status below is the project's own position, stated
so a reviewer does not have to infer it. "Customer-owned" means the gate cannot be satisfied by this
repository because it depends on the customer's taxonomy, contracts, or environment.

| # | Gate                                                                                                                                  | Status                                | Basis                                                                                                                                                                                                                                                    |
| - | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Zero high-severity exact-secret leaks across an independently authored corpus                                                         | **Partially met**                     | `deno task eval` reports `highSeverityLeaks: 0` and `transformLeakage: 0`. The corpus is maintainer-authored, so the independence condition is **not** satisfied                                                                                         |
| 2 | At least 95% detection recall for the approved data taxonomy, measured separately by class                                            | **Customer-owned, evidence supplied** | See the reconciliation below                                                                                                                                                                                                                             |
| 3 | Less than 10% task-quality degradation against an unfiltered baseline                                                                 | **Not met**                           | No task-quality measurement exists. This must be measured during the evaluation                                                                                                                                                                          |
| 4 | Less than 200 ms p95 local policy overhead at target concurrency                                                                      | **Partially met**                     | Classification and policy average 0.16 ms per request, and the reference semantic detector adds 0.06 ms at p95, both measured single-threaded. Not yet measured at a target concurrency                                                                  |
| 5 | No raw content in logs, metrics, errors, traces, crash reports, or receipts                                                           | **Partially met**                     | Receipts are asserted content-free by tests, and the evaluation reports `rawPromptsPersisted: false`. Log minimisation is a design property of the structured logger but is **not** asserted by a test; crash reports and traces are not asserted either |
| 6 | Provider contract, retention mode, region, BAA/DPA status, and feature eligibility documented                                         | **Customer-owned**                    | See "Provider facts that must not be collapsed" in the [control mapping](COMPLIANCE.md)                                                                                                                                                                  |
| 7 | Red-team coverage for encoding, spacing, prompt injection, surrogate exfiltration, oversized inputs, SSRF, and provider error leakage | **Partially met**                     | Surrogate exfiltration, oversized inputs, SSRF, and tool handling have controls and tests. Encoding and spacing are measured gaps, published in [detection coverage](DETECTION_COVERAGE.md) and tracked as open issues                                   |
| 8 | External security review before production                                                                                            | **Not met**                           | Not yet commissioned                                                                                                                                                                                                                                     |

### Reconciling gate 2 with published coverage

The [detection coverage](DETECTION_COVERAGE.md) report shows per-class recall well below 95% for
several classes. That is not a failure of gate 2, and the two numbers measure different things.

- The **regression suite** (`deno task eval`) covers well-formed values in the shipped taxonomy and
  reports 100% per-class recall. This is the closest analogue to gate 2 on the shipped taxonomy.
- The **adversarial suite** (`deno task eval:adversarial`) deliberately over-samples encoded,
  obfuscated, and internationalised shapes, including formats the engine was never built to handle.
  It is a lower bound under pressure, published so the edges are visible.

Gate 2 is assessed against **the customer's approved taxonomy on the customer's corpus**, which is
why it is marked customer-owned. Neither maintainer number substitutes for that measurement. A
customer whose taxonomy includes the shapes in the adversarial suite should expect results closer to
that report than to the regression suite, and should read both before setting a threshold.

## Commercial posture

Open-source the data plane under Apache-2.0. Monetize enterprise policy administration, identity and
tenant controls, evidence export, approved-provider registry, HSM-backed signing, support, long-term
maintenance, and deployment assurance. Do not monetize by observing customer prompts.

## Certification posture

The project is not SOC 2, ISO 27001, HIPAA, PCI DSS, or GDPR certified/compliant. It supplies
technical controls and evidence that can support an organization's program. Certification requires
operating controls, governance, people, contracts, and independent assessment beyond this code.
