# Evaluation kit

Everything a client's engineer needs to see the control boundary work on their own machine, in about
fifteen minutes, without a model, a provider key, root access, or a conversation with us.

## One command

```sh
./eval-kit/quickstart.sh
```

It installs a private copy of the pinned Deno runtime under `./.eval-kit` if none is present (no
root, nothing outside this directory), generates local-only keys into `.env.stub`, starts a stub
provider and the gateway on loopback, runs the Phase 1 probes, verifies the receipt chain offline
against the public key, and stops. Needs bash, curl, and a network connection for the one-time Deno
download. `--keep` leaves the gateway running for your own requests.

Expected output ends with eight `PASS` lines and a verified chain:

```text
PASS  model discovery lists stub-echo
PASS  missing bearer refused with 401
PASS  transform: 200, x-egrysa-decision=transform, original recomposed for the client
PASS  provider saw a surrogate token and never the email
PASS  receipt ... is signed, records the decision, carries no content
PASS  deny: 403 with a receipt id and no content in the error
PASS  streaming: recomposed across SSE chunks, terminated with [DONE]
PASS  public verification key published
PASS  signed chain checkpoint: "sequence":N
PASS  metrics are content-free
All probes passed.
{ "ok": true, ... "head": { "sequence": N, ... } }
```

## What to look at

- `.eval-kit/stub.log` is what left the gateway: surrogate tokens such as
  `__EGRYSA_EMAIL_0001_...__`, never the values you sent. This is the control boundary.
- `data/receipts.stub.jsonl` is the receipt chain: one signed, hash-chained, content-free record per
  request. `deno task receipts:verify data/receipts.stub.jsonl <public key> egrysa-local-alpha`
  verifies it with the public key alone, and `tests/receipts_test.ts` shows how to verify a single
  receipt in code.
- `.eval-kit/gateway.log` is the structured event log: no content, by test
  (`tests/redaction_test.ts`).

## Your own requests

```sh
./eval-kit/quickstart.sh --keep
set -a; . ./.env.stub; set +a
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $EGRYSA_CLIENT_KEY" -H "Content-Type: application/json" \
  -d '{"model":"stub-echo","messages":[{"role":"user","content":"Email alex@example.com from 192.0.2.44"}]}'
```

Add `"stream": true` for SSE. Send a card number to see a deny with a receipt id. Any
OpenAI-compatible SDK works by pointing its base URL at `http://127.0.0.1:8787/v1` with the bearer
key; the Anthropic Messages shape works at `/v1/messages`.

## Evidence to send back

```sh
./eval-kit/evidence.sh
```

Runs every published check on your machine (format, lint, types, tests, the synthetic, adversarial
and scenario corpora, the acceptance suite, the dependency audit, the end-to-end benchmark, and the
configuration check) and writes the logs, counts, digests, and timings to `evidence/<timestamp>/`,
with a `SUMMARY.md`. Nothing in it carries request content. Send the folder as is.

## Phase 2

Phase 2 adds your own workflow, your own corpus, and a real model, inside the boundary the handover
pack describes:

- Names and addresses: run the NER sidecar on your hardware, `tools/ner_sidecar/README.md`.
- A local model for `local_only` routing: Ollama or any OpenAI-compatible server on loopback.
- One contracted remote provider with `store: false` and your own model allowlist:
  `docs/OPERATIONS.md`, "Cloud-hosted providers".
- Your corpus: `docs/CORPUS_BRIEF.md`. Measure with `deno task eval:adversarial --corpus=<file>`.
- Task quality, the effect of the boundary on the answers themselves:
  `EGRYSA_QUALITY_MODEL=<model> EGRYSA_QUALITY_CONFIG=<config> ./eval-kit/evidence.sh`, or
  `deno task eval:quality` directly. Write your own cases in the shape of
  `evals/task_quality.jsonl`; the published measurement and its one real limitation are in
  `docs/EVALUATION.md`.
- Load at your concurrency on your storage: `deno task bench:e2e`, and the HTTP harness of your
  choice against `--keep`.
- Operations: `docs/RUNBOOKS.md` for policy change, upgrade, bypass, backup and restore;
  `docs/COMPATIBILITY.md` for what will not change under you.

## Removing it

`kill` the two processes if you used `--keep`, then delete `.eval-kit/`, `.env.stub`, `data/`, and
`evidence/`. Nothing was installed elsewhere.
