# Architecture and control points

## End-to-end AI data path

```mermaid
flowchart TB
    subgraph Customer["Customer-controlled boundary"]
      U["User / application"] --> SDK["Client or agent SDK"]
      SDK --> G["Egrysa ingress"]
      G --> V["Validate: auth, size, modality, model"]
      V --> D["Deterministic detectors"]
      D --> SD["Optional local semantic detector"]
      SD --> C["Merge findings: deterministic priority"]
      C --> P{"Policy decision"}
      P -->|"deny"| B["Local block"]
      P -->|"local_only"| LM["Customer-hosted model"]
      P -->|"transform"| SV["Ephemeral surrogate map"]
      SV --> E["Approved egress"]
      LM --> RC["Local recomposition"]
      SV --> RC
      RC --> U
      B --> PR["Signed content-minimized policy receipt"]
      E --> PR
      LM --> PR
    end

    E --> DNS["Customer DNS / network / TLS"]
    DNS --> EDGE["Provider edge"]
    subgraph Provider["Provider-controlled boundary"]
      EDGE --> SAFE["Safety and abuse controls"]
      SAFE --> INF["Inference infrastructure"]
      INF --> RET["Provider logs, telemetry, and permitted retention"]
    end
    INF --> E
```

## Capability-aware provider adaptation

```mermaid
flowchart LR
    R["Validated ChatRequest"] --> C["Resolve adapter capabilities + provider override"]
    C -->|"unsupported semantic feature"| X["422 named capability"]
    C -->|"unsupported droppable tuning"| F["Remove field from cloned request"]
    C -->|"supported"| A["Provider adapter"]
    F --> A
    A -->|"native JSON / SSE"| O["OpenAI-compatible response surface"]
    A -->|"Anthropic event stream"| T["Rewrite to OpenAI chunks in flight"]
    T --> O
    F --> H["x-egrysa-downgraded"]
```

The default profiles live in `src/provider_capabilities.ts`; configuration can only narrow them.
Droppable tuning fields are removed before adapter serialization and named in a response header.
Tools, tool choice, streaming, stream options, temperature, and output bounds fail with 422 when the
selected profile cannot preserve their semantics. Anthropic streaming is native: the provider event
stream is rewritten into OpenAI chunk frames as it arrives, so tokens reach the caller
incrementally. No shipped provider is emulated, so the `stream-emulated` disclosure is no longer
emitted.

## Control matrix

| Point            | Customer control                           | Egrysa control                                                         | Not controlled here                                             |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| User input       | Endpoint, identity, acceptable-use policy  | API authentication and supported shape                                 | Copy/paste before the gateway                                   |
| Pre-egress       | Network placement and taxonomy             | deterministic classify; optional local semantic candidates; policy     | Unknown entities and semantic model misses                      |
| Egress           | DNS, firewall, proxy, private connectivity | fixed provider URL, HTTPS, no redirect, model allowlist                | Public internet routing and provider edge                       |
| Provider request | Contract, project, region, entitlements    | capability gate; disclosed tuning drops; `store:false` where supported | Provider safety review, legal holds, metadata, internal systems |
| Inference        | provider/model choice                      | approved provider and model only                                       | weights, caches, internal routing, model behavior               |
| Response         | application UX                             | buffered or SSE holdback recomposition and minimized receipt           | Provider-generated sensitive text not tied to a surrogate       |
| Evidence         | storage, external checkpoint retention     | durable single-writer JSONL chain and Ed25519 signatures               | A signer with the private key can rewrite unanchored history    |
| Memory           | customer architecture                      | none in the gateway                                                    | Any external application or provider conversation state         |

## Data invariants

- Surrogate maps are request-scoped `Map` objects and are not passed to logging, receipt, or
  persistence code.
- Receipts contain workload attribution, a keyed nonce-bound request fingerprint, finding counts,
  decision, provider/model identifiers, and chain/signature values only. They contain no raw prompt
  or response content.
- Denials retain version-2/version-3 policy receipts. Provider attempts use version-4 receipts:
  non-streaming success records `egress:completed`, invocation failure records `egress:failed`, and
  streaming records `egress:started` after upstream response headers arrive. A receipt is signed and
  chained when the response begins, so a stream cannot later be amended to `completed`; stream
  completion attestation is not claimed. This applies to every provider now that Anthropic streams
  natively, where previously buffered emulation could record `egress:completed` because upstream
  inference had already finished.
- When semantic detection is enabled, receipts add only detector IDs/versions and a degradation
  boolean. No receipt records finding text or request/response content.
- Provider credentials are read from named environment variables and never accepted in request
  bodies.
- Remote providers require HTTPS; plaintext HTTP is limited to loopback providers explicitly marked
  local.
- OpenAI-compatible upstream payloads use an allowlist of fields and force `store:false`.
- SSE content and tool-call argument fragments use bounded local recomposition on every provider.
  Native chunking makes a surrogate split across a chunk boundary the common case rather than the
  exception, which is what the holdback exists to rejoin. Multimodal content still fails closed.
- Recomposition treats a surviving surrogate skeleton, meaning the sentinel followed by a finding
  kind and a sequence number, or a sentinel followed by a token body and the closing delimiter, as
  suspected damage. A mutation has to destroy both shapes to escape. Ordinary prose naming the
  product, including `/opt/egrysa-gateway`, matches neither and is not residue.
- Function definitions, message content, tool-call arguments, tool results, and JSON-schema string
  values are inspected. Sensitive structural schema keys cannot be transformed and are denied.
- Semantic detector inputs use only a configured loopback provider marked `local:true`; redirects
  are disabled, responses are bounded, model offsets are ignored, and candidates must occur
  literally in the inspected source. Deterministic findings win every overlap.
- Semantic findings are low precision. High-precision deterministic findings remain the only
  finding-based path to a hard deny; low-precision candidates transform or route locally.
- Receipt startup refuses a missing or empty active head when sequence-suffixed rotated logs exist,
  preventing an interrupted rotation from silently creating a duplicate sequence space.

## Known engineering limits

Deno/JavaScript strings are garbage-collected and cannot be deterministically zeroized. A
process-memory or host compromise can recover request content. Production should combine short
request lifetime, swap restrictions, encrypted nodes, process isolation, memory limits, crash-dump
controls, and an external security review. A future hardened data plane may use a memory-safe native
implementation with explicit secret-buffer handling, but that does not remove plaintext from active
process memory.

The reference semantic detector is probabilistic, model-dependent, and best-effort. It can miss
entities, hallucinate literal substrings, be evaded by obfuscation, or add seconds of latency. Its
failure policy is explicit: `degrade` discards semantic findings for the request and continues with
the deterministic floor, while `deny` stops the request for higher-assurance deployments.
