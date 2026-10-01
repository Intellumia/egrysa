# Working on Egrysa

This file is read by Claude Code at the start of every session, including cloud sessions started
from GitHub. It holds how work is done here. What the product is and the rules it must never break
are in [CODEX.md](CODEX.md); read it first. This repository is public, so nothing client-specific,
internal, or secret belongs in it, including in this file.

## Toolchain

- Deno 2.9.4, pinned everywhere (CI, container, docs). Zero third-party runtime packages.
- In a cloud session, `.claude/settings.json` installs Deno on start if it is missing. If `deno` is
  still not on `PATH`, run `curl -fsSL https://deno.land/install.sh | sh -s v2.9.4` and use
  `~/.deno/bin/deno`.
- Everything else a task needs is a `deno task`. The ones that matter:

| Task                         | What it does                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `deno task check`            | Format check, lint, type check, full test suite. Run before every PR |
| `deno task eval`             | Synthetic regression corpus                                          |
| `deno task eval:adversarial` | Adversarial detection corpus, per-kind precision and recall          |
| `deno task eval:scenarios`   | Realistic traffic corpus                                             |
| `deno task acceptance`       | Black-box acceptance suite                                           |
| `deno task bench:e2e`        | Gateway latency and throughput against an in-process provider        |
| `deno task eval:quality`     | Task quality with and without the gateway; needs a real model        |
| `deno task config:check`     | Validate a configuration file and print its digest                   |
| `deno task receipts:verify`  | Verify a receipt log offline against a public key                    |

`deno fmt` rewrites `\uXXXX` escapes inside regular expression literals; build such patterns from
strings. Run `deno fmt` before committing, or `deno task check` fails on formatting.

## How changes land

- Never commit to `main`. Branch as `agent/<topic>`, open a pull request, and squash-merge it once
  the four required checks pass: Test and audit, Security baseline, CodeQL, Dependency review.
- `main` requires signed commits. A squash merge through GitHub is signed by GitHub, so branch
  commits made in a cloud session do not need a local signing key.
- `main` requires branches to be up to date. After another pull request merges, update the branch
  (or comment `@dependabot rebase` on a Dependabot pull request) and wait for the checks again.
- Never delete a branch until its pull request's state is literally `MERGED`. Deleting the head
  branch of an open pull request closes it. A polling loop that waits for checks must stop on
  `BLOCKED` as well as `CLEAN`, `DIRTY`, and `UNSTABLE`, and must not delete anything when it stops
  for any reason other than a confirmed merge.
- Wait until the required checks have registered before watching them; a pull request's rollup is
  briefly empty after a push.
- A failing test that passes on a re-run is a bug to root-cause, not a flake to retry. Two such bugs
  (a stream deadline that ran through the receipt fsync, and a test that measured the runner's disk)
  were both found that way.

## Frozen surfaces

[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) freezes the HTTP API, the receipt schema, the
configuration schema (`api/config.schema.json`), the evidence export records, and the detector and
signer contracts. `tests/compatibility_test.ts` enforces it. A change to any of them is additive
within a version, or it waits for the next minor version and is announced a release ahead.

## Releases

[docs/RELEASE.md](docs/RELEASE.md) is the procedure; follow it in order. Releases are cut from
GitHub with the **Cut release** workflow: no local machine or signing key is involved, and the
release workflow verifies, publishes, re-verifies, and opens the Homebrew and npm pull request
itself. The version in `src/version.ts` and `info.version` in `api/openapi.yaml` must equal the tag
without its `v`. The release workflow builds and signs everything; nothing is published until
`tools/verify-release.sh` has passed against the retained evidence, and it is run again against the
published release. After publication, `deno task package:release` generates the Homebrew formula and
the npm manifest from the verified evidence.

## Writing

Documentation states what is measured and what is not. Use the non-claims in CODEX.md exactly: never
say compliant, certified, anonymised, de-identified, or zero retention. A limitation that has been
measured is published with the number. Plain sentences, no marketing.

## Secrets

Never commit a key, token, or `.env` file. Locally they live in `.env.local`, which is ignored. In a
cloud session or a workflow they come from the environment's secrets. Provider credentials for the
live checks and the task-quality workflow are GitHub Actions secrets; endpoint details that are not
secret are repository variables. Never print a secret's value, and never paste one into a pull
request, an issue, or a log.
