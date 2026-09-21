// Holds the code to docs/COMPATIBILITY.md. Each test names the rule it
// enforces; a failure here means a frozen surface changed, and the policy
// says what such a change must be accompanied by.

import { validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { ReceiptStore, verifyReceipt } from "../src/receipts.ts";
import {
  type AppConfig,
  FINDING_KINDS,
  type PrivacyReceipt,
  PROVIDER_KINDS,
  SENSITIVITIES,
} from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const ROOT = new URL("../", import.meta.url);
const schema = JSON.parse(
  await Deno.readTextFile(new URL("api/config.schema.json", ROOT)),
) as Schema;
const openapi = await Deno.readTextFile(new URL("api/openapi.yaml", ROOT));

// A structural checker for the subset of JSON Schema the configuration
// schema uses. It is deliberately small: the point is that shipped
// configurations and the validator agree with the published document, not to
// validate arbitrary schemas.
function resolve(node: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string") return node;
  let current: Json = schema;
  for (const part of ref.replace(/^#\//, "").split("/")) {
    current = (current as Record<string, Json>)[part]!;
  }
  return current as Schema;
}

function check(value: Json, node: Schema, path: string): string[] {
  node = resolve(node);
  const errors: string[] = [];
  if (Array.isArray(node.oneOf)) {
    const results = (node.oneOf as Schema[]).map((branch) => check(value, branch, path));
    if (!results.some((r) => r.length === 0)) errors.push(`${path}: matches no oneOf branch`);
    return errors;
  }
  if ("const" in node && JSON.stringify(value) !== JSON.stringify(node.const)) {
    errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  }
  if (
    Array.isArray(node.enum) && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  const type = node.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [`${path}: not an object`];
    }
    const properties = (node.properties ?? {}) as Record<string, Schema>;
    for (const key of (node.required ?? []) as string[]) {
      if (!(key in value)) errors.push(`${path}: missing ${key}`);
    }
    const names = node.propertyNames as Schema | undefined;
    for (const [key, child] of Object.entries(value)) {
      if (names?.pattern && !new RegExp(names.pattern as string).test(key)) {
        errors.push(`${path}.${key}: property name rejected`);
      }
      if (key in properties) errors.push(...check(child, properties[key]!, `${path}.${key}`));
      else if (node.additionalProperties === false) errors.push(`${path}: unknown field ${key}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        errors.push(...check(child, node.additionalProperties as Schema, `${path}.${key}`));
      }
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: not an array`];
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push(`${path}: fewer than ${node.minItems} items`);
    }
    if (node.items) {
      value.forEach((item, i) =>
        errors.push(...check(item, node.items as Schema, `${path}[${i}]`))
      );
    }
  } else if (type === "integer" || type === "number") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) {
      return [`${path}: not ${type}`];
    }
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push(`${path}: below minimum`);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push(`${path}: above maximum`);
    }
  } else if (type === "string") {
    if (typeof value !== "string") return [`${path}: not a string`];
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push(`${path}: too short`);
    }
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: does not match ${node.pattern}`);
    }
  } else if (type === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: not a boolean`);
  }
  return errors;
}

function assertConforms(value: Json, label: string): void {
  const errors = check(value, schema, label);
  if (errors.length) {
    throw new Error(
      `${label} does not conform to api/config.schema.json:\n  ${errors.join("\n  ")}`,
    );
  }
}

// Every optional block populated, so the injection test reaches every level
// the schema closes.
function fullConfig(): AppConfig {
  const config = testConfig();
  config.schemaVersion = 1;
  config.receiptSigner = {
    kind: "remote",
    url: "https://signer.internal/sign",
    headersEnv: "EGRYSA_SIGNER_HEADERS",
    timeoutMs: 2000,
  };
  config.providers.push({
    id: "bedrock",
    kind: "bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    region: "us-east-1",
    credentialsEnv: { accessKeyId: "AWS_ACCESS_KEY_ID", secretAccessKey: "AWS_SECRET_ACCESS_KEY" },
    allowedModels: ["anthropic.claude-3-5-sonnet-20241022-v2:0"],
    capabilities: { seed: false },
    dataPolicy: { training: "disabled", retention: "none", allowRaw: false },
  });
  config.nerDetector = {
    enabled: false,
    baseUrl: "http://127.0.0.1:11436",
    kinds: ["person_name"],
  };
  config.policy.sensitivity = "balanced";
  config.policy.response = { scan: true, blocked: "redact", transformable: "pass" };
  config.policy.surrogates = { style: "synthetic", scope: "workload" };
  config.policy.rateLimit = { requestsPerMinute: 600, burst: 100 };
  config.oidc = { issuer: "https://idp.example", audience: "egrysa", roleClaim: "roles" };
  config.export = {
    url: "https://siem.internal/collect",
    format: "otlp",
    headersEnv: "EGRYSA_EXPORT_HEADERS",
  };
  config.workloads = {
    "finance-app": {
      sensitivity: "strict",
      allowedProviders: ["remote"],
      allowedModels: ["approved-model"],
      rateLimit: { requestsPerMinute: 60 },
      surrogates: { style: "token" },
      response: { blocked: "deny" },
      sensitiveTerms: [{ term: "Project X", label: "initiative" }],
    },
  };
  return config;
}

Deno.test("shipped configurations conform to the frozen configuration schema", async () => {
  for (
    const file of [
      "config/egrysa.example.json",
      "config/egrysa.container.json",
      "config/egrysa.stub.json",
    ]
  ) {
    const parsed = JSON.parse(await Deno.readTextFile(new URL(file, ROOT)));
    assertConforms(parsed, file);
    validateConfig(parsed as AppConfig);
  }
  const configMap = await Deno.readTextFile(new URL("deploy/kubernetes/configmap.yaml", ROOT));
  const embedded = JSON.parse(configMap.slice(configMap.indexOf("{")));
  assertConforms(embedded, "deploy/kubernetes/configmap.yaml");
  validateConfig(embedded as AppConfig);
  assertConforms(testConfig() as unknown as Json, "tests/fixtures.ts");
  const full = fullConfig();
  assertConforms(full as unknown as Json, "fullConfig");
  validateConfig(full);
});

Deno.test("schema enumerations match the code", () => {
  const defs = schema.$defs as Record<string, Schema>;
  const pairs: Array<[string, readonly string[], Json]> = [
    ["findingKind", FINDING_KINDS, defs.findingKind!.enum!],
    ["sensitivity", SENSITIVITIES, defs.sensitivity!.enum!],
    [
      "provider.kind",
      PROVIDER_KINDS,
      (defs.provider!.properties as Record<string, Schema>).kind!.enum!,
    ],
  ];
  for (const [name, code, listed] of pairs) {
    if (JSON.stringify([...code]) !== JSON.stringify(listed)) {
      throw new Error(
        `${name}: schema lists ${JSON.stringify(listed)}, code has ${JSON.stringify(code)}`,
      );
    }
  }
});

Deno.test("an unknown field at any closed level is rejected by the validator", () => {
  const closed: string[] = [];
  const walk = (value: Json, node: Schema, path: string) => {
    node = resolve(node);
    if (Array.isArray(node.oneOf)) {
      const branch = (node.oneOf as Schema[]).find((b) => check(value, b, path).length === 0);
      if (branch) walk(value, branch, path);
      return;
    }
    if (node.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
      if (node.additionalProperties === false) closed.push(path);
      const properties = (node.properties ?? {}) as Record<string, Schema>;
      for (const [key, child] of Object.entries(value)) {
        if (key in properties) walk(child, properties[key]!, `${path}.${key}`);
        else if (node.additionalProperties && typeof node.additionalProperties === "object") {
          walk(child, node.additionalProperties as Schema, `${path}.${key}`);
        }
      }
    } else if (node.type === "array" && Array.isArray(value) && node.items) {
      value.forEach((item, i) => walk(item, node.items as Schema, `${path}[${i}]`));
    }
  };
  walk(fullConfig() as unknown as Json, schema, "$");
  if (closed.length < 15) throw new Error(`walked only ${closed.length} closed objects: ${closed}`);
  for (const path of closed) {
    const config = fullConfig() as unknown as Record<string, Json>;
    let target: Json = config;
    for (const segment of path.slice(1).match(/\.[^.[]+|\[\d+\]/g) ?? []) {
      target = segment.startsWith("[")
        ? (target as Json[])[Number(segment.slice(1, -1))]!
        : (target as Record<string, Json>)[segment.slice(1)]!;
    }
    (target as Record<string, Json>).__unknown__ = true;
    let threw = false;
    try {
      validateConfig(config as unknown as AppConfig);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`an unknown field at ${path} was accepted`);
  }
  const wrongVersion = fullConfig() as unknown as Record<string, Json>;
  wrongVersion.schemaVersion = 2;
  let threw = false;
  try {
    validateConfig(wrongVersion as unknown as AppConfig);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("schemaVersion 2 was accepted");
});

Deno.test("every path in the API document is served", async () => {
  await configureTestEnvironment();
  const gateway = await Gateway.create(testConfig());
  const auth = { authorization: "Bearer a-test-client-key-that-is-long-enough" };
  const documented = [...openapi.matchAll(/^ {2}(\/\S+):\n {4}(get|post):/gm)].map((
    m,
  ): [string, string] => [m[2]!, m[1]!]);
  if (documented.length < 9) {
    throw new Error(`parsed only ${documented.length} paths from api/openapi.yaml`);
  }
  const unknownRoute = await gateway.handle(
    new Request("http://g/v1/not-a-route", { headers: auth }),
  );
  const unknownDetail = ((await unknownRoute.json()) as { detail: string }).detail;
  for (const [method, path] of documented) {
    const url = `http://g${path.replace("{id}", crypto.randomUUID())}`;
    const response = await gateway.handle(
      new Request(url, {
        method: method.toUpperCase(),
        headers: { ...auth, "content-type": "application/json" },
        ...(method === "post" ? { body: "{}" } : {}),
      }),
    );
    const text = await response.text();
    let detail = "";
    try {
      detail = (JSON.parse(text) as { detail?: string }).detail ?? "";
    } catch {
      // Non-JSON bodies (metrics, streams) are served routes by construction.
    }
    if (response.status === 404 && detail === unknownDetail) {
      throw new Error(`${method.toUpperCase()} ${path} is documented but not served`);
    }
  }
  await gateway.close();
});

Deno.test("receipts from the alpha.5 chain verify, load, and accept a new receipt", async () => {
  const dir = new URL("fixtures/receipts-alpha5/", import.meta.url);
  const keys = JSON.parse(await Deno.readTextFile(new URL("keys.json", dir))) as {
    privateKeyPkcs8: string;
    publicKeySpki: string;
    fingerprintKey: string;
    chainId: string;
  };
  const lines = (await Deno.readTextFile(new URL("receipts.jsonl", dir))).split("\n").filter(
    Boolean,
  );
  const receipts = lines.map((line) => JSON.parse(line) as PrivacyReceipt);
  for (const receipt of receipts) {
    if (!await verifyReceipt(receipt, keys.publicKeySpki)) {
      throw new Error(`frozen version-${receipt.version} receipt no longer verifies`);
    }
  }
  // Every version the API document lists has a frozen receipt, and every
  // frozen receipt fits the documented shape.
  const start = openapi.indexOf("    Receipt:");
  const component = openapi.slice(start, openapi.indexOf("    Problem:", start));
  const listed = JSON.parse(component.match(/enum: (\[[^\]]+\])/)![1]!) as string[];
  const frozen = receipts.map((r) => r.version);
  for (const version of listed) {
    if (!frozen.includes(version as PrivacyReceipt["version"])) {
      throw new Error(`no frozen receipt for version ${version}`);
    }
  }
  const required = component.match(/required: \[([^\]]+)\]/)![1]!.split(",").map((s) => s.trim())
    .filter(Boolean);
  const properties = [...component.matchAll(/^ {8}(\w+):/gm)].map((m) => m[1]!);
  for (const receipt of receipts) {
    const keysOf = Object.keys(receipt);
    for (const key of required) {
      if (!keysOf.includes(key)) throw new Error(`version ${receipt.version} lacks ${key}`);
    }
    for (const key of keysOf) {
      if (!properties.includes(key)) {
        throw new Error(`version ${receipt.version} carries undocumented ${key}`);
      }
    }
  }
  // The chain loads under today's store and continues.
  const path = await Deno.makeTempFile({ prefix: "egrysa-frozen-", suffix: ".jsonl" });
  try {
    await Deno.copyFile(new URL("receipts.jsonl", dir), path);
    const store = await ReceiptStore.open({
      fingerprintKey: keys.fingerprintKey,
      privateKeyPkcs8: keys.privateKeyPkcs8,
      publicKeySpki: keys.publicKeySpki,
      chainId: keys.chainId,
      logPath: path,
      capacity: 10,
      maxLogBytes: 64 * 1024 * 1024,
    });
    const next = await store.create({
      requestCanonical: "{}",
      workloadId: "frozen-workload",
      decision: "deny",
      provider: null,
      model: "approved-model",
      findings: [],
      transformedFields: 0,
    });
    await store.close();
    const last = receipts[receipts.length - 1]!;
    if (next.sequence !== last.sequence + 1 || next.previousReceiptHash !== last.receiptHash) {
      throw new Error("new receipt did not chain onto the frozen log");
    }
  } finally {
    await Deno.remove(path).catch(() => undefined);
  }
});
