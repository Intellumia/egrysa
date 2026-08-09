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

| Threat                                  | Primary controls                                                                                           | Remaining exposure                                                                                             |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Accidental secret disclosure            | block classes, fail-closed policy, model allowlists                                                        | novel or encoded formats                                                                                       |
| PII disclosure                          | deterministic detection, request-scoped surrogates                                                         | missed entities and semantic inference                                                                         |
| Company re-identification               | configurable confidential terms, local-only routing                                                        | cumulative semantic clues across clean requests                                                                |
| Prompt injection involving tools        | no tool execution; inspected definitions, arguments, and results                                           | the calling application remains responsible for tool authorization                                             |
| SSRF or provider substitution           | configured base URLs, HTTPS, loopback exception, redirects disabled                                        | DNS/CA compromise and configuration tampering                                                                  |
| Credential theft                        | environment injection, no logs, no request-supplied keys                                                   | host/process/cluster compromise                                                                                |
| Audit log becomes data lake             | content-minimized bounded receipts                                                                         | key compromise enables guessed-request verification; metadata remains visible                                  |
| Receipt tampering                       | durable chain, Ed25519 signatures, sequence, signed checkpoint                                             | software-held key can rewrite history not anchored outside the gateway                                         |
| Archived receipt segment removal        | signed rotation checkpoint in each active head; externally retained checkpoints                            | rotated archives are not re-verified automatically at startup                                                  |
| Dependency compromise                   | zero third-party runtime packages, pinned actions, immutable base digest                                   | runtime and base-image provenance                                                                              |
| Denial of service                       | bounded request/response/events/findings, timeouts, bounded receipt store                                  | no built-in rate limiter; workload keys identify but do not throttle resource use                              |
| Provider retention mismatch             | explicit policy metadata, forced non-storage field                                                         | metadata is operator assertion, not remotely attested                                                          |
| Policy misconfiguration                 | exhaustive, disjoint startup validation for every detected data class                                      | taxonomy quality and operator intent still require review                                                      |
| Semantic model evasion                  | deterministic floor, chunk overlap, versioned prompt, independent evals                                    | obfuscation and context can still suppress a candidate                                                         |
| Hallucinated semantic finding           | strict schema, exact source lookup, low precision, deterministic priority                                  | a literal but non-sensitive substring can still be transformed or routed local                                 |
| Semantic endpoint compromise            | loopback-only `local:true` provider, fixed URL/model, no redirects                                         | compromised local inference can observe detector inputs and degrade availability                               |
| Semantic detector degradation           | bounded input/response, timeout, metrics, signed degradation evidence                                      | `degrade` mode intentionally continues with deterministic findings only                                        |
| Silent provider feature loss            | explicit capability table, validated narrowing overrides, 422 on semantic gaps, downgrade header           | an incorrectly declared provider can still reject or misapply a supported field                                |
| Native stream delivery                  | bounded per-event assembly, holdback recomposition across chunk boundaries, provider error surfaced as 502 | a stream receipt attests `egress:started`; completion is never attested, and cancellation follows the provider |
| Streaming residue outside mapped deltas | residue audit on delta content and tool arguments                                                          | refusal and vendor-extension fields are not structurally audited in SSE                                        |

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
