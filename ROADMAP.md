# Roadmap

The roadmap describes intent, not shipped commitments.

Every phase is gated by the evidence in [hardening milestones](docs/HARDENING_MILESTONES.md). The
[open-source strategy](docs/OPEN_SOURCE_STRATEGY.md) keeps the reference data plane useful before a
paid enterprise layer is built.

## 0.1 alpha: public reference data plane

- Complete independent adversarial corpus and live provider validation.
- Publish signed container images, SBOM, provenance, and verification instructions.
- Stabilize configuration schema and policy receipts.
- Add provider contract profiles without claiming remote attestation.
- Complete external security review and public vulnerability-reporting setup.
- Validate OpenAI-compatible streaming and bounded function tools against design-partner SDKs.

## 0.2: measurable semantic exposure

- Session-level exposure budgets and cumulative entity/linkability scoring.
- A bounded local privacy-utility optimizer that selects among masking, pseudonymization,
  abstraction, and controlled ambiguity.
- Locally evaluated transformation quality, inference-risk attacks, and task-utility regression
  tests.
- Pluggable local named-entity and secret detectors with explicit confidence policy. The
  off-by-default OpenAI-compatible local reference detector is shipped; independent calibration and
  additional detector implementations remain open.
- Policy simulation and explainable dry-run mode.

## 0.3: enterprise evidence integration

- Multi-replica receipt sequencing and external transparency/SIEM checkpoint sinks.
- OIDC/workload identity, tenant isolation, KMS/HSM signing, SIEM export, and policy bundles.
- Regional/provider capability registry and independently verifiable deployment profiles.

## Mid-to-long-term functional milestones

These milestones close specific gaps recorded in the README
[deliberate exclusions](README.md#deliberate-exclusions). They describe intended function, not
shipped behavior, and each remains gated by the evidence requirements above. None of them changes
the control boundary: classification, policy, transformation, and recomposition continue to run
inside infrastructure the operator owns.

### Native streaming integrations

- Implement native Anthropic streaming so incremental tokens are forwarded as they arrive, replacing
  the current upstream-buffered emulation.
- Retire the `x-egrysa-downgraded: stream-emulated` disclosure header for providers once native
  streaming is verified, and keep emitting it for any provider still emulated.
- Preserve bounded holdback recomposition under native chunking so a surrogate split across chunk
  boundaries is never emitted un-recomposed.
- Extend the [provider capability table](src/provider_capabilities.ts) and conformance reports to
  distinguish native from emulated streaming per provider and model.

### Automated regional compliance token-routing (GDPR/HIPAA workflows)

- Add a regional provider registry that records processing jurisdiction, residency commitments, and
  contractual retention terms as explicit policy inputs.
- Route requests to a compliant provider or to a customer-hosted model based on the classified
  entity kinds present, so regulated categories never egress to a non-qualifying region.
- Support named workflow profiles (for example GDPR and HIPAA) that bind detector sensitivity,
  permitted decisions, and eligible providers into a single reviewable bundle.
- Record the selected region and the profile that produced the routing decision in the policy
  receipt, without recording prompt content.
- Fail closed when no provider satisfies the active profile, rather than silently downgrading to a
  broader region.

### Enterprise KMS/HSM credential plugins

- Move receipt Ed25519 signing behind a pluggable interface so private key material can stay in a
  KMS or HSM and never enter gateway process memory.
- Provide reference bindings for PKCS#11 and cloud KMS signing services, kept outside the zero
  dependency data plane so the community edition retains no third-party runtime packages.
- Source provider credentials from the same interface, removing long-lived API keys from environment
  variables in enterprise deployments.
- Support key rotation and per-tenant signing keys without breaking receipt hash-chain continuity or
  existing public verification material.

### IPv6 detection support

- Add deterministic classification for full, compressed, zero-run, and IPv4-mapped IPv6 formats to
  the fail-closed detector floor, closing the exclusion recorded at
  [README](README.md#deliberate-exclusions).
- Hold the detector to the existing backtracking and budget constraints so classification latency
  stays bounded on adversarial input.
- Apply request-scoped, consistent surrogate replacement and local recomposition to IPv6 values on
  the same terms as IPv4.
- Extend the adversarial corpus and `tests/` coverage with complex and ambiguous IPv6 strings,
  including values embedded in URLs and bracketed authority forms.

## Research tracks

The evidence, maturity labels, build order, and non-goals are maintained in the
[research roadmap](docs/RESEARCH_ROADMAP.md). Near-term work focuses on locally measurable semantic
exposure. Confidential inference, request mixing, private aggregate telemetry, and text-free
inference remain experimental until their trust, utility, cost, and provider-cooperation assumptions
are validated.
