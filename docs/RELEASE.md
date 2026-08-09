# Release process

## Preconditions

- The release commit is reachable from protected `main`.
- `deno task check`, `deno task eval`, and `deno audit` pass.
- Public claims match demonstrated behavior and `CHANGELOG.md` is current.
- Hardened container and Kubernetes probes pass with the durable receipt volume, Ed25519 keys,
  streaming, tools, restart continuity, and tamper rejection.
- GitHub private vulnerability reporting is enabled and tested.
- The tag is annotated and signed by an authorized maintainer.

These controls are enabled on the public repository, the non-maintainer private-reporting test is
complete, and the reviewed implementation has fresh local evidence plus passing protected-branch CI.
Never move or reuse a published tag; advance the alpha suffix when the release commit changes.

## Private no-payment staging

Run the release workflow manually on the reviewed branch before publication. The manual path runs
source verification, builds the release Containerfile, blocks on known high or critical image
vulnerabilities, generates a CycloneDX SBOM, and retains that SBOM for seven days. It does not push
an image, create a release, sign a registry digest, or claim provenance.

The private dry run is staging evidence, not a release substitute. The immutable registry digest,
Sigstore signature, signed CycloneDX release asset, and GitHub build provenance are verified only
from the public tagged workflow.

Passing the high/critical gate is not a no-vulnerability claim. Retain the complete SBOM and record
the disposition of every advisory, including findings whose selected vendor severity is below the
blocking threshold or whose alternative-source rating is higher. The current base-image findings and
recheck policy are recorded in [the SBOM advisory triage](SBOM_TRIAGE.md).

## Automated evidence

A `v*` tag on `main` triggers verification, builds a local candidate image, blocks on high or
critical known vulnerabilities, publishes the final image, generates SBOM and SLSA provenance, signs
the immutable digest with Sigstore/cosign, and creates a GitHub build attestation. The job then
independently verifies the registry signature and GitHub provenance, then keyless-signs and verifies
the CycloneDX document as a release asset. It retains the SBOM, bundles, verification results, image
identity, and signed checksums as one workflow artifact for attachment to the GitHub release.

## Operator verification

Verify the tag signature, GitHub attestation, cosign identity, image digest, and SBOM before copying
the digest into a deployment manifest. Never deploy a mutable tag. The all-zero digest in the sample
manifest is an intentional fail-closed placeholder.

The commands below are the authoritative procedure. To run them without transcribing:

```sh
# After the tag workflow finishes, before any release exists:
gh run download --name egrysa-release-evidence-v0.1.0-alpha.4 --dir ./evidence
tools/verify-release.sh v0.1.0-alpha.4 --from-dir ./evidence

# Or, against an already published release:
tools/verify-release.sh v0.1.0-alpha.4
```

The tag workflow uploads the evidence as a workflow artifact and does **not** create a GitHub
release. Verifying the artifact first is what makes step 8 of the cutover sequence possible: nothing
is published until the evidence has been checked.

It executes exactly these commands in order, selects the signer identity for the tag, reads the
image digest from `release-evidence.txt`, and exits non-zero if any artefact fails. It is operator
tooling and deliberately not a `deno task`: verification needs `cosign` and `gh`, and the gateway's
task definitions grant neither subprocess nor FFI permission.

An evaluator who would rather not trust a script from the same repository should run the commands
below directly. That is the point of publishing them, and the script exists to remove transcription
errors, not to replace independent verification.

Download the release assets, then verify their integrity and the published registry evidence. Set
`TAG` to the exact release and `IMAGE` to the digest reference recorded in `release-evidence.txt`:

The certificate identity records the repository path as it was at signing time, and it cannot be
re-issued for an existing release. This repository moved from `sundeep229211/egrysa` to
`Intellumia/egrysa`, so `SIGNER_REPO` below selects the identity that matches the tag being
verified. Using the wrong one fails closed with a `no matching CertificateIdentity found` error,
which is a naming mismatch rather than evidence of tampering.

```sh
gh release download "$TAG"

case "$TAG" in
  v0.1.0-alpha.1 | v0.1.0-alpha.2 | v0.1.0-alpha.3) SIGNER_REPO=sundeep229211/egrysa ;;
  *) SIGNER_REPO=Intellumia/egrysa ;;
esac
IDENTITY="https://github.com/$SIGNER_REPO/.github/workflows/release.yml@refs/tags/$TAG"

cosign verify-blob \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c SHA256SUMS
cosign verify-blob \
  --bundle sbom.cdx.sigstore.json \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  sbom.cdx.json
cosign verify \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$IMAGE"
gh attestation verify "oci://$IMAGE" \
  --repo "$SIGNER_REPO" \
  --bundle provenance.bundle.jsonl \
  --signer-workflow "$SIGNER_REPO/.github/workflows/release.yml" \
  --source-ref "refs/tags/$TAG"
```

Releases signed after the move derive their identity from `$GITHUB_REPOSITORY` in
`.github/workflows/release.yml`, so they require no manual selection and fall through to the
`Intellumia/egrysa` default above.

### Verify before announcing

The release workflow attests provenance only on a tag push, so no pull request exercises signing or
attestation. A dry run through `workflow_dispatch` builds, scans, and generates an SBOM, but it does
**not** execute the attestation step and therefore cannot validate it.

The consequence is that a change to the signing or attestation path is first exercised by a real
tag. Treat the next tag as the verification release: tag it, announce nothing, run
`tools/verify-release.sh` against it, and only then decide whether to publish or announce. If it
fails, advance the alpha suffix and repeat. An unannounced release that fails verification costs
nothing; an announced one that fails is indistinguishable from tampering to anyone following these
instructions.

Recorded results:

| Tag              | Verified   | Result                                                   |
| ---------------- | ---------- | -------------------------------------------------------- |
| `v0.1.0-alpha.3` | 2026-08-09 | 7 of 7 checks passed, using the pre-move signer identity |

The signed checksum bundle makes the retained files independently verifiable even if a registry or
API later stops indexing an attached artifact. The registry checks additionally prove that the
currently retrievable image attachments match the release identity.

## Controlled publication cutover

1. Complete review and merge the signed commit while the repository remains private.
2. Run the manual release dry run and retain its workflow URL and SBOM digest.
3. Re-run the secret/history, link, namespace, and clean-room installation checks.
4. With explicit founder approval, change visibility to public without announcing a release.
5. Immediately enable branch protection, CodeQL/code scanning, dependency review, secret scanning,
   push protection, and private vulnerability reporting.
6. Manually dispatch CI on `main`; resolve every native security finding and required check.
7. Create the next signed alpha tag only after the public controls pass.
8. Verify the resulting digest, vulnerability scan, signed SBOM, image signature, and provenance
   before creating or announcing a GitHub release.

If any control cannot be enabled or any scan fails, stop the cutover. Do not weaken a workflow or
publish a release to work around the failure.

### Control status verified on 2026-08-09

Verified against the GitHub API rather than restated from the cutover record below.

| Control                                           | Status       | How verified                                                                                                      |
| ------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `main` protected, force push and deletion blocked | enabled      | branch protection API                                                                                             |
| Signed commits required                           | enabled      | `required_signatures`                                                                                             |
| Administrators included in protection             | enabled      | `enforce_admins`                                                                                                  |
| Required checks before merge                      | enabled      | Test and audit, Security baseline, CodeQL, Dependency review                                                      |
| Required approving reviews                        | **0**        | `required_pull_request_reviews` is not configured                                                                 |
| CodeQL code scanning                              | enabled      | required check on `main`                                                                                          |
| Dependabot security updates                       | enabled      | `security_and_analysis`                                                                                           |
| Push protection                                   | active       | empirically blocks a push containing a recognised credential; GitHub applies it to public repositories by default |
| **Secret scanning alerts**                        | **disabled** | `GET /secret-scanning/alerts` returns `404 Secret scanning is disabled on this repository`                        |
| Private vulnerability reporting                   | enabled      | tested by a non-maintainer, see below                                                                             |

Two of these deserve a reviewer's attention rather than a footnote. **Secret scanning alerts are
off**, so a credential already present in history, or one introduced through a path push protection
does not cover, would not raise an alert. Push protection is the only active secret control. And
**no approving review is required to merge**, so protection enforces checks rather than a second
pair of eyes; with a single maintainer this is a stated bus-factor consequence, not an oversight.

Enabling secret scanning will immediately alert on `evals/adversarial.jsonl`, which contains
deliberately credential-shaped fixtures. Those alerts are expected and should be dismissed as test
fixtures rather than treated as findings. See [detection coverage](DETECTION_COVERAGE.md) for why
the corpus must contain them.

### Cutover status on 2026-07-19

- Steps 1 through 5 were recorded complete at cutover: the repository is public, `main` is
  protected, signed commits are required, and CodeQL, secret scanning, push protection, Dependabot
  security updates, and private vulnerability reporting were reported enabled. The secret-scanning
  element of that record does not match the verified status above and is retained only as the
  original entry.
- Public CI run [`29415491535`](https://github.com/Intellumia/egrysa/actions/runs/29415491535)
  passed source verification, the independent security baseline, and CodeQL on protected `main`.
- The private reporting route was tested by non-maintainer `ksundeep9211` through closed,
  unpublished advisory `GHSA-q6pq-4327-qpvw` on 2026-07-17.
- Signed tag `v0.1.0-alpha.1` points to commit `e2b25a4`. Its tag workflow
  [`29553773326`](https://github.com/Intellumia/egrysa/actions/runs/29553773326) passed and
  published an image, but its registry/API attestations were no longer independently discoverable
  during the pre-announcement audit. The tag remains immutable and no GitHub release was created.
- Pull request #7 merged the announce candidate through protected `main` at verified commit
  `24f13cedb202c75729c09adec0eb45681489adf3`; post-merge CI
  [`29648549050`](https://github.com/Intellumia/egrysa/actions/runs/29648549050) passed.
- Signed tag `v0.1.0-alpha.2` points to `dca67a5`. Its workflow
  [`29649397754`](https://github.com/Intellumia/egrysa/actions/runs/29649397754) proved the image
  signature and GitHub provenance but failed closed because the provenance referrer displaced the
  retrievable CycloneDX predicate. No release was created and the tag remains immutable.
- `v0.1.0-alpha.3` is the next release target. Its CycloneDX document is a separately keyless-signed
  release asset, avoiding the registry predicate collision. It must pass retained and independent
  verification before a GitHub release is created.

## Alpha versioning

Use `v0.1.0-alpha.N` until the public API, receipt schema, configuration schema, and support window
are stable. Security fixes increment the prerelease number and document impact in the changelog.
