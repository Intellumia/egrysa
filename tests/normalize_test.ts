import { classify } from "../src/classifier.ts";
import { textVariants } from "../src/normalize.ts";
import { recompose, transform } from "../src/surrogate.ts";
import type { FindingKind } from "../src/types.ts";
import { testConfig } from "./fixtures.ts";

// Each case is an encoded or obfuscated form of a value the literal patterns
// already catch. The finding must be reported against the original bytes.
// Non-ASCII characters are written as escapes so the fixture stays legible.
const cases: Array<[string, string, FindingKind, string]> = [
  [
    "percent-encoded email",
    "GET /users?mail=alex%40example.com&ref=1",
    "email",
    "alex%40example.com",
  ],
  [
    "JSON-escaped email",
    'Payload was {"contact":"alex\\u0040example.com"}',
    "email",
    "alex\\u0040example.com",
  ],
  [
    "base64 email",
    "Header decoded to YWxleEBleGFtcGxlLmNvbQ== which failed.",
    "email",
    "YWxleEBleGFtcGxlLmNvbQ==",
  ],
  [
    "base64 API key",
    "Blob c2stcHJvai1hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng== failed.",
    "api_secret",
    "c2stcHJvai1hYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejEyMzQ1Ng==",
  ],
  [
    "HTML entity email",
    "Rendered as alex&#64;example.com in the template.",
    "email",
    "alex&#64;example.com",
  ],
  ["percent-encoded IPv4", "Origin 192%2E0%2E2%2E44 recorded.", "ipv4", "192%2E0%2E2%2E44"],
  [
    "card split by tags",
    "DOM had 4111<span>1111</span>1111<span>1111</span> in view.",
    "credit_card",
    // The trailing closing tag is not part of the value.
    "4111<span>1111</span>1111<span>1111",
  ],
  [
    "bracketed at and dot",
    "Reach alex [at] example [dot] com today.",
    "email",
    "alex [at] example [dot] com",
  ],
  ["spaced separators", "Write to alex @ example . com about it.", "email", "alex @ example . com"],
  ["parenthesised at", "Contact alex(at)example.com now.", "email", "alex(at)example.com"],
  [
    "unicode hyphens in card",
    "Card 4111‑1111‑1111‑1111 declined.",
    "credit_card",
    "4111‑1111‑1111‑1111",
  ],
  [
    "key split by line continuation",
    "KEY=sk-proj-abcdefghij \\\n klmnopqrstuvwxyz123456",
    "api_secret",
    "sk-proj-abcdefghij \\\n klmnopqrstuvwxyz123456",
  ],
  [
    "full-width at sign",
    "Escalate to alex＠example.com now.",
    "email",
    "alex＠example.com",
  ],
  [
    "internationalised domain",
    "Contact support@münchen.example failed.",
    "email",
    "support@münchen.example",
  ],
];

Deno.test("encoded and obfuscated values are found against their original bytes", async () => {
  for (const [name, text, kind, expected] of cases) {
    const findings = await classify(text, testConfig());
    const hit = findings.find((finding) => finding.kind === kind);
    if (!hit) throw new Error(`${name}: ${kind} not found in ${JSON.stringify(text)}`);
    if (hit.value !== expected || text.slice(hit.start, hit.end) !== expected) {
      throw new Error(`${name}: span ${JSON.stringify(hit.value)} != ${JSON.stringify(expected)}`);
    }
  }
});

Deno.test("an encoded value is surrogated and recomposed byte for byte", async () => {
  const text = "The failing request was GET /users?mail=alex%40example.com&ref=1";
  const findings = await classify(text, testConfig());
  const result = transform(text, findings, new Set(["email"]));
  if (result.text.includes("alex") || result.text.includes("example.com")) {
    throw new Error("encoded value survived transformation");
  }
  if (!result.text.includes("&ref=1") || !result.text.includes("mail=")) {
    throw new Error("transformation damaged surrounding text");
  }
  if (recompose(result.text, result.mapping) !== text) {
    throw new Error("recomposition did not restore the encoded original");
  }
});

Deno.test("normalisation does not manufacture findings from ordinary text", async () => {
  const negatives = [
    "The fixture decodes to VGhpcyBpcyBub3QgYSBzZWNyZXQgdmFsdWU= in the test.",
    "Pull sha256:25675bd2a125b59bdcfbb6592ec5c332a2bc56e0dabf038184d8b2c6aec45c3b now.",
    "Deploy commit 9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 to staging.",
    "Progress was 50% done and 100%25 encoded; a < b and c > d.",
    "Ticket 123 45 6789 was escalated. See example.com for details.",
  ];
  for (const text of negatives) {
    const findings = await classify(text, testConfig());
    if (findings.length > 0) {
      throw new Error(
        `false positive on ${JSON.stringify(text)}: ${findings.map((f) => f.kind).join(",")}`,
      );
    }
  }
});

Deno.test("plain text produces no variants", () => {
  if (textVariants("Summarise the quarterly report in two lines.").length !== 0) {
    throw new Error("a variant was produced for text with nothing to decode");
  }
  const decoded = textVariants("mail=alex%40example.com")[0];
  if (decoded?.text !== "mail=alex@example.com") throw new Error("percent decoding failed");
  const span = decoded.toOriginal(5, 21);
  if (span.start !== 5 || span.end !== 23) {
    throw new Error(`span mapped to ${span.start}-${span.end}`);
  }
});
