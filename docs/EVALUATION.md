# Evaluation record

Date: 2026-09-20

Measured implementation commit: `5002c7879a0f5bbc88cf0881a0ed4beeba72846b` (tag `v0.1.0-alpha.4`)

Runtime: Deno 2.9.4 on Apple Silicon, matching the CI pin

Suite: `egrysa-synthetic-v2`

## Results

| Gate                                          |                                                  Result |
| --------------------------------------------- | ------------------------------------------------------: |
| Unit/integration tests                        |       89 passed, 0 failed, 1 ignored (opt-in live test) |
| Black-box compatibility acceptance            |                                      2 passed, 0 failed |
| Expected data-class decisions                 |                                                   48/48 |
| Exact expected finding sets                   |                                                   48/48 |
| Macro detector precision / recall             |                                             1.00 / 1.00 |
| Negative-case false positives                 |                                                       0 |
| Adversarial corpus, balanced sensitivity      |                   77/102 detected, 0/19 false positives |
| Realistic scenario corpus                     | 64/67 detected, 0 undisclosed misses, 0 false positives |
| High-severity secret egress                   |                                                       0 |
| Mean classifier plus policy time              |                             0.12 ms in the measured run |
| Raw prompt persistence by evaluation harness  |                                                   false |
| End-to-end surrogate/recomposition path       |                      passed against local HTTP upstream |
| SSE split-token recomposition                 |                                passed against local SSE |
| Tool argument transformation/recomposition    |                               passed against local HTTP |
| Receipt restart continuity / tamper rejection |                                                  passed |
| Standalone arm64 binary                       |                          compiled successfully, 67.7 MB |
| Hardened container runtime                    |               prior: passed with restricted host launch |
| Local image high/critical vulnerability scan  |                              prior: 0 detected by Trivy |
| Local CycloneDX SBOM                          |                     prior: generated with 11 components |
| Kubernetes PVC and pod-replacement continuity |         prior: passed on Kubernetes 1.36.1 with kindnet |
| Prior network-policy enforcement              |          passed on Kubernetes 1.36.1 with Calico 3.32.1 |
| Ollama local generation through Egrysa        |         prior: `local_only` decision and signed receipt |
| OpenAI provider-adapter generation            |              prior: one authorized `gpt-5.2` smoke test |

## Reference semantic detector evidence

`evals/semantic_cases.jsonl` contains 18 implementation-authored cases: four person-name positives,
four physical-address positives, four semantically confidential organizational positives, and six
negative cases. The evaluator compares finding kinds per case and reports per-kind precision/recall,
negative-case false-positive rate, detector failures, and p95 added latency. Candidate strings are
synthetic and the harness does not persist prompts.

The normal `deno task eval` path uses `egrysa.eval.semantic-stub@1.0.0`, a deterministic offline
detector that keeps CI reproducible and exercises semantic policy/evaluation accounting without
starting a model:

| Offline semantic metric                  |   Result |
| ---------------------------------------- | -------: |
| Cases                                    |       18 |
| Person-name precision / recall           |    1 / 1 |
| Physical-address precision / recall      |    1 / 1 |
| Semantic-confidential precision / recall |    1 / 1 |
| Negative-case false-positive rate        |        0 |
| p95 added latency                        | 0.046 ms |
| Detector failures                        |        0 |

A separate live run used the reference detector `egrysa.reference.local-semantic@0.2.0`, Ollama
`0.32.1`, and the locally installed `gpt-oss:20b` artifact ID `17052f91a42e` on an Apple M4 Pro. The
detector endpoint was loopback-only and no fixture left the host:

| Live semantic metric                     |        Result |
| ---------------------------------------- | ------------: |
| Cases                                    |            18 |
| Person-name precision / recall           |   1.00 / 1.00 |
| Physical-address precision / recall      |   0.80 / 1.00 |
| Semantic-confidential precision / recall |   1.00 / 1.00 |
| Macro precision / recall                 | 0.9333 / 1.00 |
| Negative-case false-positive rate        |        0.1667 |
| p95 added latency                        |  11,945.98 ms |
| Detector failures                        |             0 |

These are reference measurements, not a release recall gate or a claim about other hardware,
prompts, quantizations, model versions, or organizations. The physical-address false positive and
interactive latency demonstrate why semantic findings remain low precision, off by default, and
unable to hard-deny a request by themselves.

## Runtime evidence

The unit/integration suite, acceptance suite, synthetic-v2, adversarial, and scenario results, and
the standalone compile were refreshed at commit `5002c7879a0f5bbc88cf0881a0ed4beeba72846b`. The
container, vulnerability scan, SBOM, Kubernetes persistence, Ollama, live-provider, and Calico
network-policy observations below predate that commit and were not rerun for this measurement.

The black-box acceptance task passed model discovery, non-streaming and split-token streaming
recomposition, function tools, mutated-surrogate failure, provider timeout, stream cancellation,
workload attribution, public receipt verification, checkpoint retrieval, restart continuity, and the
local semantic transform/receipt path against local mock providers.

The last measured container image digest, which predates the measured implementation commit, is
`sha256:427e35f654c94881eddf6ee2674825697f6e2917ade569b6648786bc3a30efbb`. It listened through its
container-specific configuration and was published only on host loopback. It ran as UID/GID 65532
with a read-only root filesystem, a `noexec` and `nosuid` temporary filesystem, no Linux
capabilities, and no-new-privileges. Authenticated model discovery, deny behavior, receipt
retrieval, Ed25519 public-key discovery, and signed checkpoint retrieval passed. The chain head
survived a container restart on the named volume.

A fresh named volume initially failed closed because it was root-owned, and an `.env.local`
generated for host development initially selected the host configuration inside the container. The
operator instructions now require ownership by UID/GID 65532 and explicitly pin the container
configuration.

Trivy 0.72.0 reported zero high or critical findings using its 2026-07-15 database. The last
measured CycloneDX SBOM contains 11 components and has SHA-256 digest
`c993e6d3bd3cc445d3530cf2a83c6994d186c8e7584164b334a4254d9caec0b5`. These are local-image
observations, not registry signature or future-image claims.

That last measured image was loaded into a disposable Kubernetes 1.36.1 kind cluster. The PVC bound,
the pod became ready as UID/GID 65532, and seccomp, read-only-root, no-service-account-token,
dropped capabilities, and `fsGroup` controls remained effective. After a policy-denied request
created receipt sequence 1, Kubernetes replaced the pod and the new process resumed the identical
receipt hash, sequence, signing-key ID, and chain ID from the PVC.

In the preceding Calico 3.32.1 run, labelled client ingress and public HTTPS egress succeeded while
unlabelled client ingress and private ClusterIP egress timed out.

The same ClusterIP private-egress probe was reachable under kindnet. Kubernetes Service translation
and `ipBlock` enforcement ordering are CNI-dependent, so the manifest alone does not prove portable
private-range denial. Operators must validate the chosen CNI and retain an egress proxy or firewall
as the authoritative provider-host restriction.

A local Ollama `gpt-oss:20b` request containing a synthetic confidential term routed through Egrysa
with decision `local_only`, provider `local`, and a signed receipt. The receipt recorded one
`confidential_term`, `rawContentPersisted=false`, and `providerStoreRequested=false`. Only minimized
metadata was retained for this evaluation.

One authorized OpenAI-compatible provider-adapter request used a non-sensitive instruction and
returned the expected marker from `gpt-5.2`. This validates the configured credential, available
quota, model access, request sanitization, and response parsing at test time. It does not exercise
the full policy-gateway path, establish production reliability, or prove provider retention or
deletion behavior.

## Interpretation

These results prove that the current deterministic paths behave as expected on a 48-case synthetic
corpus and that the reference local semantic path operates against both a deterministic CI stub and
one measured local model. They do not establish real-world recall, semantic privacy, model quality,
throughput, availability, or regulatory compliance. Both corpora remain implementation-authored
rather than independently labelled.

## Required independent evaluation

Before a CISO pilot, create at least 100 synthetic or authorized redacted prompts per business
workflow, including obfuscation and false-positive cases. Label them independently. Report precision
and recall per data class, policy accuracy, answer-quality deltas, p50/p95/p99 overhead,
concurrency, memory, denial behavior, and provider-specific failures. Preserve only approved test
data and content-minimized aggregate results.

Run locally with:

```sh
deno task check
deno task eval
deno task acceptance
EGRYSA_CONFIG=config/<enabled-local-config>.json deno task eval:semantic
EGRYSA_LIVE_TEST=1 deno task smoke
```

The live semantic and provider-generation tests are deliberately separate. CI uses only the
deterministic semantic stub, never spends provider quota, and never sends semantic fixtures to a
model endpoint.
