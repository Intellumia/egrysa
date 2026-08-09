import { loadConfig } from "../src/config.ts";
import { readBoundedText } from "../src/bounded.ts";
import {
  PROVIDER_CAPABILITY_TABLE,
  resolveProviderCapabilities,
} from "../src/provider_capabilities.ts";
import { invokeProvider, ProviderError } from "../src/providers.ts";
import type { ChatRequest, ProviderConfig } from "../src/types.ts";

export interface ConformanceCheck {
  passed: boolean;
  detail: string;
  downgraded?: string[];
}

export interface ConformanceReport {
  schemaVersion: "1";
  generatedAt: string;
  provider: {
    id: string;
    kind: ProviderConfig["kind"];
    host: string;
    model: string;
  };
  capabilities: ReturnType<typeof resolveProviderCapabilities>;
  wire: {
    nonStreaming: ConformanceCheck;
    streaming: ConformanceCheck;
    toolCall: ConformanceCheck;
    errorMapping: ConformanceCheck;
    responseFormat: ConformanceCheck & { support: "supported" | "unsupported" | "error" };
  };
  behavior: {
    surrogateFidelity: ConformanceCheck & { informational: true };
  };
  summary: { passed: boolean; passedChecks: number; totalChecks: number };
}

const BAD_MODEL = "egrysa-conformance-invalid-model";
const SURROGATE_TOKENS = ["__EGRYSA_PII_0__", "__EGRYSA_EMAIL_0001_abc123__"];

export function renderProviderSupportMatrix(
  reports: Partial<Record<ProviderConfig["kind"], string>> = {},
): string {
  const kinds: ProviderConfig["kind"][] = ["openai", "openai-compatible", "anthropic"];
  const rows = kinds.map((kind): string[] => {
    const capabilities = PROVIDER_CAPABILITY_TABLE[kind];
    const tuningGaps = [
      "seed",
      "top_p",
      "frequency_penalty",
      "presence_penalty",
      "parallel_tool_calls",
    ].filter((key) => !capabilities[key as keyof typeof capabilities]);
    const stream = capabilities.stream ? "native" : "no";
    const report = reports[kind] ? `[report](${reports[kind]})` : "**report wanted**";
    return [
      kind,
      "yes",
      stream,
      capabilities.tools ? "yes" : "no",
      tuningGaps.length ? tuningGaps.join(", ") : "none",
      report,
    ];
  });
  return markdownTable([
    [
      "Provider kind",
      "Non-streaming",
      "Streaming",
      "Tools",
      "Default tuning downgrades",
      "Conformance report",
    ],
    ...rows,
  ]);
}

function markdownTable(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(3, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const line = (row: string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;
  return [
    line(rows[0]!),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.slice(1).map(line),
  ].join("\n");
}

export async function runConformance(
  provider: ProviderConfig,
  model: string,
  timeoutMs = 30_000,
): Promise<ConformanceReport> {
  const baseRequest = (): ChatRequest => ({
    model,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
  });
  const nonStreaming = await check(async () => {
    const invocation = await invokeProvider(provider, baseRequest(), timeoutMs);
    if (invocation.type !== "json") throw new Error("adapter returned a stream");
    validateCompletion(invocation.data);
    return { detail: "single-choice completion shape accepted", downgraded: invocation.downgraded };
  });
  const streaming = await check(async () => {
    const invocation = await invokeProvider(
      provider,
      { ...baseRequest(), stream: true },
      timeoutMs,
    );
    if (invocation.type !== "stream") throw new Error("adapter returned a buffered response");
    try {
      const frames = parseSse(await readBoundedText(invocation.response, 2 * 1024 * 1024));
      validateStableChunkTemplate(frames);
    } finally {
      invocation.complete();
    }
    return {
      detail: "data frames, stable template, and terminal DONE accepted",
      downgraded: invocation.downgraded,
    };
  });
  const toolCall = await check(async () => {
    const invocation = await invokeProvider(provider, {
      ...baseRequest(),
      messages: [{ role: "user", content: "Call the ping tool with value ok." }],
      tools: [{
        type: "function",
        function: {
          name: "ping",
          description: "Return a supplied value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "ping" } },
    }, timeoutMs);
    if (invocation.type !== "json") throw new Error("tool check returned a stream");
    validateToolCall(invocation.data);
    return {
      detail: "forced tool call returned JSON object arguments",
      downgraded: invocation.downgraded,
    };
  });
  const errorMapping = await check(async () => {
    const probeProvider = {
      ...provider,
      allowedModels: [...provider.allowedModels, BAD_MODEL],
    };
    try {
      await invokeProvider(probeProvider, {
        model: BAD_MODEL,
        messages: [{ role: "user", content: "invalid model probe" }],
      }, timeoutMs);
    } catch (error) {
      if (error instanceof ProviderError) {
        return { detail: `invalid model mapped to provider error status ${error.status}` };
      }
      throw error;
    }
    throw new Error("invalid model unexpectedly succeeded");
  });
  const responseFormat = await responseFormatProbe(provider, model, timeoutMs);
  const surrogateFidelity = await check(async () => {
    const invocation = await invokeProvider(provider, {
      model,
      messages: [{
        role: "user",
        content: `Repeat these strings exactly: ${SURROGATE_TOKENS.join(" ")}`,
      }],
    }, timeoutMs);
    if (invocation.type !== "json") throw new Error("surrogate probe returned a stream");
    const content = completionText(invocation.data);
    const survived = SURROGATE_TOKENS.every((token) => content.includes(token));
    return {
      detail: survived
        ? "all synthetic surrogate tokens survived verbatim"
        : "one or more tokens changed",
      downgraded: invocation.downgraded,
    };
  });
  const wireChecks = [nonStreaming, streaming, toolCall, errorMapping, responseFormat];
  const passedChecks = wireChecks.filter((item) => item.passed).length;
  return {
    schemaVersion: "1",
    generatedAt: new Date().toISOString(),
    provider: {
      id: provider.id,
      kind: provider.kind,
      host: new URL(provider.baseUrl).host,
      model,
    },
    capabilities: resolveProviderCapabilities(provider),
    wire: { nonStreaming, streaming, toolCall, errorMapping, responseFormat },
    behavior: { surrogateFidelity: { ...surrogateFidelity, informational: true } },
    summary: {
      passed: passedChecks === wireChecks.length,
      passedChecks,
      totalChecks: wireChecks.length,
    },
  };
}

async function responseFormatProbe(
  provider: ProviderConfig,
  model: string,
  timeoutMs: number,
): Promise<ConformanceReport["wire"]["responseFormat"]> {
  if (provider.kind === "anthropic") {
    return {
      passed: true,
      support: "unsupported",
      detail: "Anthropic adapter does not expose the OpenAI response_format field",
    };
  }
  const headers = new Headers({ "content-type": "application/json" });
  const key = provider.apiKeyEnv ? Deno.env.get(provider.apiKeyEnv) : undefined;
  if (!provider.local && !key) {
    return { passed: false, support: "error", detail: "provider credential is unavailable" };
  }
  if (key) headers.set("authorization", `Bearer ${key}`);
  try {
    const response = await fetch(chatCompletionsUrl(provider), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Return an empty JSON object." }],
        response_format: { type: "json_object" },
        stream: false,
        store: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([400, 404, 422].includes(response.status)) {
      await response.body?.cancel();
      return {
        passed: true,
        support: "unsupported",
        detail: `clean rejection status ${response.status}`,
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return {
        passed: false,
        support: "error",
        detail: `unexpected response status ${response.status}`,
      };
    }
    const parsed = JSON.parse(await readBoundedText(response, 2 * 1024 * 1024)) as Record<
      string,
      unknown
    >;
    JSON.parse(completionText(parsed));
    return {
      passed: true,
      support: "supported",
      detail: "json_object response parsed successfully",
    };
  } catch (error) {
    return { passed: false, support: "error", detail: safeErrorClass(error) };
  }
}

async function check(
  action: () => Promise<{ detail: string; downgraded?: string[] }>,
): Promise<ConformanceCheck> {
  try {
    const result = await action();
    return { passed: true, ...result };
  } catch (error) {
    return { passed: false, detail: safeErrorClass(error) };
  }
}

function validateCompletion(value: Record<string, unknown>): void {
  if (!Array.isArray(value.choices) || value.choices.length !== 1) {
    throw new Error("completion must contain one choice");
  }
  const choice = value.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new Error("completion choice must be an object");
  }
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("completion choice must contain a message");
  }
  const typed = message as Record<string, unknown>;
  if (typeof typed.content !== "string" && !Array.isArray(typed.tool_calls)) {
    throw new Error("message must contain string content or tool calls");
  }
}

function validateToolCall(value: Record<string, unknown>): void {
  validateCompletion(value);
  const choice = (value.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw new Error("forced tool call was absent");
  }
  const call = message.tool_calls[0] as Record<string, unknown>;
  const fn = call.function as Record<string, unknown>;
  const args = JSON.parse(String(fn.arguments));
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("tool arguments were not a JSON object");
  }
}

function parseSse(value: string): Record<string, unknown>[] {
  const events = value.split(/\r?\n\r?\n/).filter((event) => event.trim());
  if (events.length === 0 || events.at(-1)?.trim() !== "data: [DONE]") {
    throw new Error("stream lacks terminal DONE");
  }
  return events.slice(0, -1).map((event) => {
    const lines = event.split(/\r?\n/);
    if (lines.some((line) => !line.startsWith("data:"))) {
      throw new Error("stream contains a non-data frame");
    }
    const data = lines.map((line) => line.slice(5).trimStart()).join("\n");
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("stream frame is not an object");
    }
    return parsed as Record<string, unknown>;
  });
}

function validateStableChunkTemplate(frames: Record<string, unknown>[]): void {
  if (frames.length === 0) throw new Error("stream contains no JSON frames");
  const id = frames[0]!.id;
  const model = frames[0]!.model;
  if (typeof id !== "string" || !id || typeof model !== "string" || !model) {
    throw new Error("stream template lacks id or model");
  }
  if (frames.some((frame) => frame.id !== id || frame.model !== model)) {
    throw new Error("stream template changed between frames");
  }
}

function completionText(value: Record<string, unknown>): string {
  validateCompletion(value);
  const choice = (value.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  return typeof message.content === "string" ? message.content : "";
}

function chatCompletionsUrl(provider: ProviderConfig): string {
  return `${provider.baseUrl.replace(/\/$/, "")}/v1/chat/completions`.replace("/v1/v1/", "/v1/");
}

function safeErrorClass(error: unknown): string {
  if (error instanceof ProviderError) return `ProviderError status ${error.status}`;
  if (error instanceof DOMException) return `DOMException ${error.name}`;
  return error instanceof Error ? error.name : "unknown error";
}

function argument(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index === -1 ? undefined : Deno.args[index + 1];
}

function printSummary(report: ConformanceReport, path: string): void {
  console.log(`Provider: ${report.provider.id} (${report.provider.kind})`);
  console.log(`Model: ${report.provider.model}`);
  for (const [name, result] of Object.entries(report.wire)) {
    console.log(`${result.passed ? "PASS" : "FAIL"} wire/${name}: ${result.detail}`);
  }
  console.log(
    `INFO behavior/surrogateFidelity: ${report.behavior.surrogateFidelity.detail}`,
  );
  console.log(`Report: ${path}`);
}

async function main(): Promise<void> {
  const providerId = argument("--provider");
  if (!providerId) {
    throw new Error("usage: deno task conformance -- --provider <id> [--config <path>]");
  }
  const configPath = argument("--config") ?? "config/egrysa.example.json";
  const read = await Deno.permissions.request({ name: "read", path: configPath });
  if (read.state !== "granted") {
    throw new Error(`read permission denied for provider config: ${configPath}`);
  }
  const config = await loadConfig(configPath);
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`provider not found in config: ${providerId}`);
  const host = new URL(provider.baseUrl).host;
  const net = await Deno.permissions.request({ name: "net", host });
  if (net.state !== "granted") {
    throw new Error(`network permission denied for provider host: ${host}`);
  }
  if (provider.apiKeyEnv) {
    const env = await Deno.permissions.request({ name: "env", variable: provider.apiKeyEnv });
    if (env.state !== "granted") {
      throw new Error(
        `environment permission denied for provider credential: ${provider.apiKeyEnv}`,
      );
    }
  }
  const report = await runConformance(
    provider,
    provider.allowedModels[0]!,
    config.requestTimeoutMs,
  );
  const date = report.generatedAt.slice(0, 10);
  const path = `evals/conformance/${provider.kind}-${date}.json`;
  await Deno.mkdir("evals/conformance", { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(report, null, 2)}\n`);
  printSummary(report, path);
  if (!report.summary.passed) Deno.exitCode = 1;
}

if (import.meta.main) await main();
