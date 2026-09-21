#!/usr/bin/env bash
# Egrysa evaluation kit: the no-model path in one command.
#
#   ./eval-kit/quickstart.sh            run everything, then stop the servers
#   ./eval-kit/quickstart.sh --keep     leave the gateway and stub running for your own requests
#
# What it does, in order: finds or installs the pinned Deno into ./.eval-kit
# (no root, nothing outside this directory), generates local-only keys into
# .env.stub if absent, starts the stub provider and the gateway, runs the
# Phase 1 probes in eval-kit/smoke.sh, verifies the receipt chain offline
# against the public key, and prints where the evidence is. Needs bash, curl,
# and a network connection for the one-time Deno download.
set -euo pipefail

DENO_VERSION="2.9.4"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIT_DIR="$ROOT/.eval-kit"
KEEP="${1:-}"
cd "$ROOT"
mkdir -p "$KIT_DIR"

say() { printf '\n== %s\n' "$*"; }

# 1. Deno, pinned. A system Deno of the right minor is used; otherwise a
#    private copy is installed under ./.eval-kit.
find_deno() {
  for candidate in "$KIT_DIR/bin/deno" "$(command -v deno 2>/dev/null || true)" "$HOME/.deno/bin/deno"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && "$candidate" --version 2>/dev/null | grep -q "^deno ${DENO_VERSION%.*}\."; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
if ! DENO="$(find_deno)"; then
  say "Installing Deno $DENO_VERSION into $KIT_DIR (private copy, no root)"
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$KIT_DIR" sh -s "v$DENO_VERSION" >/dev/null
  DENO="$KIT_DIR/bin/deno"
fi
say "Using $("$DENO" --version | head -1) at $DENO"

# 2. Keys. Local-only; the file is git-ignored and mode 0600.
if [ ! -f .env.stub ]; then
  say "Generating local-only keys into .env.stub"
  "$DENO" run --no-prompt --allow-write=.env.stub tools/keygen.ts .env.stub
  sed -i.bak 's#^EGRYSA_CONFIG=.*#EGRYSA_CONFIG=config/egrysa.stub.json#' .env.stub && rm -f .env.stub.bak
fi
set -a; . ./.env.stub; set +a
export EGRYSA_CONFIG=config/egrysa.stub.json

# 3. Servers. Logs go under ./.eval-kit and carry no request content.
mkdir -p data
STUB_LOG="$KIT_DIR/stub.log"; GATEWAY_LOG="$KIT_DIR/gateway.log"
: > "$STUB_LOG"; : > "$GATEWAY_LOG"
"$DENO" run --no-prompt --allow-env=EGRYSA_STUB_PORT --allow-net=127.0.0.1:11435 tools/stub_provider.ts > "$STUB_LOG" 2>&1 &
STUB_PID=$!
"$DENO" run --no-prompt --allow-read=config,data --allow-write=data \
  --allow-env=EGRYSA_CONFIG,EGRYSA_INBOUND_KEYS,EGRYSA_AUDITOR_KEYS,EGRYSA_EXPORT_HEADERS,EGRYSA_RECEIPT_FINGERPRINT_KEY,EGRYSA_RECEIPT_ED25519_PRIVATE_KEY,EGRYSA_RECEIPT_ED25519_PUBLIC_KEY,EGRYSA_RECEIPT_CHAIN_SUFFIX,EGRYSA_SIGNER_HEADERS \
  --allow-net=127.0.0.1:8787,127.0.0.1:11435 src/main.ts > "$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!
stop() {
  if [ "$KEEP" = "--keep" ]; then
    say "Left running: gateway http://127.0.0.1:8787 (pid $GATEWAY_PID), stub 127.0.0.1:11435 (pid $STUB_PID)"
    echo "   Your bearer key is EGRYSA_CLIENT_KEY in .env.stub. Stop with: kill $GATEWAY_PID $STUB_PID"
  else
    kill "$GATEWAY_PID" "$STUB_PID" 2>/dev/null || true
    wait "$GATEWAY_PID" "$STUB_PID" 2>/dev/null || true
  fi
}
trap stop EXIT
for _ in $(seq 1 50); do
  curl -sf http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf http://127.0.0.1:8787/healthz >/dev/null || { echo "gateway did not start; see $GATEWAY_LOG"; exit 1; }

# 4. Probes.
say "Running the Phase 1 probes"
"$ROOT/eval-kit/smoke.sh" http://127.0.0.1:8787 "$EGRYSA_CLIENT_KEY" "$STUB_LOG"

# 5. Receipt chain, verified offline with only the public key.
say "Verifying the receipt chain offline"
LOG_PATH="$(grep -o '"receiptLogPath": *"[^"]*"' "$EGRYSA_CONFIG" | sed 's/.*: *"//; s/"$//')"
CHAIN_ID="$(grep -o '"receiptChainId": *"[^"]*"' "$EGRYSA_CONFIG" | sed 's/.*: *"//; s/"$//')"
"$DENO" run --no-prompt --allow-read tools/verify_receipt_log.ts "$LOG_PATH" "$EGRYSA_RECEIPT_ED25519_PUBLIC_KEY" "$CHAIN_ID"

say "Done"
cat <<EOF
   Receipt log:   $LOG_PATH   (content-free; verify it any time with: deno task receipts:verify)
   Stub log:      $STUB_LOG   (what left the gateway: surrogates, not your values)
   Gateway log:   $GATEWAY_LOG (structured events, no content)
   Next: ./eval-kit/evidence.sh builds the bundle to send back; docs/RUNBOOKS.md and docs/OPERATIONS.md for Phase 2.
EOF
