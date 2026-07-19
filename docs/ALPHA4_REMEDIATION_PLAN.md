# Alpha.4 remediation plan

Status: approved plan; implementation has not started.

Source review: adversarial review of `v0.1.0-alpha.3`, commit
`5ffc6aa1fdc5c193928899ea438f0db0cae9688b`, received on 2026-07-19. The review reported 36 ranked
findings. Local validation confirmed the principal bounded-work, receipt-ordering, timeout,
canonicalization, and negative-test gaps. It also found duplicated findings and remediation advice
that would violate Egrysa's content-free logging rule.

This plan is the active engineering scope. Do not begin roadmap 0.2B/0.2C work until the alpha.4
release gates below pass.

## Decisions already made

- Do not withdraw alpha.3. It remains an evaluation-only release with no critical finding.
- Preserve append-only evidence. Do not mutate a signed receipt in place.
- Record a durable, signed egress attempt before provider invocation, then append a linked outcome.
- Introduce canonical signing only in receipt version 5. Continue verifying v2-v4 byte-for-byte.
- Never log provider response snippets, arbitrary error messages, stack traces, prompts, responses,
  surrogate values, or credentials.
- Tail-truncation detection remains externally anchored. A sidecar on the same deletable filesystem
  is not an anti-rollback control.
- Keep the OpenAI-compatible wire surface. Reject excess work with content-free 4xx responses.
- Keep zero third-party runtime dependencies.
- Land negative and failure-injection tests with each behavior change, not in a later test-only PR.

## Pull request 1: bound the trust boundary

**Objective:** one authenticated request has a predictable maximum inspection cost.

Implementation:

- Cap inspected text surfaces per request at 512.
- Cap tool-parameter traversal at depth 32 and 4,096 visited nodes.
- Reject limit violations with a content-free 422 before any detector or provider call.
- Replace the surface-wide `Promise.all` in `src/chat.ts` with a concurrency-4 worker pool.
- Apply a request-wide semantic inspection deadline and propagate cancellation.
- Cap the semantic candidate map before substring expansion.
- Budget candidate searches, including non-matching `indexOf` scans, then use the existing
  degrade/deny detector-failure policy when the budget is exceeded.
- Apply `requestTimeoutMs` to inbound body reads and return 408 on timeout.
- Cache the immutable detector list in `Gateway.create()`.
- Add direct authentication and cryptographic primitive tests.

Required tests:

- 513 surfaces return 422 with zero detector/provider calls.
- Tool depth 33 and node 4,097 return 422.
- A stub detector observes at most four concurrent executions.
- A slow streamed request body returns 408 and cancels its reader.
- Excess semantic candidates degrade or deny without blocking the event loop.
- Missing, non-Bearer, and incorrect bearer credentials reject.
- Duplicate workload IDs, duplicate keys, short keys, and malformed environment entries reject.
- Constant-time equality covers equal, unequal, empty, and different-length inputs.
- Base64 covers valid round-trip and malformed input.
- Canary raw content appears nowhere in errors, logs, metrics, or receipts.

Finding coverage: 1, 2, 6, 7, and 17. Findings 1 and 17 are one root issue.

## Pull request 2: receipt v5 durable lifecycle

**Objective:** provider egress cannot begin without durable signed evidence that the attempt was
authorized.

Lifecycle:

1. Build the minimized receipt context.
2. Append and fsync a version-5 `egress_attempt` receipt before calling the provider.
3. Invoke the provider.
4. Append a linked `egress_outcome` receipt:
   - `completed` for a non-streaming or emulated-stream success;
   - `failed` for an invocation failure; or
   - `started` for a native stream after response headers are received.
5. Return the outcome receipt ID when it exists. If outcome persistence fails after the attempt,
   fail the client response safely and return the attempt receipt ID.

Proposed v5 fields:

```text
event: "egress_attempt" | "egress_outcome"
attemptReceiptId: null | string
egress: "pending" | "started" | "completed" | "failed"
```

Encoding and verification:

- Add a dependency-free canonical JSON encoder for the v5 signed field set.
- Domain-separate the v5 receipt hash.
- Derive the v5 exact-key validator and unsigned serialization from one ordered schema descriptor.
- Keep v2-v4 parsing, hashing, fixture bytes, and verification unchanged.
- Make public verification return `false` for malformed base64, malformed signatures, invalid key
  material, wrong keys, stale hashes, and invalid field sets.
- Commit fixed canonicalization/hash/signature vectors for external verifier implementations.
- Add `egrysa_receipt_write_failures_total` and content-free lifecycle failure events.

Required failure-injection tests:

- Attempt fsync failure prevents any provider request.
- Outcome fsync failure leaves a valid, retrievable attempt receipt.
- Provider failure produces linked attempt/failed receipts.
- JSON success produces linked attempt/completed receipts.
- Native streaming produces attempt/started evidence before downstream response headers.
- Altered content, wrong public key, malformed base64, and a swapped well-formed signature reject.
- Load-time signature rejection is tested independently from hash mismatch.
- Existing v2/v3/v4 chains still verify without rewriting fixture bytes.
- Canonical v5 vectors reproduce the committed hashes.

Finding coverage: 4, 12/31, 18, 19, and 23. Findings 12 and 31 are duplicates.

## Pull request 3: transport neutrality and safe observability

**Objective:** long-lived streams behave correctly and failures are diagnosable without recording
content.

Timeout behavior:

- For inbound reads, `requestTimeoutMs` is the body-read deadline.
- For non-streaming providers, it remains the complete invocation deadline.
- For native streams, it is the time-to-first-byte and idle-between-chunks deadline, not an absolute
  stream lifetime.
- Clear the first-byte timer after provider headers and reset the idle timer for each chunk.
- Propagate downstream cancellation to the upstream reader/fetch.
- Do not replace the current timer with `AbortSignal.timeout()` alone; that signal cannot be cleared
  or reset for an active stream.

Provider neutrality:

- Convert Anthropic non-streaming usage through the existing OpenAI usage mapper.
- Make the required Anthropic `max_tokens` default provider-configurable.
- Disclose an injected default as `max_tokens-defaulted`.
- Preserve the explicit `stream-emulated` downgrade.
- Keep client errors content-free and record only safe status/error classes internally.

Observability:

- Add provider-timeout, request-body-timeout, stream-failure, receipt-write-failure, and
  inspection-limit counters.
- Use one allowlisted structured-event helper.
- Allowed context: event name, receipt/attempt ID, workload ID, configured provider/model ID, route,
  HTTP status, error class, and minimized egress outcome.
- Never log upstream bodies or snippets. Provider errors can echo customer content.

Control-plane isolation:

- Add a separately configured operator credential scope.
- Restrict `/metrics` and `/v1/receipts/checkpoint` to operator credentials.
- Keep individual receipt lookup workload-scoped.
- Update key generation, configuration documentation, OpenAPI, operations, and the threat model.

Required tests:

- A stream stays healthy beyond the initial deadline while chunks continue.
- An idle stream fails at the configured deadline.
- Downstream cancellation reaches the provider.
- Anthropic JSON and emulated-stream usage shapes agree.
- An injected token cap is disclosed.
- A provider error containing a canary secret does not expose it through any output surface.
- Workload credentials cannot access global metrics/checkpoint; operator credentials can.

Finding coverage: 5, 8-10, 20-22, and 36. The review's suggestion to log a bounded provider-body
snippet is explicitly rejected.

## Pull request 4: consolidate security-relevant representations

**Objective:** remove drift risks after the corrected behavior is locked by tests.

- Move structural-field routing into the policy engine so `decide()` returns the final action.
- Export one surrogate token grammar and residue-matcher factory.
- Add shared typed visitors for completion and delta text surfaces where state permits.
- Extract the repeated deny-receipt path from `Gateway.chat()`.
- Name and test the request-wide detector-degradation rule; do not accidentally reduce it to
  per-surface behavior.
- Parse SSE through a moving offset with occasional compaction.
- Hoist the receipt encoder and encode each line once.
- Add direct chat-surface, classifier-validator, malformed-SSE, truncated-stream,
  rotation-empty-head, metrics summary, and receipt-signature tests.

Do not include the proposed `Math.clz32` rewrite, an unrelated gateway redesign, adaptive
pseudonyms, exposure budgets, or new provider features. If this PR grows beyond behavior-preserving
consolidation, defer it until after alpha.4.

Finding coverage: 11, 13-16, 24-30, 32, 33, 35, plus the non-duplicated test gaps.

## Findings treated as residual risk or corrected advice

- Finding 3 is already documented: externally retained signed checkpoints are the anti-truncation
  anchor. Same-host state cannot prove rollback resistance against a host-level deleter.
- Finding 18 is overstated: another implementation can imitate the current V8 serialization, but the
  format is not portable enough. Version-5 canonical encoding remains required.
- Finding 22 must not be implemented as written because logging provider-body snippets violates the
  content-free boundary.
- Finding 34 is rejected; the existing small shift loop is clearer and not a meaningful hot path.
- Finding 35 conflates per-surface and request-wide degradation. Preserve the stricter request-wide
  rule and make it explicit.

## Alpha.4 acceptance gates

- `deno task check`, `deno task eval`, `deno audit`, workflow lint, and diff checks pass.
- Resource tests prove the surface/node/depth limits and maximum detector concurrency.
- Failure injection proves that an attempt-write failure prevents provider egress.
- Logs, metrics, errors, receipts, and crash paths pass canary redaction tests.
- Version-2 through version-4 fixture bytes and verification results remain unchanged.
- A standalone verifier reproduces the committed v5 canonical vectors.
- Clean-room local Ollama installation and the black-box acceptance suite pass.
- At least one provider conformance report is produced from the release candidate.
- GitHub immutable releases and a protected `v*` tag ruleset are enabled before tagging.
- The release is assembled as a draft with SBOM, provenance, signatures, and checksums attached.
- Public assets are downloaded fresh and independently verified before announcement.

## Start here in the next session

1. Confirm the worktree is based on protected `main` and has no unrelated changes.
2. Re-run `deno task check`, `deno task eval`, and `deno audit` for the baseline.
3. Create the PR-1 branch only; do not combine receipt-v5 work with the resource-bound patch.
4. Write the failing surface-cap, schema-depth/node, concurrency, slow-body, and auth/crypto tests.
5. Implement the bounds and worker pool until those tests and the full suite pass.
6. Update architecture, operations, threat-model, evaluation, OpenAPI, and changelog evidence that
   changed in PR 1.
7. Submit PR 1 for independent review before starting PR 2.
