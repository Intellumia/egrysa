# Detection coverage

This page states what the deterministic detector floor catches and what it misses, measured rather
than asserted. It is written for security, privacy, and governance reviewers who need to decide what
compensating controls to place around Egrysa.

Reproduce every number here with:

```sh
deno task eval:adversarial
```

Suite: `egrysa-adversarial-v1`, 98 cases, semantic detector off, shipped example configuration.

## The short version

Egrysa's deterministic detection is **precise but narrow**. When it fires, it is almost always
right. There are substantial categories of sensitive data it does not fire on at all.

If your control objective is "no confidential value ever reaches a provider," this release does not
meet it and is not claimed to. If your objective is "the common, well-formed cases are caught, with
signed evidence of every decision," that is supported today.

## Measured results

| Measure                                  | Before | After |
| ---------------------------------------- | ------ | ----- |
| Cases fully detected                     | 55/98  | 73/98 |
| Undisclosed misses                       | 35     | 17    |
| Misses covered by a documented exclusion | 8      | 8     |
| False positives on negative controls     | 0/15   | 0/15  |
| Policy decision accuracy                 | 63.3%  | 67.3% |

"Before" is the floor as first measured; "after" reflects the credential and envelope coverage added
once the corpus existed.

Per kind, lowest recall first:

| Kind                | Recall | Precision |
| ------------------- | ------ | --------- |
| `person_name`       | 0%     | —         |
| `physical_address`  | 0%     | —         |
| `ssn`               | 25%    | 100%      |
| `email`             | 43.8%  | 100%      |
| `ipv4`              | 66.7%  | 66.7%     |
| `credit_card`       | 80%    | 100%      |
| `api_secret`        | 88.5%  | 100%      |
| `private_key`       | 100%   | 100%      |
| `phone`             | 100%   | 85.7%     |
| `iban`              | 100%   | 100%      |
| `confidential_term` | 100%   | 100%      |

By category:

| Category             | Detected |
| -------------------- | -------- |
| Payment card formats | 11/11    |
| Realistic contexts   | 12/12    |
| Negative controls    | 15/15    |
| Credential formats   | 25/25    |
| Internationalization | 9/10     |
| Obfuscation          | 1/10     |
| Encoding             | 0/7      |

## What this means in practice

**Zero false positives across 15 negative controls.** Git SHAs, image digests, UUIDs, ISBNs, order
numbers, semantic versions, and digit runs failing Luhn are all left alone. Egrysa is unlikely to
block legitimate work through spurious matches.

**Well-formed values in realistic contexts are caught.** Stack traces, log lines, CSV rows, SQL
inserts, Kubernetes manifests, and support tickets all classify correctly.

**Credential coverage is now complete across the corpus, 25 of 25 formats.** The detector recognizes
vendor-namespaced prefixes for OpenAI, Anthropic, AWS access key identifiers, GitHub classic and
fine-grained tokens, GitLab, Google, Slack, Stripe, npm, SendGrid, Azure storage connection strings,
and JSON Web Tokens, plus passwords carried in a URL authority. Each alternative is anchored on a
literal the provider issues, so the broader coverage did not cost precision: `api_secret` remains at
100% with no new false positives.

AWS session tokens carry no stable prefix, so they are reached by a low-precision pattern that keys
on the assignment (`aws_secret_access_key=…`) rather than the value. Because that pattern can
misfire on benign configuration, what happens to its findings is governed by `policy.sensitivity`
below rather than fixed here.

This gap has independent corroboration from two scanners the project already runs. Publishing the
corpus was blocked by GitHub push protection, which identified the synthetic Slack, Stripe, and
Twilio values as credentials. The Trivy secret scanner in the CI security baseline then flagged nine
findings in the same file, including GitHub fine-grained and OAuth tokens and a GitLab token. Both
general-purpose scanners detect formats that Egrysa's own detector passes through.

That result also explains a necessary exception. A credential fixture that a secret scanner ignores
would not be testing anything, so this corpus unavoidably trips secret scanning. The security
baseline therefore carries an allowance scoped to the single path `evals/adversarial.jsonl`, defined
in [`.trivy/secret.yaml`](../.trivy/secret.yaml). Every other file is scanned normally, the fixture
values are structurally non-functional, and GitHub push protection stays enabled repository-wide.

**Encoded values are not decoded.** Detection operates on the literal text. URL-encoded, base64,
JSON-escaped, and HTML-entity representations pass through unmatched. This matters because pasted
logs and request captures routinely contain encoded values.

**Obfuscated values are not normalized.** `alex [at] example [dot] com`, unicode hyphens in a card
number, and space- or period-separated SSNs are not matched. Deliberate evasion by a motivated
insider is not in scope for a deterministic layer.

**Severity downgrade on URL credentials, since corrected.** The corpus surfaced a case where a
password in a URL authority, as in `postgres://user:password@host`, matched the email pattern. The
value was surrogated and so never reached a provider in cleartext, but it was recorded as `email`
and routed to `transform` rather than the `deny` that `api_secret` produces. The data was protected
while the decision and the receipt understated the severity. A dedicated pattern now claims the
whole URL authority, and `email` precision rose from 70% to 100% as a result. This is recorded
because it is the class of defect this corpus exists to find: not a missed value, but a correctly
detected value carrying the wrong severity.

## Choosing the tradeoff: `policy.sensitivity`

Coverage and false positives pull against each other, and the right balance is a property of the
deployment rather than of the engine. Patterns therefore carry a precision tier, and what happens to
a low-precision finding in a blocked data class is a configuration choice.

A **high**-precision finding in a blocked class always denies, in every mode. Only low-precision
findings are affected.

| `policy.sensitivity` | Low-precision finding in a blocked class | Suits                                        |
| -------------------- | ---------------------------------------- | -------------------------------------------- |
| `strict`             | `deny`                                   | Regulated egress: a miss costs more than a   |
|                      |                                          | blocked request                              |
| `balanced` (default) | Routed to local inference                | General enterprise use                       |
| `review`             | Held for a person to decide              | Anywhere a regex should not be the last word |

Omitting the field behaves exactly as `balanced`, which is what earlier releases did, so existing
configurations are unaffected.

### How `review` works

The request is held before anything leaves the boundary and answered with `409` and a receipt
identifier:

```json
{
  "type": "urn:egrysa:error:review_required",
  "title": "review_required",
  "status": 409,
  "detail": "A low-precision finding in a blocked data class needs a human decision. ...",
  "receiptId": "b7c1…"
}
```

The response names the receipt, never the matched value. To proceed, retry the request with that
identifier:

```sh
-H "x-egrysa-acknowledge: b7c1…"
```

An acknowledgement is accepted only if this gateway issued it, and only once, so it cannot be forged
by sending an arbitrary header or replayed across requests. The hold and the acknowledged retry each
produce their own receipt, and the pair is the evidence that a person made the call rather than a
pattern.

Holds are tracked in memory and bounded. A restart clears them, and the caller simply receives a
fresh hold on the next attempt.

### Which findings are low precision

Currently one: a credential identified by its assignment rather than its own format, such as
`aws_secret_access_key=…`, `password: …`, or `client_secret=…`. This is what closed the last
credential-format gap, and it is exactly the pattern that would misfire on benign configuration,
which is why its handling is a policy choice rather than a fixed behavior.

Contiguous nine-digit SSNs are deliberately **not** in this tier. Detecting them was tried and
reverted: `balanced` would have rerouted ordinary ticket and order numbers to local inference,
contradicting a documented decision. Whether to reconsider that under `strict` is an open question,
not an oversight.

## Documented exclusions behaving as documented

These are recorded in the README and are not defects:

- IPv6 addresses in any form, including IPv4-mapped and bracketed URL authority forms.
- Contiguous nine-digit values as SSNs. The canonical hyphenated form is required, deliberately, to
  avoid blocking ordinary identifiers.
- Person names and physical addresses, which require the off-by-default semantic detector.

## How to read these numbers

The corpus is adversarial by construction. It over-samples hard cases and deliberately includes
formats the engine was never built to handle, so these figures are a **lower bound under pressure**,
not an expected field rate. The regression suite over ordinary well-formed inputs (`deno task eval`)
passes at 100%.

Both numbers are true and neither alone is honest. A reviewer should read the regression suite as
"does it work as designed" and this suite as "where are the edges."

## Independence

This corpus was authored by the maintainers alongside the engine it tests. That is a real
limitation: a corpus written by the same party that wrote the detector will tend to probe the
failure modes that party already imagines. It is published so it can be inspected, disputed, and
extended.

An independent adversarial corpus remains an open requirement before the 0.1 alpha gate in the
[roadmap](../ROADMAP.md), and contributions of cases that break the detector are explicitly welcome.

## Compensating controls to consider

Given the above, an evaluator deploying Egrysa should assume:

1. Credential leakage remains possible for formats outside the recognized set, including AWS session
   tokens and any provider that issues unprefixed tokens. Pair Egrysa with a dedicated secret
   scanner on the same egress path where credential exposure is the primary risk.
2. Encoded and obfuscated content is not inspected. Where clients paste raw captures, decode before
   the gateway or accept the gap explicitly. This is the largest remaining gap: 0 of 7 encoding
   cases and 1 of 10 obfuscation cases are detected.
3. Absence of a finding is not evidence of absence of sensitive data, and a receipt does not assert
   that a prompt was clean. See the [evaluation record](EVALUATION.md) for what receipts do and do
   not prove.
