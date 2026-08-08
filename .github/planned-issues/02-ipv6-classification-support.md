The current deterministic detection layer identifies emails, phone numbers, and IPv4 addresses.
However, IPv6 address formats are explicitly excluded from this release. To prevent potential
corporate infrastructure telemetry leaks, we need to add robust, fast IPv6 classification patterns
to the fail-closed floor.

## Requirements

- Implement high-performance, deterministic classification rules for standard and compressed IPv6
  formats.
- Integrate the rules into the core classification engine without increasing baseline regex
  backtracking overhead.
- Add comprehensive test coverage to `tests/` verifying correct matching and surrogate injection for
  complex IPv6 strings.

## Entry points

- [`src/classifier.ts`](https://github.com/Intellumia/egrysa/blob/main/src/classifier.ts) — the
  `patterns` table holds the existing `{ kind: "ipv4", regex, validate: validateIpv4 }` entry. An
  `ipv6` entry belongs alongside it, with a `validateIpv6` modeled on the existing `validateIpv4`
  helper lower in the same file.
- [`src/types.ts`](https://github.com/Intellumia/egrysa/blob/main/src/types.ts) — `"ipv4"` is a
  member of the finding-kind union; `"ipv6"` needs adding there first.
- [`src/classifier.ts`](https://github.com/Intellumia/egrysa/blob/main/src/classifier.ts) —
  `removeOverlaps` matters here: IPv4-mapped IPv6 forms such as `::ffff:192.0.2.1` will match both
  patterns, so overlap resolution needs a deliberate answer rather than an incidental one.
- [`tests/classifier_test.ts`](https://github.com/Intellumia/egrysa/blob/main/tests/classifier_test.ts)
  and
  [`tests/detectors_test.ts`](https://github.com/Intellumia/egrysa/blob/main/tests/detectors_test.ts)
  — existing per-kind coverage to extend.

Validation is intentionally split from matching in this file: keep the regex permissive and cheap,
and put correctness in the validator. That is what holds backtracking cost flat.
