# Egrysa: canonical product truth

## Mission

Keep enterprise context, policy, memory, evaluations, and learning inside the customer boundary
while making frontier models replaceable compute suppliers.

## Product claim

Egrysa is a customer-owned AI egress control plane. It reduces disclosure through deterministic
blocking, minimization, request-scoped surrogates, local-only routing, and content-minimized,
cryptographically signed policy evidence.

It is not a VPN, an anonymity guarantee, a DLP replacement, a compliance certificate, or proof that
a model provider forgot data. Inference requests do not directly update model weights; provider
logging, retention, safety review, later training, and commercial learning are separate risks
governed by product behavior and contract.

## Current state

Built: OpenAI-compatible text ingress, native or emulated SSE streaming across the shipped provider
adapters, explicit provider capability profiles and downgrade disclosure, bounded function-tool
messages, model discovery, deterministic classification, an opt-in reference local semantic detector
for person names, physical addresses, and semantically confidential content, policy routing, local
recomposition, durable Ed25519-signed attributed receipts, a provider conformance harness, tests,
synthetic evals, CI, and hardened deployment examples.

Not built: identity federation, tenant administration, multi-replica receipt sequencing, HSM
signing, multimodal inspection, autonomous tool execution, native Anthropic streaming,
cross-provider decomposition, provider-control verification, hardware appliance, or third-party
certification.

The first announced evaluation release is `v0.1.0-alpha.3`, commit
`5ffc6aa1fdc5c193928899ea438f0db0cae9688b`. Its protected-main CI, signed image, CycloneDX SBOM,
SLSA provenance, and public release assets were independently verified before announcement.

## Active work: alpha.4 review remediation

Start with [the alpha.4 remediation plan](docs/ALPHA4_REMEDIATION_PLAN.md). It records the validated
adversarial-review findings, rejected advice, receipt-v5 design decision, four-PR sequence, and
acceptance gates. No review fix has been implemented yet.

The next session starts with PR 1 only: cap inspection surfaces and tool-schema work, bound detector
concurrency and semantic candidate processing, add inbound-read deadlines, cache detectors, and add
direct auth/crypto negative tests. Do not start receipt v5 or roadmap 0.2 work in the same change
set.

Preserve these decisions:

- append a signed egress attempt before provider invocation and a linked outcome afterward; never
  mutate a signed receipt;
- introduce canonical signing in v5 while keeping v2-v4 verification byte-for-byte compatible;
- never log upstream body snippets or arbitrary error text; and
- treat externally retained checkpoints, not same-filesystem sidecars, as the rollback anchor.

## Non-negotiable rules

1. Never log or persist raw prompt, response, surrogate map, provider key, or client key.
2. Fail closed when a provider, model, data class, or API feature is not explicitly approved.
3. Never claim zero retention solely because `store=false` was sent.
4. Never claim certification. Say control-aligned or readiness evidence only.
5. Do not add a dependency where a reviewed platform primitive is sufficient.
6. Every new input modality, tool, streaming path, memory store, and provider is a new threat
   boundary requiring tests and documentation.
7. Preserve the OpenAI-compatible ingress unless a versioned breaking change is approved.

## Release gates

- Formatting, lint, type checking, tests, CodeQL, dependency review, and vulnerability audit pass.
- No high-severity exact secret leaves the policy layer in the evaluation corpus.
- Classifier and decision accuracy are at least 95% on the versioned evaluation set.
- No raw content appears in logs, metrics, errors, or receipts.
- Container runs as non-root with read-only root filesystem, dropped capabilities, seccomp, explicit
  egress, and no service-account token.
- SBOM and SLSA provenance accompany release artifacts.
- CISO-facing documentation matches demonstrated behavior.
- Alpha.4 satisfies the bounded-work, receipt-before-egress, canonical-verification, timeout,
  redaction, and negative-test gates in `docs/ALPHA4_REMEDIATION_PLAN.md` before tagging.
