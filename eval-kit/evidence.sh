#!/usr/bin/env bash
# Build the evidence bundle for an evaluation: every published check, run on
# this machine, with versions and digests, in one folder to send back.
#
#   ./eval-kit/evidence.sh [output dir]      default: evidence/<UTC date>
#
# Nothing in the bundle carries request content: the reports print counts,
# digests, and timings. Takes a few minutes; the benchmark is the slow part.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OUT="${1:-evidence/$(date -u +%Y-%m-%dT%H%M%SZ)}"
mkdir -p "$OUT"
DENO="${DENO:-$( [ -x .eval-kit/bin/deno ] && echo .eval-kit/bin/deno || command -v deno || echo "$HOME/.deno/bin/deno")}"

step() {
  local name="$1"; shift
  printf '%-22s' "$name"
  if "$@" > "$OUT/$name.log" 2>&1; then echo "ok"; echo "$name: ok" >> "$OUT/RESULTS.txt"; else echo "FAILED (see $OUT/$name.log)"; echo "$name: FAILED" >> "$OUT/RESULTS.txt"; fi
}
: > "$OUT/RESULTS.txt"

{
  echo "egrysa evidence bundle"
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source: $(git describe --tags --always 2>/dev/null || echo 'not a git checkout')"
  echo "deno: $("$DENO" --version | head -1)"
  echo "os: $(uname -srm)"
} > "$OUT/ENVIRONMENT.txt"

step check          "$DENO" task check
step eval           "$DENO" task eval
step eval-adversarial "$DENO" task eval:adversarial
step eval-scenarios "$DENO" task eval:scenarios
step acceptance     "$DENO" task acceptance
step audit          "$DENO" audit
step bench-e2e      "$DENO" task bench:e2e
step config-check   "$DENO" task config:check config/egrysa.stub.json

# Task quality needs a model that can actually answer, so it runs only when one
# is named. EGRYSA_QUALITY_CONFIG points at a configuration whose provider is
# reachable; EGRYSA_QUALITY_MODEL names the model to use.
if [ -n "${EGRYSA_QUALITY_MODEL:-}" ]; then
  step task-quality "$DENO" task eval:quality \
    "--config=${EGRYSA_QUALITY_CONFIG:-config/egrysa.example.json}" \
    "--model=$EGRYSA_QUALITY_MODEL" \
    "--repeats=${EGRYSA_QUALITY_REPEATS:-3}"
else
  echo "task-quality           skipped (set EGRYSA_QUALITY_MODEL to measure it)"
  echo "task-quality: skipped" >> "$OUT/RESULTS.txt"
fi

for f in evals/adversarial.jsonl evals/scenarios.jsonl evals/cases.jsonl api/config.schema.json api/openapi.yaml; do
  [ -f "$f" ] && shasum -a 256 "$f"
done > "$OUT/DIGESTS.txt"

{
  echo "# Evidence summary"
  echo
  cat "$OUT/ENVIRONMENT.txt"
  echo
  echo "## Results"
  cat "$OUT/RESULTS.txt"
  echo
  echo "## Detection"
  grep -h "cases " "$OUT/eval-adversarial.log" "$OUT/eval-scenarios.log" 2>/dev/null
  echo
  echo "## Gateway overhead (deno task bench:e2e)"
  grep -E "^\| (target|-|provider|gateway)" "$OUT/bench-e2e.log" 2>/dev/null
  echo
  echo "## Tests"
  grep -hE "passed|FAILED" "$OUT/check.log" "$OUT/acceptance.log" 2>/dev/null | tail -2
} > "$OUT/SUMMARY.md"

echo
echo "Bundle written to $OUT"
echo "Send the folder back as is; it holds logs, counts, digests and timings, and no request content."
