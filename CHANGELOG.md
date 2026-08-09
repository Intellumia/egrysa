# Changelog

All notable changes will be recorded here. The project follows Semantic Versioning after the first
public tag.

## Unreleased

### Added

- Provider conformance harness with deterministic wire checks, informational surrogate-fidelity
  evidence, dated JSON reports, and a generated README support matrix.
- OpenAI-compatible text gateway with deterministic policy decisions.
- Authenticated model discovery, OpenAI-compatible SSE streaming, and bounded function tools.
- OpenAI, Anthropic, and local OpenAI-compatible adapters.
- Request-scoped surrogates, streaming/local recomposition, and durable Ed25519 policy receipts.
- Versioned timeout-bounded detector interface and explicit workload attribution.
- Off-by-default reference local semantic detector for person names, physical addresses, and
  semantically confidential organizational content, with bounded chunking and literal-source
  candidate validation.
- Version-3 semantic detector receipts, content-free detector metrics, deterministic degradation,
  high-assurance deny mode, and offline/live semantic evaluation tasks.
- Black-box acceptance coverage for streaming, tools, timeout, cancellation, residue failure, public
  verification, and restart continuity.
- Synthetic evaluation suite with per-class precision/recall, hardened deployment examples, and
  release provenance workflow.

- Measured detection coverage against an adversarial corpus and a realistic-traffic corpus, both
  reproducible with `deno task eval:adversarial` and `deno task eval:scenarios`, with per-class
  precision and recall published in `docs/DETECTION_COVERAGE.md`.
- `policy.sensitivity` selects how a low-precision finding in a blocked class is handled: `strict`
  denies, `balanced` routes to local inference, and `review` holds the request and answers 409 with
  a receipt identifier, proceeding only on a single-use acknowledgement. Omitting the field behaves
  as `balanced`.
- A strict-only pattern tier, carrying space- and period-separated SSN detection that is inert under
  any other sensitivity.
- A no-model evaluation path: `deno task stub` and `deno task dev:stub` exercise classification,
  policy, surrogates, recomposition, streaming, and receipts without a model or provider key.
- `tools/verify-release.sh` runs the documented release verification in order, against a published
  release or an unpublished workflow artifact, and exits non-zero on any failure.
- A pre-filled security questionnaire, a threat-model section covering compromise of the gateway
  itself, and a scored status for every acceptance gate.
- A streaming recomposition benchmark, `deno task bench`.

### Changed

- Tagged release jobs now self-verify the immutable image signature, keyless CycloneDX signature,
  and GitHub provenance, then retain signed checksums, verification results, and the underlying
  evidence bundles for publication with the release.
- All attacker-influenceable buffered reads now use explicit limits: incremental request/provider
  body bounds, capped SSE event assembly, and bounded semantic occurrence expansion.
- Overlap resolution now applies the original global winner priority with logarithmic
  predecessor/successor selection, preserving a maximal non-overlapping finding set.
- Receipt reads are workload-isolated; model IDs are bounded; non-streaming responses receive a
  serialized residue backstop; and transformation rejects overlapping findings defensively.
- Publication evidence and API/support documentation now match the announce tree, planned tag,
  enabled repository features, detector identifiers, key-generation output, and documented residual
  rate-limit, IPv6, streaming-residue, and rotated-archive risks.
- Receipt startup now refuses to create a duplicate sequence space when rotated history exists but
  the active head log is missing or empty after an interrupted rotation.
- Provider adapters now enforce explicit capability profiles, allow validated narrowing overrides,
  disclose dropped tuning fields in `x-egrysa-downgraded`, and reject semantic mismatches with 422.
- Anthropic streaming is native: the provider event stream is rewritten into OpenAI chunk frames as
  it arrives, including tool-call deltas and optional usage. No shipped provider is emulated, so the
  `stream-emulated` disclosure is no longer emitted and the buffered emulation path is removed.
- Publication-facing architecture, operations, conformance, and quickstart documentation now links
  neutrality and receipt claims to their implementation and runnable evidence.
- Provider-attempt receipts now use a strict version-4 shape with `completed`, `failed`, or
  streaming `started` egress outcome. Every streaming provider attests `started`, because a receipt
  is signed when the response begins and cannot later be amended; deny receipts and existing
  version-2/version-3 verification remain unchanged.
- Receipt logs now fsync each append, rotate at the configured size into sequence-suffixed archives,
  and resume active-chain continuity from a verified signed checkpoint.
- Semantic detection now applies a 10-second default per-chunk timeout and a separately validated
  30-second total surface budget so sequential chunks do not share one per-call deadline.
- Surrogate residue checks now fail closed on token-shaped `EGRYSA_...` fragments whose full leading
  underscore prefix was removed, without rejecting ordinary product-name prose.
- Selected Egrysa as the product, package, API namespace, configuration, deployment, and release
  name before the first public tag.
- Added a container-specific configuration so the image listens on its container interface while
  host publication remains an explicit operator choice.
- Replaced placeholder remote model names in the shipped examples with provider-documented model
  identifiers; operators must still review availability and policy for their own accounts.
- Expanded the implementation-authored evaluation corpus from 12 to 48 positive, mixed, and
  false-positive cases.
- Added 18 labelled semantic cases and recorded the first local `gpt-oss:20b` reference results.

- Credential detection is anchored on vendor-issued prefixes covering GitHub classic and
  fine-grained tokens, GitLab, Google, Slack, Stripe, npm, SendGrid, Azure storage connection
  strings, and JSON Web Tokens, alongside a low-precision pattern that reaches credentials named by
  their assignment. Private key envelopes accept encrypted, DSA, and PGP blocks, and IBANs are
  recognised in conventional printed grouping.
- Streaming recomposition skips per-token work on a chunk that cannot contain a surrogate, so
  latency no longer grows with the number of sensitive values a request carries.
- The pattern detector reports a distinct version when the strict ruleset is active, so a receipt
  records which rules produced its findings.
- Deno is pinned to 2.9.4 across the container, both workflows, and the documentation.

### Fixed

- A password carried in a URL authority matched the email pattern, so a credential was surrogated
  but recorded as `email` and routed to `transform` rather than `deny`. A dedicated pattern now
  claims the whole authority.
- The recomposition residue audit matched the bare product name, so a request naming a path such as
  `/opt/egrysa-gateway` alongside any transformable value failed closed with 502. The audit now keys
  on surrogate structure.
- Acceptance test stability: the upstream deadline was 50 ms, which every request had to meet while
  also paying Ed25519 signing and an fsynced receipt write.

### Security

- Repository control status is now verified against the GitHub API rather than restated. Secret
  scanning alerts are **disabled**; push protection is active. The previous record claimed secret
  scanning was enabled.
- Secret scanning in the CI security baseline is scoped around the detector corpora by name, because
  a credential fixture a scanner ignores would not test anything.
- Every detected data class must have exactly one startup policy action.
- Semantic detector configuration must resolve to an approved loopback provider marked local;
  semantic candidates are low precision and cannot create a finding-based hard deny.
- Optional provider parameters require strict runtime types and bounds before egress.
- Validation errors do not reflect uninspected request-field names or values.
- Request fingerprints are HMAC-protected and nonce-bound; receipt authenticity is independently
  verifiable with an Ed25519 public key.
- The durable JSONL receipt chain validates continuity across restart and rejects tampering; the
  deployment remains single-replica until multi-writer sequencing exists.
- Release images block all known high or critical findings and require tests, evaluation, signing,
  SBOM, and provenance.
- Kubernetes documentation now requires CNI-specific validation of private ClusterIP egress because
  Service translation and standard `ipBlock` enforcement ordering vary.
