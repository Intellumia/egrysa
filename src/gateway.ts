import { InboundAuth } from "./auth.ts";
import { BodySizeLimitError, readBoundedBytes } from "./bounded.ts";
import { inspectChat, transformChat } from "./chat.ts";
import { resolveSemanticDetectorConfig } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { decide } from "./policy.ts";
import {
  invokeProvider,
  mapResponseContent,
  ProviderError,
  type ProviderInvocation,
} from "./providers.ts";
import { ReceiptStore } from "./receipts.ts";
import { recomposeOpenAiStream, RecompositionError } from "./streaming.ts";
import { hasSurrogateResidueAfterRecomposition, recomposeChecked } from "./surrogate.ts";
import { createSemanticDetector, REFERENCE_SEMANTIC_DETECTOR_ID } from "./semantic.ts";
import type { AppConfig, ChatRequest, ReceiptDetector } from "./types.ts";

// Receipt identifiers for requests held under review sensitivity. Held in
// memory only: a restart clears them, and the caller simply receives a fresh
// hold on the next attempt.
const MAX_PENDING_REVIEWS = 1024;

export class Gateway {
  readonly metrics = new Metrics();
  private readonly pendingReviews = new Set<string>();

  // A hold is cleared by naming the receipt this gateway issued for it, so an
  // acknowledgement cannot be forged by sending an arbitrary header value.
  private acknowledged(request: Request): boolean {
    const token = request.headers.get("x-egrysa-acknowledge")?.trim();
    if (!token || !this.pendingReviews.has(token)) return false;
    this.pendingReviews.delete(token);
    return true;
  }

  private constructor(
    private readonly config: AppConfig,
    private readonly auth: InboundAuth,
    private readonly receipts: ReceiptStore,
  ) {}

  static async create(config: AppConfig): Promise<Gateway> {
    createSemanticDetector(config);
    return new Gateway(
      config,
      await InboundAuth.fromEnvironment(),
      await ReceiptStore.open({
        fingerprintKey: Deno.env.get("EGRYSA_RECEIPT_FINGERPRINT_KEY") ?? "",
        privateKeyPkcs8: Deno.env.get("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY") ?? "",
        publicKeySpki: Deno.env.get("EGRYSA_RECEIPT_ED25519_PUBLIC_KEY") ?? "",
        chainId: config.receiptChainId,
        logPath: config.receiptLogPath,
        capacity: config.receiptCapacity,
        maxLogBytes: config.receiptMaxLogBytes ?? 64 * 1024 * 1024,
      }),
    );
  }

  close(): Promise<void> {
    return this.receipts.close();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") {
      return json({ status: "ready" });
    }
    const auth = await this.auth.authorize(request.headers.get("authorization"));
    if (!auth) {
      return problem(401, "unauthorized", "A valid gateway bearer token is required.");
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      return new Response(this.metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4", ...securityHeaders() },
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/receipts/")) {
      if (url.pathname === "/v1/receipts/checkpoint") return json(await this.receipts.checkpoint());
      if (url.pathname === "/v1/receipts/public-key") return json(this.receipts.publicKeyInfo());
      const receipt = this.receipts.get(url.pathname.slice("/v1/receipts/".length));
      return receipt?.workloadId === auth.workloadId
        ? json(receipt)
        : problem(404, "not_found", "Receipt not found.");
    }
    if (request.method === "GET" && url.pathname === "/v1/models") return this.models();
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return problem(404, "not_found", "Route not found.");
    }
    return await this.chat(request, auth.workloadId);
  }

  private async chat(request: Request, workloadId: string): Promise<Response> {
    this.metrics.requests++;
    this.metrics.inFlight++;
    let receiptId: string | undefined;
    let providerInvocationFailed = false;
    try {
      const body = await readJson(request, this.config.maxRequestBytes);
      const validation = validateChat(body);
      if (validation) return problem(422, "unsupported_request", validation);
      const chat = body as ChatRequest;
      const originalJson = JSON.stringify(chat);
      const inspection = await inspectChat(chat, this.config);
      const findings = inspection.findings;
      const detectorReceipt = this.recordDetectorEvidence(inspection);
      const semantic = resolveSemanticDetectorConfig(this.config);
      if (inspection.detectorDegraded && semantic.onDetectorFailure === "deny") {
        this.metrics.denied++;
        const receipt = await this.receipts.create({
          requestCanonical: originalJson,
          workloadId,
          decision: "deny",
          provider: null,
          model: chat.model,
          findings,
          transformedFields: 0,
          ...detectorReceipt,
        });
        return problem(
          403,
          "policy_denied",
          "The required local semantic detector was unavailable.",
          receipt.id,
        );
      }
      const requestedProvider = request.headers.get("x-egrysa-provider");
      let policy = decide(findings, requestedProvider, this.config);
      const untransformableTransformFindings = inspection.untransformableFindings.filter((
        finding,
      ) => this.config.policy.transformKinds.includes(finding.kind));
      if (
        policy.decision === "transform" && untransformableTransformFindings.length > 0 &&
        untransformableTransformFindings.every((finding) =>
          finding.precision !== undefined && finding.precision !== "high"
        )
      ) {
        const localProvider = this.config.providers.find((provider) =>
          provider.id === this.config.policy.localProvider && provider.local
        ) ?? null;
        policy = localProvider
          ? {
            decision: "local_only",
            provider: localProvider,
            reason: "untransformable semantic candidate routed to local inference",
          }
          : { decision: "deny", provider: null, reason: "local provider is not configured" };
      }
      if (policy.decision === "deny" || !policy.provider) {
        this.metrics.denied++;
        const receipt = await this.receipts.create({
          requestCanonical: originalJson,
          workloadId,
          decision: "deny",
          provider: null,
          model: chat.model,
          findings,
          transformedFields: 0,
          ...detectorReceipt,
        });
        return problem(403, "policy_denied", policy.reason, receipt.id);
      }

      if (policy.reviewRequired && !this.acknowledged(request)) {
        this.metrics.denied++;
        const receipt = await this.receipts.create({
          requestCanonical: originalJson,
          workloadId,
          decision: "deny",
          provider: null,
          model: chat.model,
          findings,
          transformedFields: 0,
          ...detectorReceipt,
        });
        this.pendingReviews.add(receipt.id);
        // Bounded so a stream of held requests cannot grow memory without limit.
        if (this.pendingReviews.size > MAX_PENDING_REVIEWS) {
          const oldest = this.pendingReviews.values().next();
          if (!oldest.done) this.pendingReviews.delete(oldest.value);
        }
        return problem(
          409,
          "review_required",
          "A low-precision finding in a blocked data class needs a human decision. " +
            "Retry with the x-egrysa-acknowledge header set to this receipt id to proceed.",
          receipt.id,
        );
      }

      if (
        policy.decision === "transform" &&
        untransformableTransformFindings.length > 0
      ) {
        this.metrics.denied++;
        const receipt = await this.receipts.create({
          requestCanonical: originalJson,
          workloadId,
          decision: "deny",
          provider: null,
          model: chat.model,
          findings,
          transformedFields: 0,
          ...detectorReceipt,
        });
        return problem(
          403,
          "policy_denied",
          "Sensitive data in a structural tool field cannot be transformed safely.",
          receipt.id,
        );
      }

      let outbound = structuredClone(chat);
      let aggregateMap = new Map<string, string>();
      let transformedFields = 0;
      if (policy.decision === "transform") {
        const allowed = new Set(this.config.policy.transformKinds);
        const transformed = transformChat(chat, inspection, allowed);
        outbound = transformed.chat;
        aggregateMap = transformed.mapping;
        transformedFields = transformed.transformedFields;
        this.metrics.transformed++;
      }

      const receiptContext = {
        requestCanonical: originalJson,
        workloadId,
        decision: policy.decision,
        provider: policy.provider.id,
        model: chat.model,
        findings,
        transformedFields,
        ...detectorReceipt,
      };
      let invocation: ProviderInvocation;
      try {
        invocation = await invokeProvider(
          policy.provider,
          outbound,
          this.config.requestTimeoutMs,
          this.config.maxResponseBytes ?? 32 * 1024 * 1024,
        );
      } catch (error) {
        const receipt = await this.receipts.create({ ...receiptContext, egress: "failed" });
        receiptId = receipt.id;
        providerInvocationFailed = true;
        throw error;
      }
      const receipt = await this.receipts.create({
        ...receiptContext,
        egress: invocation.type === "stream" && !invocation.emulated ? "started" : "completed",
      });
      receiptId = receipt.id;
      if (invocation.type === "stream") {
        const stream = recomposeOpenAiStream(
          invocation.response.body!,
          aggregateMap,
          (error) => {
            if (error instanceof RecompositionError) this.metrics.recompositionFailures++;
            else this.metrics.providerErrors++;
          },
          invocation.complete,
        );
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
            "x-egrysa-receipt": receipt.id,
            "x-egrysa-decision": policy.decision,
            ...downgradeHeaders(invocation.downgraded),
            ...securityHeaders(),
          },
        });
      }
      let residueDetected = false;
      const recomposed = mapResponseContent(invocation.data, (text) => {
        const result = recomposeChecked(text, aggregateMap);
        residueDetected ||= result.residueDetected;
        return result.text;
      });
      residueDetected ||= hasSurrogateResidueAfterRecomposition(
        JSON.stringify(recomposed),
        aggregateMap,
      );
      if (residueDetected) {
        this.metrics.recompositionFailures++;
        return problem(
          502,
          "recomposition_failed",
          "The provider response could not be safely recomposed.",
          receipt.id,
        );
      }
      return json(recomposed, 200, {
        "x-egrysa-receipt": receipt.id,
        "x-egrysa-decision": policy.decision,
        ...downgradeHeaders(invocation.downgraded),
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        this.metrics.providerErrors++;
        return problem(error.status, "provider_error", error.message, receiptId);
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        return problem(
          504,
          "provider_timeout",
          "The provider exceeded the configured deadline.",
          receiptId,
        );
      }
      if (error instanceof RequestError) {
        return problem(error.status, "invalid_request", error.message);
      }
      if (providerInvocationFailed) {
        this.metrics.providerErrors++;
        return problem(
          502,
          "provider_error",
          "The provider invocation failed.",
          receiptId,
        );
      }
      console.error(
        JSON.stringify({
          level: "error",
          event: "request_failed",
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      return problem(500, "internal_error", "The request failed inside the gateway.");
    } finally {
      this.metrics.inFlight--;
    }
  }

  private models(): Response {
    const seen = new Set<string>();
    const data = this.config.providers.flatMap((provider) =>
      provider.allowedModels.filter((model) => {
        if (seen.has(model)) return false;
        seen.add(model);
        return true;
      }).map((id) => ({ id, object: "model", created: 0, owned_by: "egrysa" }))
    );
    return json({ object: "list", data });
  }

  private recordDetectorEvidence(
    inspection: Awaited<ReturnType<typeof inspectChat>>,
  ): { detectors?: ReceiptDetector[]; detectorDegraded?: boolean } {
    const semanticEnabled = resolveSemanticDetectorConfig(this.config).enabled;
    for (
      const execution of inspection.detectorExecutions.filter((candidate) =>
        candidate.id === REFERENCE_SEMANTIC_DETECTOR_ID
      )
    ) {
      this.metrics.recordDetectorRun(
        execution.latencyMs,
        execution.failureClass,
      );
      if (execution.failureClass !== undefined) {
        console.error(JSON.stringify({
          level: "warn",
          event: "detector_degraded",
          detectorId: execution.id,
          errorClass: execution.failureClass,
        }));
      }
    }
    if (!inspection.detectorDegraded) {
      this.metrics.semanticFindings += inspection.findings.filter((finding) =>
        finding.detectorId === REFERENCE_SEMANTIC_DETECTOR_ID
      ).length;
    }
    if (!semanticEnabled) return {};
    return {
      detectors: inspection.detectorExecutions.map((execution) => ({
        id: execution.id,
        version: execution.version,
      })),
      detectorDegraded: inspection.detectorDegraded,
    };
  }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(request, maxBytes);
  } catch (error) {
    if (error instanceof BodySizeLimitError) {
      throw new RequestError(413, "Request exceeds the configured size limit.");
    }
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestError(400, "Request body must be valid JSON.");
  }
}

function validateChat(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Body must be an object.";
  const body = value as Partial<ChatRequest>;
  const allowedRequestFields = new Set([
    "model",
    "messages",
    "stream",
    "temperature",
    "max_tokens",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream_options",
  ]);
  if (Object.keys(body).some((key) => !allowedRequestFields.has(key))) {
    return "Request contains unsupported fields.";
  }
  if (typeof body.model !== "string" || !body.model || body.model.length > 256) {
    return "model must contain 1 to 256 characters.";
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 256) {
    return "messages must contain 1 to 256 items.";
  }
  for (const message of body.messages) {
    if (
      !message || typeof message !== "object" || Array.isArray(message) ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    ) return "Only text and tool chat messages are supported.";
    if (
      Object.keys(message).some((key) =>
        !["role", "content", "name", "tool_call_id", "tool_calls"].includes(key)
      )
    ) {
      return "A message contains unsupported fields.";
    }
    if (message.name !== undefined && !validName(message.name)) return "A message name is invalid.";
    if (message.role === "tool") {
      if (typeof message.content !== "string" || !validOpaqueId(message.tool_call_id)) {
        return "Tool messages require text content and a valid tool_call_id.";
      }
      if (message.tool_calls !== undefined) return "Tool messages cannot contain tool_calls.";
    } else if (message.role === "assistant") {
      if (message.content !== null && typeof message.content !== "string") {
        return "Assistant content must be text or null.";
      }
      if (message.tool_call_id !== undefined) return "Assistant messages cannot use tool_call_id.";
      if (message.tool_calls !== undefined && !validToolCalls(message.tool_calls)) {
        return "Assistant tool_calls are invalid.";
      }
      if (message.content === null && !message.tool_calls?.length) {
        return "Assistant messages require content or tool_calls.";
      }
    } else if (
      typeof message.content !== "string" || message.tool_call_id !== undefined ||
      message.tool_calls !== undefined
    ) return "System and user messages require text content.";
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return "stream must be boolean.";
  }
  if (!optionalNumberInRange(body.temperature, 0, 2)) {
    return "temperature must be a finite number between 0 and 2.";
  }
  if (!optionalIntegerInRange(body.max_tokens, 1, 1_000_000)) {
    return "max_tokens must be an integer between 1 and 1000000.";
  }
  if (!optionalNumberInRange(body.top_p, 0, 1)) {
    return "top_p must be a finite number between 0 and 1.";
  }
  if (!optionalNumberInRange(body.frequency_penalty, -2, 2)) {
    return "frequency_penalty must be a finite number between -2 and 2.";
  }
  if (!optionalNumberInRange(body.presence_penalty, -2, 2)) {
    return "presence_penalty must be a finite number between -2 and 2.";
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) {
    return "seed must be a safe integer.";
  }
  if (body.tools !== undefined && !validTools(body.tools)) return "tools are invalid.";
  if (body.tool_choice !== undefined && !validToolChoice(body.tool_choice)) {
    return "tool_choice is invalid.";
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") {
    return "parallel_tool_calls must be boolean.";
  }
  if (body.stream_options !== undefined) {
    if (
      !body.stream || !isRecord(body.stream_options) ||
      Object.keys(body.stream_options).some((key) => key !== "include_usage") ||
      (body.stream_options.include_usage !== undefined &&
        typeof body.stream_options.include_usage !== "boolean")
    ) return "stream_options requires streaming and only supports include_usage.";
  }
  return null;
}

function validToolCalls(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 &&
    value.every((call) =>
      isRecord(call) && Object.keys(call).every((key) =>
        ["id", "type", "function"].includes(key)
      ) &&
      validOpaqueId(call.id) && call.type === "function" && isRecord(call.function) &&
      Object.keys(call.function).every((key) => ["name", "arguments"].includes(key)) &&
      validName(call.function.name) && typeof call.function.arguments === "string" &&
      validJsonObject(call.function.arguments)
    );
}

function validTools(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 128 &&
    value.every((tool) =>
      isRecord(tool) && Object.keys(tool).every((key) => ["type", "function"].includes(key)) &&
      tool.type === "function" && isRecord(tool.function) &&
      Object.keys(tool.function).every((key) =>
        ["name", "description", "parameters", "strict"].includes(key)
      ) && validName(tool.function.name) &&
      (tool.function.description === undefined || typeof tool.function.description === "string") &&
      (tool.function.parameters === undefined || isJsonObject(tool.function.parameters)) &&
      (tool.function.strict === undefined || typeof tool.function.strict === "boolean")
    );
}

function validToolChoice(value: unknown): boolean {
  if (["none", "auto", "required"].includes(String(value))) return typeof value === "string";
  return isRecord(value) && Object.keys(value).every((key) => ["type", "function"].includes(key)) &&
    value.type === "function" && isRecord(value.function) &&
    Object.keys(value.function).every((key) => key === "name") && validName(value.function.name);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validJsonObject(value: string): boolean {
  try {
    return isJsonObject(JSON.parse(value));
  } catch {
    return false;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isJsonValue(value);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || ["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalNumberInRange(value: unknown, min: number, max: number): boolean {
  return value === undefined ||
    (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function optionalIntegerInRange(value: unknown, min: number, max: number): boolean {
  return optionalNumberInRange(value, min, max) &&
    (value === undefined || Number.isSafeInteger(value));
}

function securityHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  };
}

function downgradeHeaders(fields: string[]): HeadersInit {
  return fields.length === 0 ? {} : { "x-egrysa-downgraded": fields.join(",") };
}

function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...securityHeaders(), ...extra },
  });
}

function problem(status: number, code: string, detail: string, receiptId?: string): Response {
  return json({
    type: `urn:egrysa:error:${code}`,
    title: code,
    status,
    detail,
    ...(receiptId ? { receiptId } : {}),
  }, status);
}
