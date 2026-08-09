# Threat model

## Assets

Prompt and response content; enterprise identifiers and strategy; credentials; provider and client
keys; policy configuration; surrogate maps; receipts; provider selection; availability.

## Trust boundaries

1. Client to Egrysa.
2. Egrysa process to configuration and secret injection.
3. Egrysa to the optional customer-hosted semantic detector.
4. Egrysa to local inference.
5. Customer egress to remote provider.
6. Build system to release artifact.

## In-scope threats and controls

| Threat                                  | Primary controls                                                                                                               | Remaining exposure                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Accidental secret disclosure            | block classes, fail-closed policy, model allowlists                                                                            | novel or encoded formats                                                                                                               |
| PII disclosure                          | deterministic detection, request-scoped surrogates                                                                             | missed entities and semantic inference                                                                                                 |
| Company re-identification               | configurable confidential terms, local-only routing                                                                            | cumulative semantic clues across clean requests                                                                                        |
| Prompt injection involving tools        | no tool execution; inspected definitions, arguments, and results                                                               | the calling application remains responsible for tool authorization                                                                     |
| SSRF or provider substitution           | configured base URLs, HTTPS, loopback exception, redirects disabled                                                            | DNS/CA compromise and configuration tampering                                                                                          |
| Credential theft                        | environment injection, no logs, no request-supplied keys                                                                       | host/process/cluster compromise                                                                                                        |
| Audit log becomes data lake             | content-minimized bounded receipts                                                                                             | key compromise enables guessed-request verification; metadata remains visible                                                          |
| Receipt tampering                       | durable chain, Ed25519 signatures, sequence, signed checkpoint                                                                 | software-held key can rewrite history not anchored outside the gateway                                                                 |
| Archived receipt segment removal        | signed rotation checkpoint in each active head; externally retained checkpoints                                                | rotated archives are not re-verified automatically at startup                                                                          |
| Dependency compromise                   | zero third-party runtime packages, pinned actions, immutable base digest                                                       | runtime and base-image provenance                                                                                                      |
| Denial of service                       | bounded request/response/events/findings, timeouts, bounded receipt store                                                      | no built-in rate limiter; workload keys identify but do not throttle resource use                                                      |
| Provider retention mismatch             | explicit policy metadata, forced non-storage field                                                                             | metadata is operator assertion, not remotely attested                                                                                  |
| Policy misconfiguration                 | exhaustive, disjoint startup validation for every detected data class                                                          | taxonomy quality and operator intent still require review                                                                              |
| Detector precision trade misapplied     | `policy.sensitivity` selects how a low-precision finding is handled; a high-precision finding in a blocked class always denies | the trade is an operator choice: `strict` blocks legitimate work, `balanced` routes low-precision findings locally rather than denying |
| Semantic model evasion                  | deterministic floor, chunk overlap, versioned prompt, independent evals                                                        | obfuscation and context can still suppress a candidate                                                                                 |
| Hallucinated semantic finding           | strict schema, exact source lookup, low precision, deterministic priority                                                      | a literal but non-sensitive substring can still be transformed or routed local                                                         |
| Semantic endpoint compromise            | loopback-only `local:true` provider, fixed URL/model, no redirects                                                             | compromised local inference can observe detector inputs and degrade availability                                                       |
| Semantic detector degradation           | bounded input/response, timeout, metrics, signed degradation evidence                                                          | `degrade` mode intentionally continues with deterministic findings only                                                                |
| Silent provider feature loss            | explicit capability table, validated narrowing overrides, 422 on semantic gaps, downgrade header                               | an incorrectly declared provider can still reject or misapply a supported field                                                        |
| Native stream delivery                  | bounded per-event assembly, holdback recomposition across chunk boundaries, provider error surfaced as 502                     | a stream receipt attests `egress:started`; completion is never attested, and cancellation follows the provider                         |
| Streaming residue outside mapped deltas | residue audit on delta content and tool arguments                                                                              | refusal and vendor-extension fields are not structurally audited in SSE                                                                |

## If Egrysa itself is compromised

Egrysa is an inline chokepoint that sees prompt content in cleartext before it is transformed, which
makes the gateway a higher-value target than any single client. This section states that exposure
directly rather than leaving it distributed across the remaining-exposure column above.

**What an attacker with code execution in the process obtains.** Prompt and response content for
requests in flight during the compromise window; the surrogate map for those requests; any provider
credential and the receipt signing key present in the process environment; and the ability to alter
or bypass policy decisions for subsequent requests.

**What the design denies them.** There is no historical prompt archive to steal. Receipts carry
counts, kinds, and a keyed fingerprint, never content. The surrogate map exists only for the
lifetime of its request. No prompt or response is written to logs, metrics, or disk. A compromise
therefore yields what flows through the gateway while the attacker is present, not a retrospective
corpus of everything that flowed before. This is a deliberate property and it is the main reason the
receipt schema is content-minimised.

**What bounds the blast radius.** The process runs under an explicit Deno permission set: reads are
limited to the configuration directory and the receipt volume, writes to the receipt volume, the
environment to seven named variables, and the network to the bind address plus configured provider
hosts. No subprocess or FFI permission is granted, so there is no shell to pivot through and no
loading of native code. In the reference container the process runs as UID 65532 with a read-only
root filesystem, all capabilities dropped, `allowPrivilegeEscalation: false`, a seccomp profile, and
a restrictive network policy.

**What is not mitigated.** Memory scraping by anything already inside the process or on the node.
Core dumps and swap, neither of which is disabled or encrypted by this project. A cluster or node
administrator, who is out of scope above. Theft of the receipt signing key, which allows an attacker
to mint receipts that verify; while the key is held in software, receipt integrity is only as strong
as the host. KMS or HSM custody is a roadmap item precisely because of this.

**What is detectable afterwards.** Receipts are hash-chained and sequenced, so rewriting or removing
history is detectable **provided signed checkpoints have been retained outside the gateway**. That
retention is an operator responsibility; without it, an attacker holding the signing key can rewrite
a consistent chain. Forward-dated forgery using a stolen key is not detectable from the chain alone.

**Enabling the reference semantic detector widens this.** When enabled it sends request text to a
configured loopback inference endpoint, creating a second process that observes the same content
under a different trust assumption. It is off by default, and the corresponding threat row above
records the residual exposure.

## Out of scope for v0.1

Compromised customer endpoints; malicious cluster administrators; nation-state traffic correlation;
side channels inside model-provider infrastructure; complete semantic anonymization; training-data
extraction from models; multimodal steganography; autonomous tool execution; durable organizational
memory; regulatory legal opinion.

## Security assumptions

- TLS terminates at a customer-controlled ingress or service mesh; the pod listens on HTTP inside
  the protected network.
- Secrets come from a managed secret store, not a manifest or `.env` file in production.
- The customer validates provider contracts, retention mode, residency, and feature eligibility.
- Local inference is actually inside the approved trust boundary.
- The confidential-term taxonomy and evaluation corpus are owned and reviewed by the customer.
- The semantic detector endpoint, model artifacts, runtime, and network path remain inside the
  customer-controlled trust boundary.
- The JSONL receipt backend is durable but single-writer. Horizontal scaling requires a sequencing
  backend, and truncation detection requires an operator or auditor to retain signed checkpoints
  outside the gateway. Rotated `receipts.jsonl.<sequence>` archives are not loaded at startup;
  externally retained checkpoints are the removal-detection anchor.
- Workload keys are the resource-exhaustion attribution boundary, not a rate limiter. Place the
  gateway behind a rate-limiting ingress for untrusted-adjacent workloads.
- Capability overrides can only narrow adapter defaults. They remain operator assertions rather than
  proof that a particular provider version honors a field correctly. Committed conformance reports
  are point-in-time evidence for the recorded provider, model, and date, not certification.
- `policy.sensitivity` is an operator decision with a measured cost. `balanced` is the default and
  preserves prior behaviour. `strict` raises coverage and produces false positives that block
  legitimate requests. `review` holds the request and requires a person to acknowledge it before the
  request proceeds. The measured effect of each mode is published in
  [detection coverage](DETECTION_COVERAGE.md).
- Streaming is native for every shipped provider, so tokens are delivered incrementally and no
  `stream-emulated` downgrade is emitted. The disclosure mechanism remains for any provider added
  later that cannot stream natively.
- A streaming receipt is signed and chained when the response begins, so it attests `egress:started`
  and can never be amended to `completed`. Completion is not attested for any streaming provider. An
  auditor who needs completion evidence must take it from the client side of the stream.

Semantic detection is best-effort and never the fail-closed floor. A semantic candidate cannot
hard-deny a request by itself. If the detector times out, disconnects, exceeds bounds, or violates
its response schema, all semantic findings for that request are discarded. The default `degrade`
mode continues with deterministic findings and records the degradation; high-assurance operators can
set `onDetectorFailure:"deny"` to stop traffic instead.
