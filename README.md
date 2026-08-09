# Egrysa

Open-source, customer-owned AI egress control. Egrysa sits between enterprise users and model
providers, removes or blocks high-risk data, routes confidential work locally, and returns a signed,
content-minimized policy receipt without storing prompt content.

**Status:** security-oriented MVP, not a certified product. It is suitable for technical evaluation
in a non-production environment. It does not make an organization compliant, guarantee that every
sensitive value will be detected, or prove that a provider deleted data.

## The boundary

```mermaid
flowchart LR
    U["Employee or application"] -->|"OpenAI-compatible request"| A["Egrysa inside customer boundary"]
    A --> C["Deterministic classification"]
    C --> M["Optional customer-local semantic detector"]
    M --> P{"Policy"}
    P -->|"deny"| D["Block + receipt"]
    P -->|"local only"| L["Customer-hosted model"]
    P -->|"transform"| S["Request-scoped surrogates"]
    S --> R["Approved remote provider"]
    R --> X["Local recomposition"]
    L --> X
    X --> U
    A --> Q["Content-minimized signed policy receipt"]
```

Egrysa controls the request before provider egress, provider selection, request fields, local
recomposition, and local audit evidence. It cannot control a provider's internal safety systems,
legal holds, infrastructure telemetry, weights, or contractual behavior. Provider retention and
training settings are policy inputs that must be validated through contract and configuration.

## Demonstrated in this repository

- OpenAI-compatible `POST /v1/chat/completions` ingress and `GET /v1/models` discovery.
- Native OpenAI-compatible SSE plus disclosed Anthropic SSE emulation, both using bounded holdback
  recomposition ([adapter code](src/providers.ts), [stream tests](tests/providers_test.ts)).
- Function-tool definitions, assistant tool calls, and tool results as inspected text surfaces;
  Egrysa does not execute tools.
- Deterministic detection for emails, phones, IPv4 addresses, IBANs, payment cards, hyphenated US
  SSNs, private keys, common API secrets, and configured confidential terms.
- An off-by-default reference semantic detector calling only a configured local OpenAI-compatible
  endpoint for person names, physical addresses, and semantically confidential content. It is
  best-effort; measured evidence is in [EVALUATION.md](docs/EVALUATION.md).
- Four decisions: `deny`, `local_only`, `transform`, and explicitly approved `allow_raw`.
- Request-scoped, consistent surrogate replacement and local response recomposition.
- OpenAI, Anthropic, and local OpenAI-compatible adapters with an explicit
  [capability table](src/provider_capabilities.ts), validated narrowing overrides, and disclosed
  downgrades.
- Model allowlists, HTTPS enforcement, loopback-only HTTP, upstream deadlines, request-size limits,
  and no redirects.
- `store: false` forced on OpenAI-compatible remote requests.
- Fsynced, rotating JSONL, Ed25519-signed, hash-chained policy receipts with workload attribution, a
  keyed nonce-bound request fingerprint, public verification material, and no raw prompt or response
  ([implementation](src/receipts.ts), [verification tests](tests/receipts_test.ts)).
- No raw prompt or response logging.
- Deno capability sandbox, no subprocess/FFI permission, and zero third-party runtime packages.
- Hardened Kubernetes baseline, immutable CI actions, CodeQL, dependency review, SBOM, and SLSA
  provenance configuration.

## Provider support matrix

The defaults below are generated from the [adapter capability table](src/provider_capabilities.ts).
Per-provider configuration may narrow them. A report link is runnable evidence for one recorded
provider/model/version, not a universal compatibility claim. See
[Provider conformance](docs/CONFORMANCE.md).

<!-- provider-matrix:start -->

| Provider kind     | Non-streaming | Streaming | Tools | Default tuning downgrades                                             | Conformance report |
| ----------------- | ------------- | --------- | ----- | --------------------------------------------------------------------- | ------------------ |
| openai            | yes           | native    | yes   | none                                                                  | **report wanted**  |
| openai-compatible | yes           | native    | yes   | none                                                                  | **report wanted**  |
| anthropic         | yes           | emulated  | yes   | seed, top_p, frequency_penalty, presence_penalty, parallel_tool_calls | **report wanted**  |

<!-- provider-matrix:end -->

## Deliberate exclusions

- Anthropic streaming is buffered upstream and emitted as OpenAI SSE only after the full response is
  available. The `x-egrysa-downgraded: stream-emulated` header makes the lack of incremental tokens
  explicit; native Anthropic streaming is not implemented.
- Function tools are passed through but never executed. Sensitive structural schema keys fail
  closed.
- No files, audio, or images: each creates a separate egress and injection boundary.
- No cross-provider prompt splitting: it increases the number of recipients and can destroy
  semantics. It requires an evidence-backed decomposition protocol before release.
- No durable prompt memory. The surrogate map exists only for the request lifetime.
- No claim that a natural-language “forget” instruction changes provider retention. Contractual
  controls and supported API parameters are used instead.
- No transparent employee identity header is forwarded to providers.
- Contiguous nine-digit values are not classified as SSNs. Deny-class SSN detection requires the
  canonical hyphenated form to avoid blocking ordinary identifiers.
- IPv6 addresses are not detected in this release.
- No remote semantic-detector option. Model findings are low precision, must match the source text
  literally, and never replace deterministic detection as the fail-closed floor.

## Why open source first

The trust boundary must be inspectable. The community edition is the reference data plane: policy,
classification, transformation, routing, and receipts run inside infrastructure the operator owns.
The project will compete first on transparency, deployment speed, a small attack surface, and
reproducible evidence—not on a closed control plane that requires customers to surrender prompts.

Potential paid enterprise work belongs above this boundary: identity and tenant administration,
durable evidence export, HSM/KMS integration, support, certified release processes, and deployment
assurance. It must not depend on observing customer prompt content.

## Evaluate without a model

The fastest way to see the boundary work. This path needs no model, no download, and no provider
key. It exercises classification, policy, surrogate replacement, local recomposition, streaming, and
signed receipts against a stub endpoint that speaks the OpenAI-compatible API and runs no inference.

```sh
deno task keygen > .env.stub   # local-only keys
deno task stub                 # terminal 1: stub provider on 127.0.0.1:11435
deno task dev:stub             # terminal 2: gateway on 127.0.0.1:8787
```

Then, in a third terminal:

```sh
set -a; source .env.stub; set +a
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $EGRYSA_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"stub-echo","messages":[{"role":"user","content":"Email alex@example.com from host 192.0.2.44 about the incident."}]}'
```

The client receives the original values, recomposed locally:

```text
Stub provider received: Email alex@example.com from host 192.0.2.44 about the incident.
```

The stub terminal prints what actually left the gateway:

```text
[user] Email __EGRYSA_EMAIL_0001_cfb612133dc6__ from host __EGRYSA_IPV4_0002_b7f00fa09957__ about the incident.
```

That difference is the control boundary. Response headers carry `x-egrysa-decision: transform` and
an `x-egrysa-receipt` identifier. Add `"stream": true` to exercise the same path over SSE, where
bounded holdback recomposition reassembles surrogates split across chunk boundaries.

The stub is evaluation scaffolding in `tools/`, not part of the data plane. For measured detection
coverage, see [detection coverage](docs/DETECTION_COVERAGE.md).

## Local evaluation

Requirements: Deno 2.9.x (CI pins 2.9.4) and Ollama for the default local path. The repository has
no external code dependencies.

1. Start Ollama:

   ```sh
   ollama serve
   ```

   In another terminal, install the model used by the example config:

   ```sh
   ollama pull gpt-oss:20b
   ```

2. Generate an attributed client key, a 32-byte fingerprint key, and a matching Ed25519 keypair:

   ```sh
   deno task keygen > .env.local
   ```

   To avoid shell redirection, run `deno run --allow-write=.env.local tools/keygen.ts .env.local`.

   The generated local-only file contains:

   ```text
   EGRYSA_CONFIG=config/egrysa.example.json
   EGRYSA_INBOUND_KEYS=example-workload=<client bearer key>
   EGRYSA_CLIENT_KEY=<same client bearer key>
   EGRYSA_RECEIPT_FINGERPRINT_KEY=<request-fingerprint key>
   EGRYSA_RECEIPT_ED25519_PRIVATE_KEY=<base64 PKCS8 private key>
   EGRYSA_RECEIPT_ED25519_PUBLIC_KEY=<base64 SPKI public key>
   OPENAI_API_KEY=
   ANTHROPIC_API_KEY=
   ```

3. Review `config/egrysa.example.json`. The quickstart request below explicitly selects the
   configured local Ollama provider; the semantic detector remains off. Remote provider keys are
   optional for this path and must stay in `.env.local`, never JSON or Git. See
   [Operations](docs/OPERATIONS.md#reference-local-semantic-detector) before enabling semantic
   detection or remote egress.
4. Verify the repository, then start the gateway:

   ```sh
   deno task check
   deno task eval
   deno task acceptance
   deno task dev
   ```

5. In another terminal, load the generated client key and call the gateway:

   ```sh
   set -a
   source .env.local
   set +a
   curl http://127.0.0.1:8787/v1/chat/completions \
     -H "Authorization: Bearer $EGRYSA_CLIENT_KEY" \
     -H "Content-Type: application/json" \
     -H "x-egrysa-provider: local" \
     -d '{"model":"gpt-oss:20b","messages":[{"role":"user","content":"Email alex@example.com with a two-line summary."}]}'
   ```

6. Produce neutrality evidence for the same endpoint:

   ```sh
   deno task conformance -- --provider local
   ```

   The task requests network permission only for the configured Ollama host and writes a
   content-free dated report under `evals/conformance/`.

The response headers contain `x-egrysa-decision` and `x-egrysa-receipt`. The public verification key
and an externally storable signed chain checkpoint are available at `/v1/receipts/public-key` and
`/v1/receipts/checkpoint` with gateway authentication.

## Read first

- [CISO brief](docs/CISO_BRIEF.md)
- [Architecture and control points](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Control mapping](docs/COMPLIANCE.md)
- [Evaluation record](docs/EVALUATION.md)
- [Detection coverage and measured gaps](docs/DETECTION_COVERAGE.md)
- [Provider conformance](docs/CONFORMANCE.md)
- [Release-image SBOM advisory triage](docs/SBOM_TRIAGE.md)
- [Research roadmap](docs/RESEARCH_ROADMAP.md)
- [Preliminary naming screen](docs/NAMING.md)
- [Public-readiness review](docs/PUBLIC_READINESS.md)
- [Hardening milestones](docs/HARDENING_MILESTONES.md)
- [Open-source-first strategy](docs/OPEN_SOURCE_STRATEGY.md)
- [Operations and deployment](docs/OPERATIONS.md)
- [Security policy](SECURITY.md)
- [Roadmap](ROADMAP.md)
- [Governance](GOVERNANCE.md)
- [Support](SUPPORT.md)
- [Release process](docs/RELEASE.md)

Apache-2.0 licensed. Egrysa is the selected product name. The repository records that external legal
screening was reported complete; it does not itself make a trademark-clearance claim.
