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

| Measure                                  | Result |
| ---------------------------------------- | ------ |
| Cases fully detected                     | 55/98  |
| Undisclosed misses                       | 35     |
| Misses covered by a documented exclusion | 8      |
| False positives on negative controls     | 0/15   |
| Policy decision accuracy                 | 63.3%  |

Per kind, lowest recall first:

| Kind                | Recall | Precision |
| ------------------- | ------ | --------- |
| `person_name`       | 0%     | —         |
| `physical_address`  | 0%     | —         |
| `ssn`               | 25%    | 100%      |
| `api_secret`        | 34.6%  | 100%      |
| `email`             | 43.8%  | 70%       |
| `private_key`       | 50%    | 100%      |
| `ipv4`              | 66.7%  | 66.7%     |
| `iban`              | 75%    | 100%      |
| `credit_card`       | 80%    | 100%      |
| `phone`             | 100%   | 85.7%     |
| `confidential_term` | 100%   | 100%      |

By category:

| Category             | Detected |
| -------------------- | -------- |
| Payment card formats | 11/11    |
| Realistic contexts   | 12/12    |
| Negative controls    | 15/15    |
| Internationalization | 8/10     |
| Credential formats   | 8/25     |
| Obfuscation          | 1/10     |
| Encoding             | 0/7      |

## What this means in practice

**Zero false positives across 15 negative controls.** Git SHAs, image digests, UUIDs, ISBNs, order
numbers, semantic versions, and digit runs failing Luhn are all left alone. Egrysa is unlikely to
block legitimate work through spurious matches.

**Well-formed values in realistic contexts are caught.** Stack traces, log lines, CSV rows, SQL
inserts, Kubernetes manifests, and support tickets all classify correctly.

**Credential coverage is the largest gap.** Only 8 of 25 credential formats are detected. The
detector recognizes OpenAI-style `sk-` keys, AWS access key identifiers, and classic GitHub tokens.
It does not currently recognize GitHub fine-grained tokens, Google, Slack, GitLab, Stripe, SendGrid,
npm, Azure connection strings, JSON Web Tokens, or passwords embedded in database and HTTP URLs.

This gap has independent corroboration. Publishing this corpus was initially blocked by GitHub push
protection, which identified the synthetic Slack, Stripe, and Twilio values as credentials. In other
words, a general-purpose scanner already flags several formats that Egrysa's own detector passes
through. The corpus values were then made structurally invalid so they no longer trigger a scanner,
while retaining the vendor prefixes the detector needs to match. They are non-functional by
construction and safe to publish.

**Encoded values are not decoded.** Detection operates on the literal text. URL-encoded, base64,
JSON-escaped, and HTML-entity representations pass through unmatched. This matters because pasted
logs and request captures routinely contain encoded values.

**Obfuscated values are not normalized.** `alex [at] example [dot] com`, unicode hyphens in a card
number, and space- or period-separated SSNs are not matched. Deliberate evasion by a motivated
insider is not in scope for a deterministic layer.

**A credential inside a URL can be downgraded, not just missed.** In `postgres://user:password@host`
and similar forms, the authority segment matches the email pattern. The value is surrogated, so it
does not reach the provider in cleartext, but it is recorded as `email` and routed to `transform`
rather than the `deny` that `api_secret` would have produced. The data is protected; the decision
and the receipt understate the severity.

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

1. Credential leakage is possible for formats outside the recognized set. Pair Egrysa with a
   dedicated secret scanner on the same egress path where credential exposure is the primary risk.
2. Encoded and obfuscated content is not inspected. Where clients paste raw captures, decode before
   the gateway or accept the gap explicitly.
3. Policy severity can understate the finding when a credential is embedded in a URL.
4. Absence of a finding is not evidence of absence of sensitive data, and a receipt does not assert
   that a prompt was clean. See the [evaluation record](EVALUATION.md) for what receipts do and do
   not prove.
