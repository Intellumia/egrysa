# Brief: authoring an independent detection corpus

This is a self-contained brief. You do not need to understand Egrysa's code, and you should not read
it. Everything required is below.

## Why you are being asked

Egrysa claims to detect sensitive values in text before that text is sent to an AI provider. That
claim is currently measured against corpora written by the same people who wrote the detector. A
test author who has read the implementation writes cases against the failure modes they can see, and
so inherits the blind spots of the code. The result is a number nobody outside the project should
fully trust, and the project says so.

Your corpus is valuable **because you did not write the detector**. That is the entire point, and it
is why the single most important rule is the first one.

## Rules

1. **Do not read the source code.** Not `src/`, not the tests, not the existing corpora's design
   notes. If you have already read them, say so before starting; the corpus is still useful but its
   provenance must record it.
2. **Do not run the tool while authoring.** Write the whole corpus first.
3. **Do not revise a case after seeing a result.** A corpus tuned against its own results measures
   nothing. If a case turns out to be wrong in a way unrelated to detection, for example a malformed
   IBAN checksum, fix it and record that you did.
4. **Use fabricated values only.** Never real personal data, never a real credential, never a real
   customer document. If you would not publish it, do not write it.

## What to write

Between 100 and 150 documents. Each is a piece of text a real employee might paste into an AI
assistant during ordinary work.

Write from **situations**, not from a checklist of data types. Pick a role and a task, then write
what that person would actually paste. The sensitive values should land in the document because the
situation put them there, not because you set out to include one.

Useful shapes: a support ticket, an email thread, an incident postmortem, meeting notes, a pasted
spreadsheet or query result, a log excerpt, a configuration file, a referral or case letter, a
recruiting message, a maintenance record, a contract extract, a request for a summary or a
translation.

Cover more than one sector if you can: financial services, healthcare, technology, retail, public
sector, human resources, legal, manufacturing.

### At least 40% must contain nothing sensitive

This is the requirement people skip, and the one that produces the most valuable result. Most real
traffic contains nothing sensitive at all. A corpus of only positive cases cannot answer the
question an operator actually asks, which is whether ordinary work gets blocked.

Deliberately include text that _resembles_ sensitive data without being it: order and invoice
numbers, part numbers, version strings, commit hashes, ticket references, measurement readings, long
random-looking build identifiers.

### Vary the formatting the way reality does

Real documents are inconsistent. International phone numbers with country codes and spaces. Card
numbers read out in groups. Addresses written in prose. Values inside quotes, brackets, URLs, or
table cells. Text in languages other than English. Do not tidy them up.

## What Egrysa claims to detect

Use this list, and nothing more, to decide what to label. It is the project's public claim, taken
from its README.

| Category            | Meaning                                           |
| ------------------- | ------------------------------------------------- |
| `email`             | Email addresses                                   |
| `phone`             | Telephone numbers                                 |
| `ipv4`              | IPv4 addresses                                    |
| `iban`              | International bank account numbers                |
| `credit_card`       | Payment card numbers                              |
| `ssn`               | US social security numbers in the hyphenated form |
| `private_key`       | Private key material                              |
| `api_secret`        | API keys, tokens, and credentials                 |
| `confidential_term` | Operator-configured confidential terms            |

The evaluation configuration also defines two confidential terms, `Project Nightingale` and
`Example Acquisition Target`. Use them if a scenario naturally calls for an internal codename.

Three further categories exist but are **not** detected in the default configuration: person names,
physical addresses, and IPv6 addresses. Include them where a document would naturally contain them
and label them `person_name`, `physical_address`, or `ipv6`. They are expected to be missed, and
cases covering them confirm the documented exclusions rather than finding new gaps.

## Format

One JSON object per line, in a file named `evals/independent.jsonl`.

```text
{"id":"fin-001","sector":"financial-services","documentType":"support-ticket","scenario":"one-line description","prompt":"the full document text","expectedKinds":["email","credit_card"],"expectedDecision":"deny"}
```

It must be one object on one physical line. The loader splits on newlines, so a pretty-printed
object spanning several lines will not parse.

`expectedKinds` lists every category genuinely present. Use `[]` when nothing is.

`expectedDecision` follows from the kinds present:

| If the document contains                                                                      | `expectedDecision` |
| --------------------------------------------------------------------------------------------- | ------------------ |
| `credit_card`, `private_key`, `api_secret`, or `ssn`                                          | `deny`             |
| `confidential_term` and none of the above                                                     | `local_only`       |
| `email`, `phone`, `ipv4`, `iban`, `person_name`, or `physical_address`, and none of the above | `transform`        |
| nothing sensitive                                                                             | `allow_raw`        |

`evals/scenarios.jsonl` in this repository is a worked example of the format. Reading it is safe: it
contains documents and labels, not implementation. Reading it will bias your scenarios toward the
ones already covered, so prefer to glance at one line for shape and then close it.

## Running it

Once the corpus is complete and you have stopped editing:

```sh
deno run --no-prompt --allow-read=config,evals \
  tools/adversarial_report.ts --corpus=evals/independent.jsonl
```

The report gives per-category precision and recall, a per-sector breakdown, false positives against
your clean documents, and every miss by name.

Run it once. Read the result. Do not go back and adjust cases.

## What to hand back

The corpus file, and a short provenance note answering:

1. Who authored it, and their relationship to the project.
2. Whether the author had previously read the implementation.
3. What sources were used for value formats, for example a published specification, a vendor's
   documentation, or personal knowledge.
4. The date of authoring, and the date of the first run.
5. Whether any case was revised after a run, and which.

That note is what makes the resulting number credible. Without it the corpus is just another file,
and a reviewer is right to discount it.

## If you find something

If a document that plainly contains a credential is not detected, that is a finding and it is the
outcome this exercise exists to produce. Do not soften it and do not adjust the case to make it
pass. Write it down.
