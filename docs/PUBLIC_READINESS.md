# Public-readiness review

Review date: 2026-07-19

## Recommendation

**Go for a public alpha after the retained `v0.1.0-alpha.3` evidence passes; do not announce before
that verification.** The repository is public with protected `main`, required signed commits, native
security controls, a passing CI baseline, and a completed non-maintainer private-reporting test. The
signed runtime-readiness commits, container, Kubernetes, and local-provider runtime gates also have
evidence. Egrysa is selected and the founder reports legal screening complete. The remaining tagged
evidence gate is recorded below rather than hidden by a green historical workflow.

## Scorecard

| Area                               | Score | Evidence                                                                                                                      | Main gap                                                                                          |
| ---------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Security boundary                  |  8/10 | Fail-closed taxonomy; strict request field surface; local-only endpoint enforcement; authenticated metrics; keyed receipts    | Deterministic detection remains incomplete; bearer auth and software-held keys are alpha controls |
| Code and local verification        |  9/10 | Strict TypeScript; 76 tests pass; 48/48 synthetic eval cases; bounded untrusted reads and provider conformance harness        | Implementation-authored corpus; no load or independent adversarial test                           |
| Documentation and claim discipline |  9/10 | CISO brief, threat model, architecture, compliance crosswalk, operations, release, support, research, and explicit non-claims | External reviewer has not yet performed a clean-room install or claim audit                       |
| Supply chain and release           |  8/10 | Pinned actions; alpha.2 fail-closed verification; signed-SBOM alpha.3 evidence workflow; advisory triage                      | Alpha.3 image signature, SBOM, and provenance await tagged verification                           |
| Open-source governance             |  8/10 | Public repository, Apache-2.0, protected signed commits, native security controls, issue forms, and tested private reporting  | No external contributor evidence                                                                  |
| Name and legal                     |  7/10 | Egrysa selected; preliminary screen and exact namespace refresh retained; founder reports external legal screening complete   | Legal work is not reproduced here; the crates.io check was inconclusive                           |
| Enterprise production              |  4/10 | Hardened single-node baseline, durable signed receipts, and explicit responsibility model                                     | No OIDC, HA sequencing, KMS/HSM, SIEM, pen test, SLO, DR, or certification scope                  |

**Overall:** 7.5/10 for a public alpha source release; 4/10 for production enterprise use.

The score is not a compliance or security rating and should not be quoted as an assurance claim.

## Tagged-release blockers

1. **Complete:** pull request #7 merged the reviewed pre-publication hardening through protected
   `main`; post-merge CI passed at verified commit `24f13cedb202c75729c09adec0eb45681489adf3`.
2. **Complete:** non-maintainer `ksundeep9211` submitted and closed unpublished test advisory
   `GHSA-q6pq-4327-qpvw` on 2026-07-17.
3. **Pending:** from protected `main`, verify `v0.1.0-alpha.3`'s immutable registry digest,
   vulnerability result, retained CycloneDX SBOM, signature, and provenance before announcing.

## Announce-commit code evidence

- At commit `2fef037f9bc17a18a69eb3dfcd0a3b3bc9297e10`, formatting, lint, strict type checking, 76
  tests, and the black-box compatibility paths pass; one opt-in live OpenAI smoke test remains
  intentionally ignored in the local suite.
- The same commit passes all 48 deterministic synthetic cases, with exact finding and decision
  accuracy, no false positives, no high-severity egress, and no transformation leakage. Its 18-case
  offline semantic stub reports perfect per-kind precision/recall and no failures.
- Chunked request, provider-response, SSE-event, semantic-expansion, cross-workload receipt,
  response-extension residue, and overlapping-transformation regressions are included in those
  tests.

## Prior runtime and release evidence

The container, Kubernetes, CI, SBOM, and public-branch evidence below predates commit
`2fef037f9bc17a18a69eb3dfcd0a3b3bc9297e10`. It remains historical evidence, not verification of the
announce-commit code.

- The hardened container ran as UID/GID 65532 with a read-only root filesystem, dropped
  capabilities, no-new-privileges, and loopback-only host publication.
- The local image had zero detected high or critical vulnerabilities at scan time, and a local
  CycloneDX SBOM was generated. This is not registry digest, signature, or provenance evidence.
- The manifests failed closed on the placeholder image digest and then rolled out in disposable
  Kubernetes 1.36.1 with Calico 3.32.1. Labelled ingress and public HTTPS egress passed; unlabelled
  ingress and private ClusterIP egress timed out.
- A loopback Ollama `gpt-oss:20b` generation routed through Egrysa as `local_only` and emitted a
  signed, content-minimized receipt.
- One authorized OpenAI-compatible provider-adapter request used a non-sensitive prompt and returned
  the expected marker from `gpt-5.2`. The smoke test validates credential, quota, model access,
  request sanitization, and response parsing at test time; it does not prove provider retention or
  deletion behavior or exercise the full policy-gateway path.
- Commits `d7af06e` and `6119e27` were signed with the configured SSH signing key and reported as
  verified by GitHub.
- Signed implementation commit `7a39efb8006d4f77c2ca15864367eef6e927db3d` passed public pull-request
  CI, including formatting, linting, type checks, 24 tests, 48/48 synthetic evaluations, standalone
  compilation, dependency review, the security baseline, and CodeQL. Later historical container and
  Kubernetes runtime evidence is recorded in this section; registry signature, attestation, and
  provenance remain tag-only evidence.
- Signed tag `v0.1.0-alpha.1` and workflow
  [`29553773326`](https://github.com/Intellumia/egrysa/actions/runs/29553773326) exercised the
  public tag path on commit `e2b25a4`. The job reported a successful scan, image push, Sigstore
  signature, CycloneDX attestation, and GitHub provenance, but the registry/API evidence was no
  longer independently discoverable during the 2026-07-18 announce audit. No GitHub release was
  created and the tag was not moved.
- Signed tag `v0.1.0-alpha.2` and workflow
  [`29649397754`](https://github.com/Intellumia/egrysa/actions/runs/29649397754) verified the image
  signature and GitHub provenance for commit `dca67a5`, then failed closed when Cosign could no
  longer retrieve the CycloneDX predicate after provenance publication. No release was created;
  alpha.3 signs the SBOM as a separate retained release asset.
- The final documentation-link review returned HTTP 200 for all 17 external links, and the exact
  namespace refresh found no obvious npm, PyPI, Docker Hub repository, or general software-search
  collision. The crates.io check was inconclusive and no legal-clearance claim is made.
- Private release dry run `29397265834` passed source verification, image build, the Debian-vendor
  high/critical Trivy gate, and CycloneDX generation without publishing an image. The retained
  artifact digest is `sha256:6f20f944340a6a5aa8764a1fddbec57a4b7299e5ff94d156529859886581c089`; the
  extracted SBOM file digest is
  `sha256:1cc84bb53b686f7e1c953322acc929dc2690c0b90bd2008467acbda282511a15`.
- The dry-run SBOM contains 11 components and 14 advisories. The vendor-prioritized scan selected no
  high or critical findings, while some alternative rating sources include high or critical scores.
  Every advisory now has a recorded applicability and residual-risk disposition in the
  [SBOM advisory triage](SBOM_TRIAGE.md). This is not a claim that the image has no known
  vulnerabilities.
- Private CI run [`29411056348`](https://github.com/Intellumia/egrysa/actions/runs/29411056348)
  passed at commit `4b1a3e704ebb0064669955771294283fcfe48cbd`, including the independent Trivy
  filesystem vulnerability, secret, and misconfiguration baseline.
- The repository became public on 2026-07-15. Protected `main` now requires pull requests, signed
  commits, resolved conversations, and strict success from `Test and audit`, `Security baseline`,
  `CodeQL`, and `Dependency review`. Administrators are included; force pushes and branch deletion
  are disabled.
- Secret scanning, push protection, Dependabot vulnerability alerts and security updates, private
  vulnerability reporting, and read-only default workflow permissions are enabled. At cutover,
  GitHub reported zero open CodeQL, Dependabot, and secret-scanning alerts. This records repository
  state at review time, not a claim that the software has no vulnerabilities.
- Public CI run [`29415491535`](https://github.com/Intellumia/egrysa/actions/runs/29415491535)
  passed `Test and audit`, `Security baseline`, and `CodeQL` on protected `main`.
  `Dependency review` was correctly skipped because the run was a manual dispatch rather than a pull
  request.
- Public pull request #6 CI run
  [`29416315398`](https://github.com/Intellumia/egrysa/actions/runs/29416315398) passed
  `Test and audit`, `Security baseline`, `Dependency review`, and `CodeQL` at signed commit
  `0ad74a689f921a319aa41a0abff7765c5a8dbebc`.
- Public pull request #6 CI run
  [`29430794938`](https://github.com/Intellumia/egrysa/actions/runs/29430794938) passed
  `Test and audit`, `Security baseline`, `Dependency review`, and `CodeQL` for the streaming, tools,
  detector, and durable-receipt implementation at signed commit
  `7a39efb8006d4f77c2ca15864367eef6e927db3d`.

## Not blockers for the public alpha

- production-calibrated semantic detection beyond the off-by-default local reference detector;
- cumulative exposure budgets;
- cross-provider decomposition;
- enterprise control plane, SSO, HA, KMS/HSM, or SIEM integrations;
- SOC 2 or ISO 27001 work;
- confidential-compute or cryptographic inference; and
- hardware appliance.

These belong behind later evidence gates and must not delay learning from a narrow, honest alpha.
