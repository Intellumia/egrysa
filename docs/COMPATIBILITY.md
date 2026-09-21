# Compatibility policy

This document freezes the surfaces a deployment depends on and says how they may change. It is the
boundary between alpha and beta: while the surfaces below could change without notice, every
evaluation result was tied to a moving target. From the freeze commit onward they change only as
this policy allows, and `tests/compatibility_test.ts` holds the code to it.

## What is frozen

| Surface                    | Definition                                                                                                                                                                                                                           | Version                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| HTTP API                   | The paths, methods, request field allowlists, response headers (`x-egrysa-receipt`, `x-egrysa-decision`, `x-egrysa-downgraded`, `x-egrysa-model`), and problem shape in `api/openapi.yaml`, including the Anthropic Messages ingress | `info.version` tracks the tag  |
| Receipt schema             | The `Receipt` component in `api/openapi.yaml`; the fields that enter the hash and the signature; the checkpoint document; the signing key identifier derivation                                                                      | Receipt 5, checkpoint 1        |
| Configuration schema       | `api/config.schema.json`; unknown fields are rejected at every level; every data class carries exactly one policy action                                                                                                             | `schemaVersion` 1              |
| Evidence export records    | JSON lines with a `record` field of `receipt`, `checkpoint`, or `event` and the signed document as the remaining fields; the OTLP mapping in `src/export.ts`                                                                         | Carried by the receipt version |
| Detector contract          | `POST /v1/detect` with `contractVersion`, as `src/detectors.ts` and `src/ner.ts` describe, used by the semantic and NER sidecars                                                                                                     | 1                              |
| Signer contract            | `POST` with `contractVersion`, `algorithm`, `keyId`, `message`, answered by `contractVersion`, `keyId`, `signature`, as `src/signer.ts` describes                                                                                    | 1                              |
| Environment variable names | `EGRYSA_*` names the gateway reads, listed in `deno.json` and the `Containerfile`                                                                                                                                                    | Frozen by name                 |

Not frozen: `deno task` names and flags, the module-level TypeScript API under `src/`, the tools
under `tools/`, metric names, log event names, the evaluation corpora, and the container image's
internal layout. These may change in any release; the changelog records it when they do.

## Rules

1. **Within a schema version, changes are additive.** A new optional configuration field, a new
   finding kind, a new provider kind, a new response header, a new receipt field carried by a new
   receipt version number. Nothing is renamed, removed, retyped, or given a different meaning.
2. **Every published receipt version verifies forever.** `verifyReceipt` and the receipt store
   accept versions 2 through 5 today and will accept every version ever emitted by a tagged release.
   A chain written by alpha.5 is checked into `tests/fixtures/receipts-alpha5/` and a test loads,
   verifies, and appends to it on every run. A new receipt version is introduced only to carry a new
   field; a receipt that verified under one release verifies under all later ones.
3. **A configuration valid for one release is valid for the next.** New fields are optional with
   documented defaults. A field is retired in two steps: first it is marked deprecated in the schema
   description and the changelog and still accepted, then at the next minor version it is rejected.
   A field is never silently ignored, which is why unknown fields are refused.
4. **Breaking changes happen only at a minor version** (`0.1.x` to `0.2.0`), are announced in the
   changelog one release ahead with a migration note, and increment `schemaVersion`. Patch releases
   and prerelease increments (`alpha.N`, `beta.N`) never break any frozen surface.
5. **Fail closed stays fail closed.** No release turns a deny into a transform, an allow, or a
   silent drop for any existing configuration. Loosening a default is a breaking change.

## Support window

- The latest release receives fixes. Security fixes increment the prerelease or patch number and
  state their impact in the changelog.
- When a new minor version is released, the previous minor receives security fixes for 90 days.
- Receipts from any tagged release remain verifiable in every later release, without a window.
- Support is community best-effort under [SUPPORT.md](../SUPPORT.md); this window describes what the
  project will publish, not a response-time commitment.

## Versioning

Tags follow `v0.1.0-alpha.N` until this policy is adopted and `v0.1.0-beta.N` after. The version in
`api/openapi.yaml` equals the tag without its `v`, checked as a release precondition. The
configuration schema carries its own `schemaVersion`, the receipt its own `version`, and the sidecar
and signer contracts their own `contractVersion`, so each surface can be reasoned about on its own
and none is implied by the release number.

## Enforcement

`tests/compatibility_test.ts` runs with the suite and fails when:

- a shipped example configuration, the Kubernetes ConfigMap, or the test fixture does not conform to
  `api/config.schema.json`;
- the finding-kind, provider-kind, or sensitivity enumerations in the schema drift from the code;
- an unknown field at any level the schema closes is accepted by the validator;
- a path documented in `api/openapi.yaml` is not served, or a receipt version the API document lists
  has no frozen fixture;
- the alpha.5 receipt chain no longer loads, verifies, or accepts a new receipt.

Changing any of these is possible, but it cannot be accidental: the test names the rule that was
broken and this document says what the change must be accompanied by.
