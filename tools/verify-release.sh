#!/usr/bin/env bash
# Verify a published Egrysa release end to end.
#
# This runs exactly the commands documented under "Operator verification" in
# docs/RELEASE.md, in order, and reports pass or fail for each artefact. Those
# documented commands remain authoritative: this script is a convenience so an
# operator does not have to transcribe them, not a substitute for them, and an
# evaluator who prefers to run them by hand should do so.
#
# It is operator tooling and deliberately not a `deno task`. Verification needs
# cosign and gh, and the gateway's task definitions grant neither subprocess nor
# FFI permission. Keeping this out of the Deno task graph preserves that.
#
#   Usage: tools/verify-release.sh <tag> [--repo <owner/repo>] [--from-dir <path>]
#
#   tools/verify-release.sh v0.1.0-alpha.4
#       downloads the assets from the published release and verifies them
#
#   tools/verify-release.sh v0.1.0-alpha.4 --from-dir ./evidence
#       verifies a directory of assets that has not been published yet, which is
#       how the release process expects verification to happen: the tag workflow
#       uploads evidence as a workflow artifact and does not create a release, so
#       the artifact can be checked before anything is published at all

set -uo pipefail

TAG="${1:-}"
REPO="Intellumia/egrysa"
FROM_DIR=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --from-dir) FROM_DIR="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "Usage: tools/verify-release.sh <tag> [--repo <owner/repo>] [--from-dir <path>]" >&2
  exit 2
fi

# The certificate identity records the repository path as it was at signing
# time and cannot be reissued. Releases up to alpha.3 predate the move to the
# Intellumia organisation. Keep this in step with docs/RELEASE.md.
case "$TAG" in
  v0.1.0-alpha.1 | v0.1.0-alpha.2 | v0.1.0-alpha.3) SIGNER_REPO="sundeep229211/egrysa" ;;
  *) SIGNER_REPO="$REPO" ;;
esac
IDENTITY="https://github.com/$SIGNER_REPO/.github/workflows/release.yml@refs/tags/$TAG"
OIDC="https://token.actions.githubusercontent.com"

PASS=0
FAIL=0
SKIP=0
report() { # report <status> <name> [detail]
  case "$1" in
    pass) PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m  %s\n' "$2" ;;
    fail) FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m  %s\n' "$2"; [ -n "${3:-}" ] && printf '        %s\n' "$3" ;;
    skip) SKIP=$((SKIP + 1)); printf '  \033[33mSKIP\033[0m  %s\n' "$2"; [ -n "${3:-}" ] && printf '        %s\n' "$3" ;;
  esac
}

need() { command -v "$1" >/dev/null 2>&1; }

REQUIRED_TOOLS=(cosign)
[ -n "$FROM_DIR" ] || REQUIRED_TOOLS+=(gh)
# gh is still needed for provenance verification even when reading a directory.
need gh || REQUIRED_TOOLS=("${REQUIRED_TOOLS[@]}")
for tool in "${REQUIRED_TOOLS[@]}" gh; do
  if ! need "$tool"; then
    echo "Required tool not found: $tool" >&2
    echo "Install it and re-run. Verification cannot be faked in its absence." >&2
    exit 2
  fi
done

# macOS ships shasum rather than sha256sum.
if need sha256sum; then
  SHACHECK=(sha256sum -c)
elif need shasum; then
  SHACHECK=(shasum -a 256 -c)
else
  SHACHECK=()
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo
echo "Verifying $TAG"
echo "  repository       $REPO"
echo "  signer identity  $SIGNER_REPO"
echo

if [ -n "$FROM_DIR" ]; then
  if [ ! -d "$FROM_DIR" ]; then
    echo "No such directory: $FROM_DIR" >&2
    exit 1
  fi
  cp "$FROM_DIR"/* "$WORKDIR"/ 2>/dev/null || true
  report pass "assets read from $FROM_DIR (not yet published)"
else
  if ! gh release download "$TAG" --repo "$REPO" --dir "$WORKDIR" >/dev/null 2>&1; then
    echo "Could not download release assets for $TAG from $REPO." >&2
    echo "Confirm the release exists and that gh is authenticated." >&2
    echo "To verify before publishing, pass --from-dir with the workflow artifact." >&2
    exit 1
  fi
  report pass "release assets downloaded"
fi

EVIDENCE="$WORKDIR/release-evidence.txt"
if [ -f "$EVIDENCE" ]; then
  IMAGE="$(grep -E '^image=' "$EVIDENCE" | head -1 | cut -d= -f2-)"
  RECORDED_TAG="$(grep -E '^tag=' "$EVIDENCE" | head -1 | cut -d= -f2-)"
  if [ "$RECORDED_TAG" = "$TAG" ]; then
    report pass "release-evidence.txt records the expected tag"
  else
    report fail "release-evidence.txt tag mismatch" "recorded '$RECORDED_TAG', expected '$TAG'"
  fi
else
  IMAGE=""
  report fail "release-evidence.txt is missing" "the image digest cannot be confirmed"
fi

# 1. Signed checksums, then the checksums themselves.
if cosign verify-blob \
  --bundle "$WORKDIR/SHA256SUMS.sigstore.json" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$OIDC" \
  "$WORKDIR/SHA256SUMS" >/dev/null 2>&1; then
  report pass "SHA256SUMS signature"
else
  report fail "SHA256SUMS signature" "identity expected: $IDENTITY"
fi

if [ ${#SHACHECK[@]} -eq 0 ]; then
  report skip "SHA256SUMS contents" "no sha256sum or shasum available"
elif (cd "$WORKDIR" && "${SHACHECK[@]}" SHA256SUMS >/dev/null 2>&1); then
  report pass "SHA256SUMS contents match the retained files"
else
  report fail "SHA256SUMS contents" "a retained file does not match its recorded digest"
fi

# 2. Signed CycloneDX SBOM.
if cosign verify-blob \
  --bundle "$WORKDIR/sbom.cdx.sigstore.json" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$OIDC" \
  "$WORKDIR/sbom.cdx.json" >/dev/null 2>&1; then
  report pass "SBOM signature"
else
  report fail "SBOM signature" "identity expected: $IDENTITY"
fi

# 3. Registry signature over the immutable digest.
if [ -z "$IMAGE" ]; then
  report skip "image signature" "no image digest recorded"
elif cosign verify \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$OIDC" \
  "$IMAGE" >/dev/null 2>&1; then
  report pass "image signature over the immutable digest"
else
  report fail "image signature" "image: $IMAGE"
fi

# 4. GitHub build provenance. This is the step the v2 to v4 bump of
#    actions/attest-build-provenance changed, and no pull request exercises it,
#    because the release workflow only attests on a tag push.
if [ -z "$IMAGE" ]; then
  report skip "build provenance" "no image digest recorded"
elif gh attestation verify "oci://$IMAGE" \
  --repo "$SIGNER_REPO" \
  --bundle "$WORKDIR/provenance.bundle.jsonl" \
  --signer-workflow "$SIGNER_REPO/.github/workflows/release.yml" \
  --source-ref "refs/tags/$TAG" >/dev/null 2>&1; then
  report pass "GitHub build provenance"
else
  report fail "GitHub build provenance" "this is the step the provenance action upgrade affects"
fi

echo
echo "  $PASS passed, $FAIL failed, $SKIP skipped"
echo

if [ "$FAIL" -gt 0 ]; then
  echo "Do not announce this release. A verification failure is indistinguishable"
  echo "from tampering to anyone following the published instructions."
  exit 1
fi

echo "All checks passed. The published verification instructions hold for $TAG."
