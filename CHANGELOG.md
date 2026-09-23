# Changelog

All notable changes will be recorded here. The project follows Semantic Versioning after the first
public tag.

## Unreleased

### Added

- Task-quality measurement, acceptance gate 3, which nobody had measured. `deno task eval:quality`
  runs every case in `evals/task_quality.jsonl` twice, once straight to the provider and once
  through an in-process gateway, and scores both against the same deterministic assertions. The
  first measurement is published in [the evaluation record](docs/EVALUATION.md): with the default
  sentinel surrogates a small local model damages the token often enough to cost 43% of the baseline
  pass rate through fail-closed refusals, and with synthetic surrogates that falls to 10%, all of it
  one ordering case that no engineering inside the boundary can fix.
- `docs/PENTEST_SCOPE.md`: the statement of work for an independent penetration test, naming the
  four claims a tester should try to falsify, the abuse cases worth paying for, what is out of
  scope, the environment, the rules of engagement, the deliverables including a publishable
  attestation, and the acceptance condition for CISO brief gate 8.
- `deno task smoke:cloud`: opt-in live checks for Azure OpenAI, Bedrock, and Vertex AI through the
  whole gateway (transform out, recompose back, receipt verifies with completed egress, streaming
  ends with `[DONE]`), each skipped unless its credentials and endpoint details are in `.env.local`.
- Evaluation kit. `eval-kit/quickstart.sh` installs a private copy of the pinned Deno if none is
  present, generates local-only keys, starts the stub provider and the gateway, runs the Phase 1
  probes (`eval-kit/smoke.sh`: discovery, authentication, transform with a provider-side check,
  receipt, deny, streaming, public key, checkpoint, content-free metrics), and verifies the receipt
  chain offline. `eval-kit/evidence.sh` runs every published check and writes logs, counts, digests
  and timings to a folder to send back, with no request content.
- Compatibility policy. `docs/COMPATIBILITY.md` freezes the HTTP API, receipt schema (versions 2 to
  5 verify forever), configuration schema (`api/config.schema.json`, `schemaVersion` 1), evidence
  export records, and the detector and signer contracts, and states the support window and how
  breaking changes are announced. `tests/compatibility_test.ts` holds the code to it: shipped
  configurations conform to the schema, enumerations match the code, unknown fields are rejected at
  every closed level, every documented path is served, and a receipt chain written by alpha.5
  (`tests/fixtures/receipts-alpha5/`) loads, verifies, and continues.
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
- Remote receipt signing. `receiptSigner: { kind: "remote", url, headersEnv, timeoutMs }` sends each
  receipt hash and checkpoint to a signing service and holds only the public key; every returned
  signature is verified before use, a startup probe refuses a service with the wrong key, and a
  signing failure fails the request closed with `503 receipt_unavailable` without faulting the
  store. `deno task signer` runs the reference service (`tools/reference_signer.ts`).
- Per-replica receipt chains. `EGRYSA_RECEIPT_CHAIN_SUFFIX` (the pod name in
  `deploy/kubernetes/statefulset.yaml`) suffixes the chain id and the log file name so several
  replicas share one configuration and each owns a chain anchored through evidence export.
- OpenID Connect bearer tokens. With `oidc` configured, a bearer that matches no static key and has
  the shape of a JWT is verified against the issuer's JWKS (discovered or given), checked for
  issuer, audience, and time, and mapped through a claim to the workload id and optionally the
  auditor role. RS256 and ES256, WebCrypto only.
- Evidence export. `export` ships every committed receipt, a signed checkpoint every N receipts and
  at shutdown, and the content-free events (detector degraded, stream response findings, rate
  limited) to an HTTPS sink as JSON lines or OTLP/HTTP log records, with sink headers from an
  environment variable, batching, backoff, a bounded queue that drops oldest with a counted metric,
  and a flush deadline at shutdown. Exported receipts verify with the gateway's public key.
- Azure OpenAI, AWS Bedrock, and Google Vertex AI provider kinds. Azure addresses a deployment with
  the `api-key` header and the OpenAI body. Bedrock and Vertex serve Anthropic models: Bedrock with
  a bearer API key or IAM credentials signed with Signature Version 4, and its binary event stream
  decoded into the same events the Anthropic adapter already translates; Vertex with an OAuth access
  token or a service-account key exchanged for tokens through a WebCrypto-signed JWT. No third-party
  code; credentials come only from the environment variables the configuration names.
- Anthropic Messages API ingress. `POST /v1/messages` accepts the Messages request shape (system
  prompt, text, `tool_use` and `tool_result` blocks, tools, `tool_choice`, streaming), translates it
  to the internal chat request, runs the unchanged policy, transformation, receipt, and provider
  pipeline, and answers as an Anthropic message, as the `message_start` to `message_stop` event
  sequence, or as the Anthropic error object carrying the receipt id. `top_k`, `stop_sequences`,
  `metadata`, and non-text blocks are refused rather than dropped.
- Surrogate style and scope. `policy.surrogates.style` chooses sentinel tokens (default) or
  format-preserving synthetic values from reserved ranges, which models handle as ordinary text
  while local recomposition restores the originals; `policy.surrogates.scope` chooses fresh
  surrogates per request (default) or the same surrogate for the same value across a workload's
  requests, derived from a keyed hash and never stored, which keeps multi-turn conversations
  coherent and lets provider prompt caching hit at the cost of cross-request linkability. Response
  scanning excludes surrogate values of either style, and the streaming recomposer scans every chunk
  when surrogates carry no sentinel.
- Opt-in prompt-injection detection. Adding `prompt_injection` to `nerDetector.kinds` makes the
  reference sidecar score each request with a pinned classifier and report the highest-scoring
  window as a low-precision finding. The kind is a new blocked class, so **configurations from an
  earlier release must add `prompt_injection` to `blockKinds`**, and `policy.sensitivity` decides
  whether a flagged request is routed locally (`balanced`), refused (`strict`), or held (`review`).
  Response scanning ignores the kind. `deno task eval:injection` measures it: 8/8 attacks, 2/10
  benign flagged, 0/67 scenario documents flagged.
- Per-workload rate limiting: `policy.rateLimit` (globally or per workload) is a token bucket per
  workload key answering 429 with `Retry-After` before inspection, counted in
  `egrysa_rate_limited_total`. Per replica by design; the operations guide says to keep an ingress
  limiter in front of untrusted callers.
- An auditor role: `EGRYSA_AUDITOR_KEYS` holds read-only keys that can read every workload's
  receipts, the checkpoint, the public key, and the metrics, and are refused on every other route.
- Per-workload policy. An optional `workloads` map keyed by inbound workload id overrides the
  data-class actions, sensitive terms, sensitivity, response policy, and default provider for that
  workload, and can narrow the providers and models it may use. Overrides inherit everything they do
  not name, the merged policy is validated at startup under the global rules, model discovery is
  filtered per workload, and a request outside a workload's provider or model allowance is refused
  before inspection.
- Twelve further data classes in the deterministic floor: `ipv6` (full, compressed, IPv4-mapped, and
  bracketed URL forms), `mac_address`, `date_of_birth` (labelled), `aadhaar` (Verhoeff),
  `india_pan`, `uk_nino`, `nhs_number` (labelled, modulus 11), `passport` (labelled), `bank_account`
  (checksum-validated routing numbers; labelled account numbers at low precision), `crypto_wallet`
  (Ethereum and bech32 at high precision, legacy base58 at low precision), `vin` (check digit), and
  `organization` through the NER sidecar. Every kind must have a policy action, so **a configuration
  written for an earlier release must add the new kinds** to `blockKinds` or `transformKinds` before
  the gateway starts; the shipped examples place the six identity and financial classes under
  `blockKinds` and the rest under `transformKinds`. The regression suite grows to 61 cases and the
  adversarial corpus to 119, with 25 negative controls and no false positives. Closes the IPv6
  exclusion (#19).
- Provider responses are scanned with the same detectors before recomposition, so anything found is
  provider-originated and the customer's own restored values are never counted. `policy.response`
  chooses the action per class: a blocked class is redacted to `[REDACTED:<KIND>]` by default or the
  response is refused with `response_denied`; transformable classes pass by default or are redacted.
  Provider-attempt receipts are version 5 and carry content-free response evidence (`findingCounts`,
  `action`). A stream's receipt is signed when it begins, so streams are observed after completion
  through `egrysa_response_findings_total` and a content-free log event, and their receipts say
  `unscanned`.
- A reference customer-local NER detector for person names and physical addresses. A purpose-built
  entity model runs as a loopback sidecar inside the customer boundary (`tools/ner_sidecar/`,
  Python, pinned model revision), and a zero-dependency adapter in `src/ner.ts` speaks a small
  versioned contract to it with the same safeguards as the semantic detector: loopback-only
  configuration, bounded input and response sizes, per-chunk and per-surface deadlines,
  literal-candidate validation, capped findings, low precision, and content-free evidence. Off by
  default via `nerDetector`. Each optional detector now carries its own `onDetectorFailure`, and a
  failed detector drops only its own findings. Measured live through `deno task eval:ner`: 100%
  precision and recall on both kinds at 50 ms p95; the scenario corpus reaches 66/67 with it
  enabled.
- Corpus credential fixtures are seeded placeholders, `{{rand:<alphabet>:<length>}}`, expanded by
  the loader from the case id, so the committed corpora hold no token-shaped strings while every
  evaluation runs on random-looking values a scanner would flag. Reports print the corpus SHA-256,
  and `tools/adversarial_report.ts --dump=<path>` writes the expanded cases for cross-checking with
  an external scanner. Against gitleaks on the same expanded fixtures: Egrysa 30/30 credential and
  key cases, gitleaks 23/30, neither firing on a negative control.
- Encoded and obfuscated forms of known values are detected. The pattern detector now also scans
  normalised views of each text surface: percent-encoding, JSON escapes, HTML entities, markup
  inside a value, backslash line continuations, full-width and dash look-alikes, zero-width
  characters, `[at]`/`(dot)`/spaced email separators, and base64 runs that decode to text. Findings
  are reported against the original bytes, so surrogates replace the encoded form and recomposition
  restores it. The email pattern accepts internationalised domains. On the adversarial corpus this
  lifts fully detected cases from 77 to 91 of 102 with zero false positives; the pattern detector
  reports version `1.3.0`.
- An end-to-end gateway overhead benchmark, `deno task bench:e2e`, that starts an in-process echo
  provider and gateway with a real fsynced receipt log and reports p50/p95/p99 latency, throughput,
  and decision counts for plain, transformed, and streamed requests at configurable concurrency.

### Changed

- Unknown configuration fields are rejected at every level (top level, `listen`, `policy`, providers
  and their `dataPolicy` and `credentialsEnv`, `sensitiveTerms` entries, `semanticDetector`,
  `nerDetector`), where previously only some nested blocks were closed. A configuration carrying a
  misspelt or retired field now fails at startup instead of being silently ignored. Optional
  `schemaVersion: 1` is accepted.
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
- Receipt appends now use group commit: hashing, signing, and the write stay serialized so the chain
  is ordered, but one fsync covers every receipt written while the previous fsync was in flight. A
  request still completes only after an fsync that includes its own receipt, so the durability
  guarantee is unchanged while throughput is no longer bounded by one fsync per request. A failed
  fsync now faults the store, which rejects further receipts and checkpoints until restart, rather
  than letting later receipts chain onto receipts that may never have reached the disk.
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

- The group-commit test counted real fsyncs, so on a host where fsync returns in microseconds each
  receipt legitimately took its own commit and the test failed. It now holds each commit open while
  it counts, which makes the property it asserts, that concurrent callers share a commit, the thing
  being measured rather than the speed of the runner's disk.
- The Kubernetes ConfigMap left `person_name`, `physical_address`, and `semantic_confidential`
  without a policy action after the taxonomy expansion, so the shipped manifest failed validation at
  startup. The compatibility test now runs every shipped configuration, including the ConfigMap,
  through the validator.
- Streamed responses no longer count the gateway's own receipt signing and fsync against the
  upstream deadline. The connect deadline is cleared when the stream's headers arrive and a fresh
  deadline is armed when the gateway starts reading, after the receipt is durable, so a slow disk on
  a loaded host cannot abort a healthy stream before its first byte (the intermittent CI failure in
  the acceptance suite's streaming stage, issue #27, reproduced by simulating a slow fsync). A
  stream that runs past the deadline once armed is still aborted, and an upstream stream whose
  receipt cannot be written is now released rather than left open.
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
