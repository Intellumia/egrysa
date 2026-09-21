# Runbooks

Procedures for the situations an operator meets after the gateway is running. Each names what to
check, what to do, what evidence to keep, and what never to do. Key rotation and incident response
stay in [the operations guide](OPERATIONS.md); the runbooks here cover policy change and rollback,
upgrade and downgrade, safe bypass, backup and restore of evidence, and the outages the gateway is
designed to survive.

Two tools support them. `deno task config:check [path]` validates a configuration without starting
the gateway and prints its SHA-256. `deno task receipts:verify <log> <public key> [chain id]`
verifies a receipt log offline: every signature, every hash, and the continuity of the chain,
needing only the public key.

## Policy change and rollback

A policy change is a configuration change: the JSON file, or the ConfigMap in Kubernetes. Receipts
record the decision made under the policy in force at the time, not the policy itself, so the change
record is what ties a receipt to a policy version.

1. Edit the configuration. Run `deno task config:check <path>` and record the printed SHA-256 in the
   change ticket together with the receipt checkpoint from `/v1/receipts/checkpoint` taken just
   before the rollout. Everything after that sequence number ran under the new policy.
2. If the change tightens policy (a class moves from transform to deny, a model leaves an
   allowlist), expect denials; tell the workload owners first. If it loosens policy, it needs the
   same review as a code change: a class moving from deny to transform is a data-flow change.
3. Roll out. The gateway validates on start and refuses an invalid file, so a bad configuration
   fails the rollout rather than the traffic. Probe with a known-transform and a known-deny request
   and read the receipts.
4. **Rollback** is the previous file with its recorded SHA-256, rolled out the same way. Record the
   checkpoint at rollback too. There is no partial rollback: a configuration is one document.

Never edit policy on a running instance by any path other than a rollout, and never "temporarily"
remove a kind from `blockKinds` to unblock a workload; use a per-workload override with its own
review, or the bypass runbook below.

## Upgrade and downgrade

Before any upgrade read the changelog entry against [the compatibility policy](COMPATIBILITY.md):
within a schema version, an upgrade is additive and the current configuration remains valid.

1. Verify the release: `tools/verify-release.sh <tag>` for the image, or the tarball hash for
   source. Do not deploy a mutable tag.
2. Run `deno task config:check` under the new release against the production configuration. A
   deprecated field is reported as accepted; an unknown field is refused, which is the signal that a
   retirement announced a release earlier has now happened.
3. Deploy to one replica first. Probe transform, deny, streaming, a receipt fetch, and a checkpoint.
   Confirm the receipt log continues: the new release loads the existing chain and appends to it,
   and `/v1/receipts/checkpoint` shows the sequence advancing from where the old release left it.
4. Roll the rest.

**Downgrade** is allowed within a schema version with one condition. If the newer release introduced
a new receipt version, the older release cannot verify those receipts and will refuse to load a
chain that contains them. Check the changelog for "receipt version". If one was introduced, do not
downgrade in place: either stay on the newer release, or start a new chain on the older one (new
`receiptChainId`, new log path) and retain the newer chain and its public key as evidence. A
downgrade across a schema version is a migration, not a rollback, and needs the migration note from
the changelog.

## Safe bypass

The gateway fails closed by design: if it cannot inspect, sign, and record, it refuses. A bypass is
the decision to run a workload without that boundary for a bounded time, and the runbook exists so
the decision is explicit and leaves a record. In order of preference:

1. **Do nothing.** Clients receive 503 or 502 with a problem body. For most workloads a short outage
   is acceptable and preserves the guarantee.
2. **Degrade a detector, not the boundary.** If the outage is a sidecar (NER or semantic detector),
   set its `onDetectorFailure` to `degrade`: deterministic detection, policy, and receipts continue;
   only that detector's classes are uncovered, and every receipt records `detectorDegraded: true` so
   the gap is visible afterwards.
3. **Route to the local provider only.** If the outage is the remote provider, a per-workload
   `allowedProviders` naming only the local provider keeps the workload inside the boundary.
4. **Bypass at the ingress.** If the gateway itself is down and the business decision is to
   continue, route the workload from the ingress directly to the provider. Before doing so record:
   the incident, the workloads routed around, the start time, the last receipt sequence from the
   checkpoint, and who approved it. While the bypass is active there are no receipts and no
   inspection; the provider receives raw content. When the bypass ends, record the end time. The
   receipt gap between the two sequence numbers is the audit statement.

Never implement a bypass by setting every class to `allow_raw`, by removing kinds from policy, or by
pointing `EGRYSA_RECEIPT_ED25519_PRIVATE_KEY` at a throwaway key. Each of those produces receipts
that look like evidence of inspection that did not happen.

## Backup and restore of evidence

What to back up:

- The active receipt log at `receiptLogPath` and every rotated segment beside it
  (`<path>.<sequence>`). Rotated segments are closed and never rewritten; copy them any time. The
  active log is appended and fsynced; copy it after a checkpoint and verify the copy.
- The public verification key from `/v1/receipts/public-key`, stored with the logs. A log without
  its public key is not evidence.
- The signing and fingerprint keys, in the secret manager, never beside the logs.
- Signed checkpoints retained outside the gateway (the evidence export sink, or a periodic fetch of
  `/v1/receipts/checkpoint`). These are what a restored log is reconciled against.
- The configuration file and its SHA-256 from each change ticket.

Evidence export is the continuous form of this backup: every receipt and every checkpoint reaches
the sink as it is committed. A deployment with export configured backs up the log for completeness
and reconciles against the sink.

**Restore**, and the rehearsal that must be run before it is needed:

1. Place the log and its rotated segments at the configured path on the replacement volume.
2. Verify offline before starting anything:
   `deno task receipts:verify <path> <public key> <chainId>`, and the same for each segment. The
   tool reports the head sequence and hash, or the first bad line and the last good sequence.
3. Compare the reported head with the newest externally retained checkpoint. If the log's head is
   behind the checkpoint, receipts were lost between the backup and the failure; the gap is the
   audit statement, and the missing receipts may exist in the export sink.
4. Start the gateway. It loads the chain, checks every line again, and appends; the first new
   receipt's `previousReceiptHash` is the restored head. Fetch `/v1/receipts/checkpoint` and record
   it.

If the log is missing or empty while rotated segments exist, the gateway refuses to start rather
than silently begin a second sequence space. Restore the newest segment as the active log, or
explicitly start a new chain with a new `receiptChainId` and record why.

Rehearse quarterly: back up a running gateway, restore to a fresh volume, run the verifier, start,
and confirm continuity. `tests/receipt_log_test.ts` runs the verifier against a frozen chain and
against tampered, truncated, and reordered copies on every test run, so the tool is exercised
continuously; the rehearsal exercises the people and the storage.

## Outages the gateway is designed to survive

| Symptom                                                                              | Cause                                          | Behaviour                                                                                                              | Action                                                                                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 503 `receipt_unavailable`, log event `receipt_signing_failed`                        | Remote signer unreachable or wrong key         | Requests refused before egress; nothing forwarded; the store is intact                                                 | Restore the signer. Requests resume without restart. Check the signer's own log for the refused calls                     |
| 503 or 500 on every request after a disk error                                       | Receipt log write or fsync failed              | The store faults and refuses every request until restart, so no receipt can chain onto a write that may not be on disk | Fix the volume, verify the log with `receipts:verify`, restart. If the tail is damaged, restore per the runbook above     |
| Receipts flowing, `egrysa_export_dropped_total` rising                               | Evidence export sink down                      | Records queue in memory to `queueCapacity`, then drop oldest with a count; requests unaffected                         | Restore the sink; reconcile the gap against the on-disk log, which is the primary record                                  |
| 403 `policy_denied` "required local detector unavailable", event `detector_degraded` | Sidecar down with `onDetectorFailure: deny`    | Requests needing that detector are refused                                                                             | Restore the sidecar, or switch to `degrade` under the bypass runbook and accept the coverage gap the receipts will record |
| Receipts carry `detectorDegraded: true`                                              | Sidecar down with `onDetectorFailure: degrade` | Deterministic detection continues; that detector's classes are uncovered                                               | Restore the sidecar; the receipts identify exactly which requests ran uncovered                                           |
| 429 with `Retry-After`                                                               | Workload over its rate limit                   | Refused before inspection; content-free event `rate_limited`                                                           | Expected. Raise the limit per workload if legitimate                                                                      |
| 504 `provider_timeout` on streams that used to complete                              | Stream longer than `requestTimeoutMs`          | The stream is aborted once the deadline, armed when reading starts, passes                                             | Raise `requestTimeoutMs`; the deadline no longer counts the gateway's own receipt commit                                  |
| 502 `recomposition_failed` or an error frame in a stream                             | Provider altered a surrogate token             | The response is withheld rather than returned with damaged or leaked structure                                         | Check the provider and model; some models rewrite tokens. Consider `policy.surrogates.style: synthetic` for that workload |
| Gateway will not start: "interrupted rotation"                                       | Active log missing while segments exist        | Refuses to create a duplicate sequence space                                                                           | Restore runbook, step 4                                                                                                   |
