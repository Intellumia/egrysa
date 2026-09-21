import {
  bedrockStreamToSse,
  decodeEventMessages,
  encodeEventMessage,
} from "../src/aws_eventstream.ts";
import {
  clearGoogleTokenCache,
  googleAccessToken,
  googleServiceAccountAssertion,
  signAwsRequest,
} from "../src/cloud_auth.ts";
import { validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import type { AppConfig, ProviderConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";
const encoder = new TextEncoder();

function anthropicMessage(text: string): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function anthropicEvents(text: string): Array<Record<string, unknown>> {
  return [
    { type: "message_start", message: { ...anthropicMessage(""), content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...(text.match(/[\s\S]{1,6}/g) ?? []).map((piece) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
}

interface Seen {
  path: string;
  query: string;
  headers: Headers;
  body: Record<string, unknown>;
}

// One mock that plays Azure, Bedrock, Vertex, or a Google token endpoint,
// depending on the path it is asked for.
async function withCloudMock(
  action: (baseUrl: string, seen: () => Seen[]) => Promise<void>,
): Promise<void> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const seen: Seen[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      const form = await request.text();
      seen.push({
        path: url.pathname,
        query: url.search,
        headers: request.headers,
        body: { form },
      });
      return Response.json({ access_token: "ya29.test-token", expires_in: 3600 });
    }
    const body = await request.json() as Record<string, unknown>;
    seen.push({ path: url.pathname, query: url.search, headers: request.headers, body });
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const user = messages.find((message) => message.role === "user");
    const prompt = typeof user?.content === "string"
      ? user.content
      : ((user?.content as Array<{ text?: string }>) ?? []).map((block) => block.text ?? "").join(
        "",
      );
    const reply = `Noted: ${prompt}`;
    if (url.pathname.startsWith("/openai/deployments/")) {
      if (body.stream === true) {
        const frames = (reply.match(/[\s\S]{1,6}/g) ?? []).map((piece) =>
          `data: ${
            JSON.stringify({
              id: "c",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            })
          }\n\n`
        );
        frames.push("data: [DONE]\n\n");
        return new Response(encoder.encode(frames.join("")), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "chatcmpl-azure",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop",
        }],
      });
    }
    if (url.pathname.startsWith("/model/")) {
      if (url.pathname.endsWith("/invoke-with-response-stream")) {
        const frames = anthropicEvents(reply).map((event) =>
          encodeEventMessage(
            {
              ":message-type": "event",
              ":event-type": "chunk",
              ":content-type": "application/json",
            },
            encoder.encode(JSON.stringify({ bytes: btoa(JSON.stringify(event)) })),
          )
        );
        const total = frames.reduce((sum, frame) => sum + frame.length, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const frame of frames) {
          joined.set(frame, offset);
          offset += frame.length;
        }
        return new Response(joined, {
          headers: { "content-type": "application/vnd.amazon.eventstream" },
        });
      }
      return Response.json(anthropicMessage(reply));
    }
    if (url.pathname.includes("/publishers/anthropic/models/")) {
      if (url.pathname.endsWith(":streamRawPredict")) {
        const frames = anthropicEvents(reply).map((event) =>
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        );
        return new Response(encoder.encode(frames.join("")), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json(anthropicMessage(reply));
    }
    return Response.json({ error: "unexpected path" }, { status: 404 });
  });
  try {
    await action(`http://127.0.0.1:${await port}`, () => seen);
  } finally {
    await server.shutdown();
  }
}

function configFor(provider: ProviderConfig): AppConfig {
  const config = testConfig();
  config.providers = [config.providers[1]!, provider];
  config.policy.defaultProvider = provider.id;
  return config;
}

function chat(content: string, stream = false): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      model: "approved-model",
      messages: [{ role: "user", content }],
      ...(stream ? { stream: true } : {}),
    }),
  });
}

async function roundTrip(
  gateway: Gateway,
  seen: () => Seen[],
): Promise<{ plain: string; streamed: string; provider: Seen[] }> {
  const prompt = "Email alex@example.com about it.";
  const plain = await (await gateway.handle(chat(prompt))).text();
  const streamed = await (await gateway.handle(chat(prompt, true))).text();
  const provider = seen();
  for (const call of provider) {
    if (JSON.stringify(call.body).includes("alex@example.com")) {
      throw new Error("original reached the provider");
    }
  }
  if (!plain.includes("alex@example.com") || !streamed.includes("alex@example.com")) {
    throw new Error(
      `responses were not recomposed: ${plain.slice(0, 200)} / ${streamed.slice(0, 200)}`,
    );
  }
  if (!streamed.includes("[DONE]")) throw new Error("stream did not finish");
  return { plain, streamed, provider };
}

Deno.test("azure-openai addresses the deployment with api-key and no store field", async () => {
  await configureTestEnvironment();
  Deno.env.set("AZURE_TEST_KEY", "azure-secret");
  await withCloudMock(async (baseUrl, seen) => {
    const gateway = await Gateway.create(configFor({
      id: "azure",
      kind: "azure-openai",
      baseUrl,
      local: true,
      apiKeyEnv: "AZURE_TEST_KEY",
      deployment: "gpt-4o-prod",
      apiVersion: "2024-10-21",
      allowedModels: ["approved-model"],
      dataPolicy: { training: "disabled", retention: "standard", allowRaw: true },
    }));
    const { provider } = await roundTrip(gateway, seen);
    const call = provider[0]!;
    if (
      call.path !== "/openai/deployments/gpt-4o-prod/chat/completions" ||
      call.query !== "?api-version=2024-10-21" || call.headers.get("api-key") !== "azure-secret" ||
      call.headers.has("authorization") || "store" in call.body
    ) throw new Error(`azure request shape wrong: ${call.path}${call.query}`);
    await gateway.close();
  });
  Deno.env.delete("AZURE_TEST_KEY");
});

Deno.test("bedrock invokes with a bearer key, names the model in the URL, and decodes the event stream", async () => {
  await configureTestEnvironment();
  Deno.env.set("BEDROCK_TEST_KEY", "bedrock-api-key");
  await withCloudMock(async (baseUrl, seen) => {
    const gateway = await Gateway.create(configFor({
      id: "bedrock",
      kind: "bedrock",
      baseUrl,
      local: true,
      region: "us-east-1",
      apiKeyEnv: "BEDROCK_TEST_KEY",
      allowedModels: ["approved-model"],
      dataPolicy: { training: "disabled", retention: "standard", allowRaw: true },
    }));
    const { provider } = await roundTrip(gateway, seen);
    const [plain, streamed] = provider;
    if (
      plain!.path !== "/model/approved-model/invoke" ||
      streamed!.path !== "/model/approved-model/invoke-with-response-stream" ||
      plain!.headers.get("authorization") !== "Bearer bedrock-api-key" ||
      plain!.body.anthropic_version !== "bedrock-2023-05-31" || "model" in plain!.body ||
      "stream" in streamed!.body
    ) throw new Error(`bedrock request shape wrong: ${JSON.stringify(plain!.body)}`);
    await gateway.close();
  });
  Deno.env.delete("BEDROCK_TEST_KEY");
});

Deno.test("bedrock signs with SigV4 when IAM credentials are configured", async () => {
  await configureTestEnvironment();
  Deno.env.set("AWS_TEST_AKID", "AKIAIOSFODNN7EXAMPLE");
  Deno.env.set("AWS_TEST_SECRET", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  await withCloudMock(async (baseUrl, seen) => {
    const gateway = await Gateway.create(configFor({
      id: "bedrock",
      kind: "bedrock",
      baseUrl,
      local: true,
      region: "eu-west-1",
      credentialsEnv: { accessKeyId: "AWS_TEST_AKID", secretAccessKey: "AWS_TEST_SECRET" },
      allowedModels: ["approved-model"],
      dataPolicy: { training: "disabled", retention: "standard", allowRaw: true },
    }));
    const response = await gateway.handle(chat("Summarise it."));
    await response.text();
    const call = seen()[0]!;
    const authorization = call.headers.get("authorization") ?? "";
    if (
      !/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/
        .test(authorization) || !call.headers.get("x-amz-date")
    ) throw new Error(`unexpected SigV4 header: ${authorization}`);
    await gateway.close();
  });
  Deno.env.delete("AWS_TEST_AKID");
  Deno.env.delete("AWS_TEST_SECRET");
});

Deno.test("SigV4 signing is deterministic and encodes model ids in the path", async () => {
  const url = new URL(
    "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/invoke",
  );
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
  const at = new Date("2026-09-21T10:00:00Z");
  const first = await signAwsRequest("POST", url, "{}", credentials, "us-east-1", "bedrock", at);
  const second = await signAwsRequest("POST", url, "{}", credentials, "us-east-1", "bedrock", at);
  const changed = await signAwsRequest("POST", url, "{ }", credentials, "us-east-1", "bedrock", at);
  if (first.get("authorization") !== second.get("authorization")) {
    throw new Error("not deterministic");
  }
  if (first.get("authorization") === changed.get("authorization")) {
    throw new Error("payload not signed");
  }
  if (first.get("x-amz-date") !== "20260921T100000Z") throw new Error("date format wrong");
});

Deno.test("vertex exchanges a service-account key for a token and streams SSE", async () => {
  await configureTestEnvironment();
  clearGoogleTokenCache();
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(String.fromCharCode(...new Uint8Array(der))).match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
  await withCloudMock(async (baseUrl, seen) => {
    const account = {
      client_email: "svc@example-project.iam.gserviceaccount.com",
      private_key: pem,
    };
    Deno.env.set("GOOGLE_TEST_SA", JSON.stringify(account));
    const assertion = await googleServiceAccountAssertion({
      ...account,
      token_uri: `${baseUrl}/token`,
    }, "scope");
    const [header, claims, signature] = assertion.split(".");
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      Uint8Array.from(
        atob(
          signature!.replace(/-/g, "+").replace(/_/g, "/").padEnd(
            Math.ceil(signature!.length / 4) * 4,
            "=",
          ),
        ),
        (c) => c.charCodeAt(0),
      ),
      encoder.encode(`${header}.${claims}`),
    );
    if (!verified) throw new Error("JWT signature does not verify with the public key");
    const gateway = await Gateway.create(configFor({
      id: "vertex",
      kind: "vertex",
      baseUrl,
      local: true,
      region: "europe-west1",
      project: "example-project",
      serviceAccountEnv: "GOOGLE_TEST_SA",
      tokenUrl: `${baseUrl}/token`,
      allowedModels: ["approved-model"],
      dataPolicy: { training: "disabled", retention: "standard", allowRaw: true },
    }));
    const { provider } = await roundTrip(gateway, seen);
    const tokenCalls = provider.filter((call) => call.path === "/token");
    const modelCalls = provider.filter((call) => call.path !== "/token");
    if (tokenCalls.length !== 1) {
      throw new Error(
        `token endpoint called ${tokenCalls.length} times; expected one cached exchange`,
      );
    }
    if (
      modelCalls[0]!.path !==
        "/v1/projects/example-project/locations/europe-west1/publishers/anthropic/models/approved-model:rawPredict" ||
      modelCalls[1]!.path.endsWith(":streamRawPredict") === false ||
      modelCalls[0]!.headers.get("authorization") !== "Bearer ya29.test-token" ||
      modelCalls[0]!.body.anthropic_version !== "vertex-2023-10-16" ||
      "model" in modelCalls[0]!.body
    ) throw new Error(`vertex request shape wrong: ${modelCalls[0]!.path}`);
    const again = await googleAccessToken({ ...account }, `${baseUrl}/token`);
    if (again !== "ya29.test-token") throw new Error("cached token not returned");
    await gateway.close();
  });
  Deno.env.delete("GOOGLE_TEST_SA");
});

Deno.test("the event stream decoder handles split frames and exceptions", async () => {
  const chunk = encodeEventMessage(
    { ":message-type": "event", ":event-type": "chunk" },
    encoder.encode(JSON.stringify({ bytes: btoa(JSON.stringify({ type: "message_stop" })) })),
  );
  const failure = encodeEventMessage(
    { ":message-type": "exception", ":exception-type": "throttlingException" },
    encoder.encode(JSON.stringify({ message: "slow down" })),
  );
  const { messages, rest } = decodeEventMessages(chunk.subarray(0, chunk.length - 5));
  if (messages.length !== 0 || rest.length !== chunk.length - 5) {
    throw new Error("partial frame was consumed");
  }
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk.subarray(0, 20));
      controller.enqueue(chunk.subarray(20));
      controller.enqueue(failure);
      controller.close();
    },
  });
  const text = await new Response(bedrockStreamToSse(upstream)).text();
  if (!text.includes("event: message_stop") || !text.includes('"message":"slow down"')) {
    throw new Error(`decoded stream wrong: ${text}`);
  }
});

Deno.test("cloud provider configuration is validated per kind", () => {
  const base = testConfig().providers[0]!;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ kind: "azure-openai", baseUrl: "https://r.openai.azure.com" }, "deployment"],
    [
      { kind: "azure-openai", baseUrl: "https://r.openai.azure.com", deployment: "d" },
      "apiVersion",
    ],
    [{ kind: "bedrock", baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com" }, "region"],
    [{
      kind: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      apiKeyEnv: undefined,
    }, "apiKeyEnv or credentialsEnv"],
    [{
      kind: "vertex",
      baseUrl: "https://europe-west1-aiplatform.googleapis.com",
      region: "europe-west1",
    }, "project"],
    [{
      kind: "vertex",
      baseUrl: "https://europe-west1-aiplatform.googleapis.com",
      region: "europe-west1",
      project: "example-project",
      apiKeyEnv: undefined,
    }, "serviceAccountEnv"],
  ];
  for (const [override, expected] of cases) {
    const config = testConfig();
    const provider = { ...base, ...override } as unknown as ProviderConfig;
    if ("apiKeyEnv" in override && override.apiKeyEnv === undefined) delete provider.apiKeyEnv;
    config.providers[0] = provider;
    let message = "";
    try {
      validateConfig(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes(expected)) {
      throw new Error(`${override.kind}: expected "${expected}", got "${message}"`);
    }
  }
});
