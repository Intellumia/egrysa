# Detection coverage

This page states what the deterministic detector floor catches and what it misses, measured rather
than asserted. It is written for security, privacy, and governance reviewers who need to decide what
compensating controls to place around Egrysa.

Reproduce every number here with:

```sh
deno task eval:adversarial
```

Suite: `egrysa-adversarial-v1`, 102 cases, semantic detector off, shipped example configuration. Add
`--sensitivity=strict` or `--sensitivity=review` to measure a different mode.

## The short version

Egrysa's deterministic detection is **precise but narrow**. When it fires, it is almost always
right. There are substantial categories of sensitive data it does not fire on at all.

If your control objective is "no confidential value ever reaches a provider," this release does not
meet it and is not claimed to. If your objective is "the common, well-formed cases are caught, with
signed evidence of every decision," that is supported today.

## Measured results

| Measure                                  | `balanced` (default) | `strict` |
| ---------------------------------------- | -------------------- | -------- |
| Cases fully detected                     | 77/102               | 79/102   |
| Undisclosed misses                       | 17                   | 15       |
| Misses covered by a documented exclusion | 8                    | 8        |
| False positives on negative controls     | **0/19**             | **4/19** |
| `ssn` recall                             | 25%                  | 75%      |
| `ssn` precision                          | 100%                 | 42.9%    |

`review` measures identically to `balanced` here. It changes what _happens_ to a finding, not
whether the finding is made, and this report measures detection rather than routing.

**That table is the whole argument for the switch.** Strict finds two more cases and pays four false
positives for them, dropping `ssn` precision from 100% to 42.9%. Neither column is the right answer
for every deployment, which is why it is configuration rather than a fixed behavior.

For reference, the floor as first measured, before any of this work and on the original 98-case
corpus, was 55 detected with 35 undisclosed misses.

Per kind, lowest recall first:

| Kind                | Recall | Precision |
| ------------------- | ------ | --------- |
| `person_name`       | 0%     | —         |
| `physical_address`  | 0%     | —         |
| `ssn`               | 25%    | 100%      |
| `email`             | 43.8%  | 100%      |
| `ipv4`              | 66.7%  | 66.7%     |
| `credit_card`       | 80%    | 100%      |
| `api_secret`        | 92.3%  | 100%      |
| `private_key`       | 100%   | 100%      |
| `phone`             | 100%   | 85.7%     |
| `iban`              | 100%   | 100%      |
| `confidential_term` | 100%   | 100%      |

By category:

| Category             | `balanced` | `strict` |
| -------------------- | ---------- | -------- |
| Credential formats   | 25/25      | 25/25    |
| Payment card formats | 11/11      | 11/11    |
| Realistic contexts   | 12/12      | 12/12    |
| Negative controls    | 19/19      | 15/19    |
| Internationalization | 9/10       | 9/10     |
| Obfuscation          | 1/10       | 3/10     |
| Encoding             | 0/7        | 0/7      |

## What this means in practice

**Zero false positives across 19 negative controls, under the default.** Git SHAs, image digests,
UUIDs, ISBNs, order numbers, semantic versions, and digit runs failing Luhn are all left alone.
Egrysa is unlikely to block legitimate work through spurious matches.

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

**Active in every mode:** a credential identified by its assignment rather than its own format, such
as `aws_secret_access_key=…`, `password: …`, or `client_secret=…`. This closed the last
credential-format gap, and it is exactly the pattern that misfires on benign configuration, which is
why its handling is a policy choice rather than a fixed behavior.

**Active only under `strict`:** SSNs written with space or period separators, such as `123 45 6789`.
Ordinary ticket, invoice, part, and sensor numbers take the same shape. Enabling this by default
would reroute routine traffic and would contradict the documented decision that deny-class SSN
detection requires the canonical hyphenated form. Under `strict` it lifts `ssn` recall from 25% to
75% and costs four false positives out of nineteen negative controls, taking `ssn` precision to
42.9%. An operator choosing `strict` is choosing exactly that trade.

A strict-only pattern changes what the detector emits, so the pattern detector reports a distinct
version, `1.2.0+strict`, in the receipt. A receipt therefore records which ruleset produced its
findings without needing the configuration that ran.

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

## Realistic-traffic corpus

The adversarial corpus measures the edges. It says nothing about how the detector behaves on the
traffic an enterprise actually sends, because it is almost entirely positive cases and over-samples
shapes chosen to be hard.

A second corpus measures that instead:

```sh
deno task eval:scenarios
```

Suite `egrysa-scenarios-v1`, 67 synthetic business documents across financial services, healthcare,
technology, retail, human resources, legal, public sector, manufacturing, and cross-industry work.
Each case is a document an employee would plausibly paste into an assistant: a support ticket, an
incident postmortem, a pasted CSV or SQL result, a referral letter, a recruiting email, a
maintenance log, a runbook. **Thirty-two of the sixty-seven contain nothing sensitive**, because
most real traffic does not, and a corpus without clean documents cannot measure whether ordinary
work gets blocked.

| Measure                             | Result   |
| ----------------------------------- | -------- |
| Cases fully detected                | 64/67    |
| Undisclosed misses                  | **0**    |
| Misses under a documented exclusion | 3        |
| False positives                     | **0/32** |

Per kind, every deterministic class reached 100% recall **and** 100% precision: `email` 13/13,
`api_secret` 6/6, `phone` 6/6, `ssn` 4/4, `ipv4` 4/4, `credit_card` 2/2, `iban` 2/2,
`confidential_term` 2/2, `private_key` 1/1. The only three misses are the documented exclusions:
person names, physical addresses, and IPv6.

Read the two corpora together. On realistic traffic the floor is strong. Under deliberate pressure
it is not, and the difference between 64/67 here and 77/102 there is the honest measure of how much
of the gap is reachable by ordinary use versus by adversarial construction.

### What this corpus found that the adversarial one could not

Every clean document in the corpus is **denied** by the shipped example configuration, with the
reason `raw remote egress is disabled for this provider`. A prompt containing nothing sensitive
takes the `allow_raw` path, which requires a provider marked `local` or `dataPolicy.allowRaw: true`;
the example `openai` provider is neither.

The behaviour is internally consistent, and the documented quickstart avoids it by selecting the
local provider. But the effect is counter-intuitive and worth stating: a prompt containing an email
address is transformed and forwarded, while a prompt containing nothing sensitive is refused. Under
the shipped example configuration the safer request is the more likely one to be blocked.

An adversarial corpus cannot surface this, because it contains almost no clean documents. Operators
pointing Egrysa at a remote provider should decide deliberately whether raw egress of non-sensitive
prompts is approved, and set `dataPolicy.allowRaw` to record that decision.

## Independence

Both corpora were authored by the maintainers alongside the engine they test. That is a real
limitation: a corpus written by the same party that wrote the detector tends to probe the failure
modes that party already imagines. They are published so they can be inspected, disputed, and
extended.

The two were written under different protocols, and the difference matters when weighing the
results:

- The **adversarial corpus** was written with the pattern table open. It is white-box by
  construction and its coverage is bounded by what the author could see.
- The **scenario corpus** was written from business situations rather than from the taxonomy: choose
  a sector and a document type, write what an employee in that role would actually paste, and label
  whatever sensitive values landed there naturally. It was measured once and published as measured,
  with no case revised after seeing a result. That protocol reduces the bias but does not remove it,
  because the same author had prior knowledge of the implementation.

Neither is the independent corpus the 0.1 gate requires. The strongest available substitutes, in
increasing order of value, are: cases generated from external format authorities such as the
relevant RFCs and issuer specifications; cases written by a reviewer who has never opened `src/`;
and a customer's own corpus over their own approved taxonomy, which is what acceptance gate 2 in the
[CISO brief](CISO_BRIEF.md) actually contemplates.

A self-contained brief for authoring one is published at [corpus brief](CORPUS_BRIEF.md). It can be
handed to a reviewer who has never seen this repository, and it is written so that following it does
not require reading the implementation. Contributions of cases that break the detector are
explicitly welcome.

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
