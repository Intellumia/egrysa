#!/usr/bin/env bash
# Phase 1 probes against a running gateway. Prints PASS or FAIL per probe and
# exits non-zero if any failed. Needs only curl and grep.
#
#   eval-kit/smoke.sh <gateway url> <bearer key> [stub log path]
#
# With the stub log path, the probes also check what actually left the
# gateway: the surrogate token must be there and the original value must not.
set -uo pipefail

URL="${1:?gateway url}"; KEY="${2:?bearer key}"; STUB_LOG="${3:-}"
MODEL="stub-echo"
EMAIL="alex.rivera@example.com"
failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n      %s\n' "$1" "$2"; failures=$((failures + 1)); }
auth=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
post() { curl -s -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' -X POST "$URL/v1/chat/completions" "${auth[@]}" -d "$1"; }
header() { grep -i "^$1:" "$TMP/headers" | tr -d '\r' | sed 's/^[^:]*: *//'; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# 1. Liveness and model discovery.
code="$(curl -s -o "$TMP/body" -w '%{http_code}' "$URL/v1/models" "${auth[@]}")"
if [ "$code" = "200" ] && grep -q "\"$MODEL\"" "$TMP/body"; then pass "model discovery lists $MODEL"; else fail "model discovery" "status $code: $(head -c 200 "$TMP/body")"; fi

# 2. Unauthenticated requests are refused.
code="$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$URL/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"hi"}]}')"
if [ "$code" = "401" ]; then pass "missing bearer refused with 401"; else fail "missing bearer" "status $code"; fi

# 3. Transform: the client sees the original, the provider saw a surrogate.
code="$(post '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"Email '"$EMAIL"' from host 192.0.2.44 about the incident."}]}')"
decision="$(header x-egrysa-decision)"; receipt="$(header x-egrysa-receipt)"
if [ "$code" = "200" ] && [ "$decision" = "transform" ] && grep -q "$EMAIL" "$TMP/body"; then
  pass "transform: 200, x-egrysa-decision=transform, original recomposed for the client"
else fail "transform" "status $code decision '$decision': $(head -c 200 "$TMP/body")"; fi
if [ -n "$STUB_LOG" ]; then
  if grep -q "__EGRYSA_EMAIL_" "$STUB_LOG" && ! grep -q "$EMAIL" "$STUB_LOG"; then
    pass "provider saw a surrogate token and never the email"
  else fail "provider-side check" "stub log lacks a surrogate or carries the original: $(tail -2 "$STUB_LOG")"; fi
fi

# 4. The receipt for that request: signed, content-free, attributed.
code="$(curl -s -o "$TMP/body" -w '%{http_code}' "$URL/v1/receipts/$receipt" "${auth[@]}")"
if [ "$code" = "200" ] && grep -q '"signature"' "$TMP/body" && grep -q '"decision":"transform"' "$TMP/body" && ! grep -q "$EMAIL" "$TMP/body"; then
  pass "receipt $receipt is signed, records the decision, carries no content"
else fail "receipt fetch" "status $code: $(head -c 300 "$TMP/body")"; fi

# 5. Deny: a blocked class never leaves, and the denial itself has a receipt.
code="$(post '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"Charge card 4111 1111 1111 1111 please"}]}')"
if [ "$code" = "403" ] && grep -q '"receiptId"' "$TMP/body" && ! grep -q "4111" "$TMP/body"; then
  pass "deny: 403 with a receipt id and no content in the error"
else fail "deny" "status $code: $(head -c 200 "$TMP/body")"; fi
if [ -n "$STUB_LOG" ] && grep -q "4111" "$STUB_LOG"; then fail "deny egress" "the card number reached the provider"; fi

# 6. Streaming: same recomposition over SSE.
code="$(post '{"model":"'"$MODEL"'","stream":true,"messages":[{"role":"user","content":"Email '"$EMAIL"' again."}]}')"
if [ "$code" = "200" ] && grep -q "\[DONE\]" "$TMP/body" && grep -q "$EMAIL" "$TMP/body"; then
  pass "streaming: recomposed across SSE chunks, terminated with [DONE]"
else fail "streaming" "status $code: $(head -c 200 "$TMP/body")"; fi

# 7. Public verification material and the signed chain head.
code="$(curl -s -o "$TMP/body" -w '%{http_code}' "$URL/v1/receipts/public-key" "${auth[@]}")"
if [ "$code" = "200" ] && grep -q '"publicKey"' "$TMP/body"; then pass "public verification key published"; else fail "public key" "status $code"; fi
code="$(curl -s -o "$TMP/body" -w '%{http_code}' "$URL/v1/receipts/checkpoint" "${auth[@]}")"
if [ "$code" = "200" ] && grep -q '"sequence"' "$TMP/body" && grep -q '"signature"' "$TMP/body"; then
  pass "signed chain checkpoint: $(grep -o '"sequence":[0-9]*' "$TMP/body")"
else fail "checkpoint" "status $code"; fi

# 8. Nothing sensitive in the metrics.
code="$(curl -s -o "$TMP/body" -w '%{http_code}' "$URL/metrics" "${auth[@]}")"
if [ "$code" = "200" ] && ! grep -q "$EMAIL" "$TMP/body" && ! grep -q "4111" "$TMP/body"; then pass "metrics are content-free"; else fail "metrics" "status $code"; fi

echo
if [ "$failures" -eq 0 ]; then echo "All probes passed."; else echo "$failures probe(s) failed."; exit 1; fi
