# Pre-filled security questionnaire

Answers to the questions an enterprise security review usually sends, filled in advance so the first
exchange is a review rather than a four-week round trip.

Every answer names its evidence. Where the answer is unfavourable it is stated as such: an
unanswered question found later costs more than an uncomfortable answer given now.

**Verified 2026-08-09** against this repository and the GitHub API. Statuses drift; re-verify before
relying on them.

## Read this first: there is no vendor-operated service

Most vendor questionnaires assume a hosted product with a provider who processes customer data.
Egrysa is not that, and roughly half the standard control set does not apply as written.

- Egrysa is an Apache-2.0 data plane that **runs inside the customer's own infrastructure**.
- The project operates **no service, no tenant, no endpoint, and no telemetry** that customer data
  reaches. There is no vendor-side environment to assess.
- The maintainers have **no access** to customer prompts, receipts, keys, configuration, or logs.
- There are **no subprocessors** introduced by the project. The model providers a customer
  configures are that customer's vendors under that customer's contracts.

Consequences: questions about vendor personnel, vendor data centres, vendor breach notification, and
vendor subprocessor lists have no counterpart here. Questions about the software supply chain, the
runtime's confinement, and the evidence it produces are the ones that matter, and they are answered
below.

## Data handling

| Question                                      | Answer                                                                | Evidence and limits                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does the vendor store customer content?       | No                                                                    | No prompt or response content is written to disk, logs, metrics, or receipts. Receipts hold kinds, counts, and a keyed fingerprint                     |
| Is content retained anywhere after a request? | No                                                                    | The surrogate map exists only for the request lifetime; there is no prompt store to query or subpoena                                                  |
| What is retained?                             | Policy receipts                                                       | Content-minimised, signed, hash-chained, size- and count-bounded, rotated. See [architecture](ARCHITECTURE.md)                                         |
| Is content encrypted at rest?                 | Not applicable to content; **not** applied to receipts by the project | No content is at rest. Receipts are written to a customer-provided volume; encryption of that volume is the customer's storage layer                   |
| Is data encrypted in transit?                 | Yes to remote providers                                               | HTTPS enforced, redirects disabled, plaintext limited to loopback providers explicitly marked local. TLS to the gateway terminates at customer ingress |
| Does data cross a region boundary?            | Determined entirely by the customer's provider configuration          | The project performs no routing of its own. Regional compliance routing is a roadmap item and does **not** exist today                                 |
| Can the customer delete their data?           | There is nothing held to delete                                       | Receipts are on customer storage under customer control                                                                                                |

## Identity and access

| Question                               | Answer                                                   | Evidence and limits                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| How are callers authenticated?         | Bearer workload keys, attributed per workload            | Long, operator-issued keys held in environment variables                                                                             |
| Is there SSO, OIDC, or MFA?            | **No**                                                   | OIDC and workload identity are roadmap items. Enterprise IAM belongs in front of the gateway today                                   |
| Is there role-based access control?    | **No**                                                   | There is one caller role. Policy differentiates by data class, not by user                                                           |
| Is access to the gateway rate limited? | **No**                                                   | Workload keys attribute resource use but do not throttle it. Place a rate-limiting ingress in front for untrusted-adjacent workloads |
| Who can change enforcement policy?     | Anyone who can change the configuration file and restart | The policy file is not signed. Configuration change control is the customer's                                                        |

## Cryptography and key management

| Question                              | Answer                                                           | Evidence and limits                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What signs the audit evidence?        | Ed25519 over a hash-chained receipt                              | Public verification material is exposed at `/v1/receipts/public-key`                                                                                         |
| Where do keys live?                   | **Environment variables**, software-held                         | This is the weakest link in the evidence chain. Anyone who can read the process environment can mint receipts that verify. KMS/HSM custody is a roadmap item |
| Is there key rotation?                | Yes, documented                                                  | See key rotation in [operations](OPERATIONS.md). Rotation preserves chain continuity                                                                         |
| Can historical evidence be rewritten? | Only detectably, and only if checkpoints are retained externally | Signed checkpoints must be retained outside the gateway by the operator. Without that, a holder of the signing key can rewrite a consistent chain            |

## Application security

| Question                                                       | Answer                                                                                 | Evidence and limits                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Third-party runtime dependencies                               | **Zero**                                                                               | Every import is a relative path. No lockfile, no `node_modules`, no registry at runtime                                                                        |
| Runtime confinement                                            | Explicit capability sandbox                                                            | Deno permissions scope reads, writes, environment variables, and network hosts. **No subprocess and no FFI permission**, so there is no shell to pivot through |
| Container hardening                                            | Non-root, read-only root filesystem, all capabilities dropped, seccomp, network policy | UID 65532; see `deploy/kubernetes/` and the `Containerfile`                                                                                                    |
| Input bounds                                                   | Request, response, SSE event, and finding budgets, plus upstream deadlines             | Bounded before parsing                                                                                                                                         |
| Is there a documented threat model?                            | Yes, including the gateway as a target                                                 | See [threat model](THREAT_MODEL.md), which states what a compromise of Egrysa itself yields                                                                    |
| Has an external penetration test or security review been done? | **No**                                                                                 | Not commissioned. This is an open acceptance gate, stated in the [CISO brief](CISO_BRIEF.md)                                                                   |

## Detection efficacy

| Question                                     | Answer                                                   | Evidence and limits                                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How good is the detection?                   | Measured and published, including the failures           | [Detection coverage](DETECTION_COVERAGE.md), reproducible with `deno task eval:adversarial`                                                                       |
| Known detection gaps?                        | Yes, quantified                                          | Encoded representations and obfuscated separators are the largest, measured and tracked as open issues. IPv6 is not detected                                      |
| Who authored the test corpus?                | The maintainers                                          | It is therefore **not** an independent assessment, and is marked as such. An independently authored corpus is an open acceptance gate                             |
| False positive rate?                         | Zero across nineteen negative controls under the default | `strict` trades this deliberately; the cost is published per mode                                                                                                 |
| Is there human oversight of ambiguous cases? | Yes, optional                                            | `policy.sensitivity: review` holds the request and requires a single-use acknowledgement. The acknowledgement identifies the calling workload, not a named person |

## Supply chain

| Question                                | Answer                                                                                                          | Evidence and limits                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Is the build reproducible and attested? | Signed release artefacts with SLSA provenance and SBOM                                                          | Verification commands in [release process](RELEASE.md). Certificate identity is bound to the repository path at signing time |
| Are CI actions pinned?                  | Yes, by commit SHA with version annotations                                                                     | Annotations verified against upstream tags                                                                                   |
| Dependency and vulnerability scanning   | CodeQL, dependency review, and Trivy for vulnerabilities, secrets, and misconfiguration, all blocking on `main` | Severity threshold CRITICAL and HIGH                                                                                         |
| Are base images pinned?                 | Yes, by digest                                                                                                  | See `Containerfile`                                                                                                          |
| Secret scanning on the repository       | **Alerts disabled**; push protection active                                                                     | Verified via the GitHub API. See the control status table in [release process](RELEASE.md)                                   |

## Governance, resilience, and operations

| Question                                       | Answer                                                       | Evidence and limits                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SOC 2, ISO 27001, HIPAA, PCI DSS certification | **None**                                                     | The project supplies technical controls and evidence that can support a customer's programme. It is not certified and does not make an organisation compliant |
| Framework mapping                              | Provided as an engineering crosswalk                         | [Control mapping](COMPLIANCE.md), with owner actions named per framework                                                                                      |
| Vulnerability disclosure process               | Documented and tested                                        | `SECURITY.md`; private reporting was exercised by a non-maintainer through an unpublished advisory                                                            |
| High availability                              | **None**                                                     | Receipts are single-writer. Multi-replica sequencing is a roadmap item                                                                                        |
| What happens if the gateway is unavailable?    | It is inline and fails closed, so dependent AI traffic stops | Capacity, redundancy, and the decision to fail open at the ingress are customer-owned. Treat the gateway as a new single point of failure                     |
| Incident response                              | Documented                                                   | See incident response in [operations](OPERATIONS.md)                                                                                                          |
| Business continuity of the project itself      | **Single maintainer**                                        | Bus factor is one. Stated plainly because a reviewer will determine it from commit history regardless                                                         |

## Questions this document cannot answer

An honest questionnaire has a section like this. The following require someone other than the
maintainers, and no amount of documentation substitutes for them:

1. An independent adversarial corpus, so detection efficacy is not self-reported.
2. An external security review or penetration test.
3. Operated-control evidence over time, which is what an auditor assesses and what a pre-production
   project cannot yet have.

All three are open acceptance gates in the [CISO brief](CISO_BRIEF.md) and are the reason the
project asks for a bounded technical evaluation rather than production deployment.
