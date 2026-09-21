// Live checks for the cloud-hosted provider kinds, one per provider, each
// skipped unless its credentials and endpoint details are in the
// environment. Each check runs a request through the whole gateway rather
// than the adapter alone: the email in the prompt must be transformed on
// the way out, the reply must come back recomposed, the receipt must verify
// against the public key, and the same must hold over the streaming path.
//
//   deno task smoke:cloud
//
// Environment, per provider (credentials are read only from the variable
// the provider configuration names; nothing here prints them):
//   Azure OpenAI:  AZURE_OPENAI_API_KEY, EGRYSA_LIVE_AZURE_ENDPOINT
//                  (https://<resource>.openai.azure.com), EGRYSA_LIVE_AZURE_DEPLOYMENT,
//                  EGRYSA_LIVE_AZURE_API_VERSION (default 2024-10-21), EGRYSA_LIVE_AZURE_MODEL
//                  (the model name the deployment serves; default: the deployment name)
//   Bedrock:       AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
//                  (+ AWS_SESSION_TOKEN); EGRYSA_LIVE_BEDROCK_REGION, EGRYSA_LIVE_BEDROCK_MODEL
//                  (for example anthropic.claude-3-5-sonnet-20241022-v2:0)
//   Vertex:        GOOGLE_SERVICE_ACCOUNT_JSON (the key file's contents) or
//                  GOOGLE_ACCESS_TOKEN; EGRYSA_LIVE_VERTEX_PROJECT, EGRYSA_LIVE_VERTEX_REGION,
//                  EGRYSA_LIVE_VERTEX_MODEL (for example claude-3-5-sonnet-v2@20241022)

import { Gateway } from "../src/gateway.ts";
import { verifyReceipt } from "../src/receipts.ts";
import type { AppConfig, PrivacyReceipt, ProviderConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";
const env = (name: string) => Deno.env.get(name)?.trim() || undefined;

function azure(): ProviderConfig | null {
  const endpoint = env("EGRYSA_LIVE_AZURE_ENDPOINT");
  const deployment = env("EGRYSA_LIVE_AZURE_DEPLOYMENT");
  if (!endpoint || !deployment || !env("AZURE_OPENAI_API_KEY")) return null;
  return {
    id: "azure",
    kind: "azure-openai",
    baseUrl: endpoint,
    apiKeyEnv: "AZURE_OPENAI_API_KEY",
    deployment,
    apiVersion: env("EGRYSA_LIVE_AZURE_API_VERSION") ?? "2024-10-21",
    allowedModels: [env("EGRYSA_LIVE_AZURE_MODEL") ?? deployment],
    dataPolicy: { training: "disabled", retention: "standard", allowRaw: false },
  };
}

function bedrock(): ProviderConfig | null {
  const region = env("EGRYSA_LIVE_BEDROCK_REGION");
  const model = env("EGRYSA_LIVE_BEDROCK_MODEL");
  if (!region || !model) return null;
  const base = {
    id: "bedrock",
    kind: "bedrock" as const,
    baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
    region,
    allowedModels: [model],
    dataPolicy: { training: "disabled" as const, retention: "standard" as const, allowRaw: false },
  };
  if (env("AWS_BEARER_TOKEN_BEDROCK")) return { ...base, apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK" };
  if (env("AWS_ACCESS_KEY_ID") && env("AWS_SECRET_ACCESS_KEY")) {
    return {
      ...base,
      credentialsEnv: {
        accessKeyId: "AWS_ACCESS_KEY_ID",
        secretAccessKey: "AWS_SECRET_ACCESS_KEY",
        ...(env("AWS_SESSION_TOKEN") ? { sessionToken: "AWS_SESSION_TOKEN" } : {}),
      },
    };
  }
  return null;
}

function vertex(): ProviderConfig | null {
  const project = env("EGRYSA_LIVE_VERTEX_PROJECT");
  const region = env("EGRYSA_LIVE_VERTEX_REGION");
  const model = env("EGRYSA_LIVE_VERTEX_MODEL");
  if (!project || !region || !model) return null;
  const base = {
    id: "vertex",
    kind: "vertex" as const,
    baseUrl: `https://${region}-aiplatform.googleapis.com`,
    region,
    project,
    allowedModels: [model],
    dataPolicy: { training: "disabled" as const, retention: "standard" as const, allowRaw: false },
  };
  if (env("GOOGLE_SERVICE_ACCOUNT_JSON")) {
    return { ...base, serviceAccountEnv: "GOOGLE_SERVICE_ACCOUNT_JSON" };
  }
  if (env("GOOGLE_ACCESS_TOKEN")) return { ...base, apiKeyEnv: "GOOGLE_ACCESS_TOKEN" };
  return null;
}

// The same check against a loopback OpenAI-compatible server (for example
// the stub from `deno task stub`), so the harness is proven at zero cost
// before a cloud credential is spent on it.
function local(): ProviderConfig | null {
  const url = env("EGRYSA_LIVE_LOCAL_URL");
  const model = env("EGRYSA_LIVE_LOCAL_MODEL");
  if (!url || !model) return null;
  return {
    id: "local-live",
    kind: "openai-compatible",
    baseUrl: url,
    local: true,
    allowedModels: [model],
    dataPolicy: { training: "unknown", retention: "none", allowRaw: true },
  };
}

async function liveCheck(provider: ProviderConfig): Promise<void> {
  await configureTestEnvironment();
  const config: AppConfig = testConfig();
  config.requestTimeoutMs = 60_000;
  config.providers = [provider, config.providers[1]!];
  config.policy.defaultProvider = provider.id;
  const model = provider.allowedModels[0]!;
  const gateway = await Gateway.create(config);
  const email = "live.check@example.com";
  const prompt = `Reply with exactly this sentence and nothing else: Contact ${email} today.`;
  try {
    const response = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      }),
    );
    const text = await response.text();
    if (response.status !== 200) throw new Error(`${provider.id}: ${response.status} ${text}`);
    if (response.headers.get("x-egrysa-decision") !== "transform") {
      throw new Error(`${provider.id}: expected a transform decision`);
    }
    const body = JSON.parse(text) as { choices: Array<{ message: { content: string } }> };
    const content = body.choices[0]?.message.content ?? "";
    if (!content.includes(email)) {
      throw new Error(`${provider.id}: reply was not recomposed: ${JSON.stringify(content)}`);
    }
    if (/__EGRYSA_/.test(content)) throw new Error(`${provider.id}: surrogate residue in reply`);
    const receiptId = response.headers.get("x-egrysa-receipt")!;
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${receiptId}`, { headers: { authorization: AUTH } }),
    )).json() as PrivacyReceipt;
    const publicKey = (await (await gateway.handle(
      new Request("http://gateway/v1/receipts/public-key", { headers: { authorization: AUTH } }),
    )).json()).publicKey as string;
    if (!await verifyReceipt(receipt, publicKey)) throw new Error(`${provider.id}: receipt failed`);
    if (
      receipt.provider !== provider.id || !("egress" in receipt) || receipt.egress !== "completed"
    ) {
      throw new Error(`${provider.id}: receipt does not record completed egress to the provider`);
    }
    if (JSON.stringify(receipt).includes(email)) {
      throw new Error(`${provider.id}: receipt carries content`);
    }

    const streamed = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        }),
      }),
    );
    const sse = await streamed.text();
    if (streamed.status !== 200) {
      throw new Error(`${provider.id} stream: ${streamed.status} ${sse}`);
    }
    if (!sse.includes("data: [DONE]")) throw new Error(`${provider.id} stream: no [DONE]`);
    if (sse.includes("upstream_stream_error") || sse.includes("recomposition_error")) {
      throw new Error(`${provider.id} stream: error frame ${sse.slice(0, 300)}`);
    }
    const streamedText = [...sse.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      JSON.parse(`"${m[1]}"`)
    ).join("");
    if (!streamedText.includes(email)) {
      throw new Error(`${provider.id} stream: not recomposed: ${JSON.stringify(streamedText)}`);
    }
    console.log(JSON.stringify({
      level: "info",
      event: "live_cloud_check",
      provider: provider.id,
      kind: provider.kind,
      model,
      receipt: receiptId,
      json: "ok",
      stream: "ok",
    }));
  } finally {
    await gateway.close();
  }
}

for (
  const [name, build] of [
    ["Azure OpenAI", azure],
    ["Amazon Bedrock", bedrock],
    ["Vertex AI", vertex],
    ["local OpenAI-compatible server", local],
  ] as const
) {
  const provider = build();
  Deno.test({
    name: `live ${name}: transform, recompose, receipt, and stream through the gateway`,
    ignore: provider === null,
    fn: () => liveCheck(provider!),
  });
}
