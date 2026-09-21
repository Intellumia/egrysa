import { classify } from "../src/classifier.ts";
import {
  validateAba,
  validateNhsNumber,
  validateVerhoeff,
  validateVin,
} from "../src/classifier.ts";
import { validateConfig } from "../src/config.ts";
import type { FindingKind } from "../src/types.ts";
import { testConfig } from "./fixtures.ts";

// Each positive is a documentation-style or checksum-valid synthetic value.
const positives: Array<[string, FindingKind, string]> = [
  [
    "Host 2001:0db8:85a3:0000:0000:8a2e:0370:7334 replied.",
    "ipv6",
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
  ],
  ["Upstream 2001:db8::8a2e:370:7334 timed out.", "ipv6", "2001:db8::8a2e:370:7334"],
  ["Bound to ::1 only.", "ipv6", "::1"],
  ["Peer ::ffff:192.0.2.44 connected.", "ipv6", "::ffff:192.0.2.44"],
  ["Fetch http://[2001:db8::1]:8787/v1/models now.", "ipv6", "[2001:db8::1]"],
  ["Lease for 00:1A:2B:3C:4D:5E renewed.", "mac_address", "00:1A:2B:3C:4D:5E"],
  ["Device 00-1a-2b-3c-4d-5e seen.", "mac_address", "00-1a-2b-3c-4d-5e"],
  ["DOB: 14/03/1987 confirmed.", "date_of_birth", "14/03/1987"],
  ["Date of birth 1987-03-14.", "date_of_birth", "1987-03-14"],
  ["Born on 14 March 1987 in Pune.", "date_of_birth", "14 March 1987"],
  ["Aadhaar 2345 6789 0124 verified.", "aadhaar", "2345 6789 0124"],
  ["PAN ABCPE1234F submitted.", "india_pan", "ABCPE1234F"],
  ["NI number AB 12 34 56 C entered.", "uk_nino", "AB 12 34 56 C"],
  ["NHS number 943 476 5919 for referral.", "nhs_number", "943 476 5919"],
  ["Passport number X1234567 expires soon.", "passport", "X1234567"],
  ["Routing number 021000021 for the wire.", "bank_account", "021000021"],
  [
    "Pay 0x52908400098527886E0F7030069857D2E4169EE7 today.",
    "crypto_wallet",
    "0x52908400098527886E0F7030069857D2E4169EE7",
  ],
  [
    "Wallet bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq listed.",
    "crypto_wallet",
    "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  ],
  ["VIN 1HGCM82633A004352 registered.", "vin", "1HGCM82633A004352"],
];

Deno.test("new deterministic kinds are found against their exact spans", async () => {
  for (const [text, kind, expected] of positives) {
    const findings = await classify(text, testConfig());
    const hit = findings.find((finding) => finding.kind === kind);
    if (!hit) {
      throw new Error(
        `${kind} not found in ${JSON.stringify(text)}: ${findings.map((f) => f.kind)}`,
      );
    }
    if (hit.value !== expected || text.slice(hit.start, hit.end) !== expected) {
      throw new Error(
        `${kind}: got ${JSON.stringify(hit.value)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
});

Deno.test("look-alikes and invalid checksums do not match the new kinds", async () => {
  const negatives = [
    "The batch finished at 12:30:45 and 13:05:10.",
    "Replace std::string with std::string_view.",
    "Tx 0x9f2c1e4b7a6d3c5e8f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70 confirmed.",
    "Part PRDX1234A is backordered.",
    "Renewal date: 14/03/2027 for the contract.",
    "Aadhaar 2345 6789 0123 is malformed.",
    "NHS number 943 476 5910 is wrong.",
    "Routing number 021000022 fails the check.",
    "VIN 1HGCM82634A004352 has a bad check digit.",
    "NI number BG 12 34 56 C is not issued.",
  ];
  for (const text of negatives) {
    const findings = await classify(text, testConfig());
    const unexpected = findings.filter((finding) => finding.kind !== "phone");
    if (unexpected.length > 0) {
      throw new Error(
        `false positive on ${JSON.stringify(text)}: ${
          unexpected.map((f) => f.kind + ":" + f.value).join(", ")
        }`,
      );
    }
  }
});

Deno.test("checksum validators accept known-good and reject altered values", () => {
  if (!validateVerhoeff("234567890124") || validateVerhoeff("234567890123")) {
    throw new Error("verhoeff");
  }
  if (!validateNhsNumber("9434765919") || validateNhsNumber("9434765910")) throw new Error("nhs");
  if (!validateAba("021000021") || validateAba("021000022")) throw new Error("aba");
  if (!validateVin("1HGCM82633A004352") || validateVin("1HGCM82634A004352")) throw new Error("vin");
});

Deno.test("a labelled ten-digit number is an NHS number, an unlabelled one is a phone", async () => {
  const labelled = await classify("NHS number 943 476 5919 please.", testConfig());
  const bare = await classify("Ring 943 476 5919 please.", testConfig());
  if (!labelled.some((f) => f.kind === "nhs_number") || labelled.some((f) => f.kind === "phone")) {
    throw new Error("labelled NHS number did not win the overlap");
  }
  if (bare.some((f) => f.kind === "nhs_number")) {
    throw new Error("unlabelled number became an NHS number");
  }
});

Deno.test("an IPv4-mapped IPv6 address is one finding, not two", async () => {
  const findings = await classify("Peer ::ffff:192.0.2.44 connected.", testConfig());
  if (findings.length !== 1 || findings[0]!.kind !== "ipv6") {
    throw new Error(`expected one ipv6 finding, got ${findings.map((f) => f.kind)}`);
  }
});

Deno.test("a configuration that omits a new kind fails closed and names it", () => {
  const config = testConfig();
  config.policy.transformKinds = config.policy.transformKinds.filter((kind) => kind !== "ipv6");
  let message = "";
  try {
    validateConfig(config);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (!message.includes("ipv6") || !message.includes("no policy action")) {
    throw new Error(`expected a fail-closed error naming ipv6, got: ${message}`);
  }
});
