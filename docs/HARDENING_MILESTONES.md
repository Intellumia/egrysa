# Hardening milestones

Hardening is evidence, not a feature count. Each gate below has an explicit artifact and owner. A
later gate cannot compensate for a failed earlier one.

## Gate 0: safe public source

**Purpose:** publish an inspectable alpha without implying production or compliance readiness.

| Required evidence                                                                    | Current state                                                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Strict format, lint, type, unit/integration, and synthetic evaluation pass           | Commit `2fef037f9bc17a18a69eb3dfcd0a3b3bc9297e10`: 76 tests; 48/48 cases |
| Policy configuration rejects missing, duplicate, and unknown data classes            | Implemented and tested                                                   |
| Receipts contain no raw-content digest usable for offline guessing                   | Keyed, nonce-bound fingerprint implemented and tested                    |
| Process-local receipt chain cannot be deployed as false multi-replica evidence       | Deployment fixed at one replica; limitation documented                   |
| Tagged release cannot bypass tests, audit, image scan, SBOM, provenance, and signing | Alpha.3 retained and independently verified all release evidence         |
| Deployment image is immutable                                                        | Digest placeholder fails closed until the release digest is supplied     |
| Private vulnerability reporting has a monitored route                                | Enabled; non-maintainer test advisory received and closed on 2026-07-17  |
| No repository secret, personal local file, or invalid release identity               | Protected PR CI enforces announce-diff and history scans before merge    |
| Product name has counsel-reviewed knockout                                           | Egrysa selected; founder reports legal screening complete                |
| At least one real remote-provider generation and one local-provider path pass        | Local gateway path and authorized remote adapter smoke test passed       |
| Container and Kubernetes examples run under documented restrictions                  | Container and Calico/kind runtime restrictions validated locally         |

**Release label:** `v0.1.0-alpha.3`, evaluation-only. No production, certification, anonymity, or
provider-deletion claim.

The active pre-alpha.4 engineering work is maintained in
[the alpha.4 remediation plan](ALPHA4_REMEDIATION_PLAN.md). It closes bounded-work,
receipt-before-egress, canonical-verification, timeout, observability, and negative-test gaps before
the project advances to roadmap 0.2 work.

## Gate 1: reproducible community alpha

**Purpose:** let a security engineer reproduce the control boundary without speaking to the vendor.

Required evidence:

- a signed image, SBOM, provenance statement, checksum, and verification commands from one immutable
  release;
- a clean-room installation on a fresh machine and a supported Kubernetes distribution;
- an adversarial synthetic corpus maintained separately from implementation fixtures;
- per-class precision and recall, policy accuracy, task-quality delta, p50/p95/p99 overhead, and
  concurrency/failure results;
- redaction tests for logs, metrics, errors, receipts, crash paths, and upstream failures;
- documented compatibility and security-support windows; and
- two independent users able to install, operate, and remove the gateway from the documentation.

**Do not add yet:** SaaS control plane, tenant billing, customer prompt telemetry, appliance, broad
connector catalog, or multi-provider prompt fan-out.

## Gate 2: design-partner pilot

**Purpose:** protect one bounded, non-critical workflow inside a partner-controlled environment.

Required evidence:

- at least 100 independently labelled synthetic or authorized redacted cases per pilot workflow;
- zero known exact high-severity secret escapes in the agreed corpus and explicit per-class
  acceptance thresholds;
- approved data-flow diagram, threat model, data-retention statement, subprocessors statement, and
  shared-responsibility matrix;
- workload identity, signed policy bundles, KMS/HSM-backed signing, durable append-only evidence,
  backups, restore test, and SIEM export;
- multi-replica consistency or an explicit single-node availability acceptance;
- incident, key-rotation, policy-rollback, upgrade, and safe-bypass runbooks;
- independent penetration test with no unresolved critical or high findings; and
- pilot SLOs based on measured latency and failure behavior rather than marketing targets.

The pilot may use bounded function tools and OpenAI-compatible SSE streaming. Egrysa never executes
tools; files, images, audio, and unsupported provider streaming continue to fail closed.

## Gate 3: paid enterprise release

**Purpose:** sell deployment assurance and governance without moving the prompt trust boundary out
of the customer's infrastructure.

Required evidence:

- OIDC/workload identity, role separation, tenant isolation, approvals, policy versioning, and audit
  administration;
- high-availability receipt/evidence storage, disaster recovery, upgrade compatibility, and
  supported rollback;
- customer-managed keys, an HSM/KMS path, and a separately validated cryptographic build when a FIPS
  requirement applies;
- signed release channels, vulnerability SLAs, long-term support policy, and reproducible build
  evidence;
- independent security assessment and a vendor control program mapped to the target customer
  requirements;
- documented GDPR, EU AI Act, sector, residency, and records-management responsibilities without
  claiming the software alone creates compliance; and
- a support organization capable of incident response without collecting prompt content.

SOC 2, ISO 27001, or other certification applies to an operating organization and its scoped system,
not merely to source code. Certification work begins only after the scoped enterprise service and
operating model exist.

## Gate 4: appliance

**Purpose:** deliver a measured hardware-rooted boundary for customers that cannot approve a
software-only deployment.

Required evidence includes secure/measured boot, device identity, remote attestation, encrypted
state, tamper and recovery procedures, supply-chain chain of custody, signed offline updates,
hardware lifecycle support, and an independent hardware threat assessment.

## Runtime decision gate

Deno is suitable for the alpha because the current service has no third-party runtime packages, uses
a capability sandbox, and allows fast iteration. It is not yet proven against every buyer's runtime,
FIPS, support-lifecycle, or platform-approval requirements.

Do not rewrite pre-emptively. Freeze the OpenAI-compatible API, policy schema, receipt schema, and
evaluation corpus. At the design-partner gate, record objections from at least three target buyers.
Port the production data plane to Rust or Go only if runtime approval, validated cryptography,
performance, or long-term support is a repeated blocker. The open schemas and tests become the
conformance suite for any second implementation.
