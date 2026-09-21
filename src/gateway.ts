import {
  toAnthropicError,
  toAnthropicMessage,
  toAnthropicStream,
  toChatRequest,
  validateAnthropicRequest,
} from "./anthropic_ingress.ts";
import { InboundAuth } from "./auth.ts";
import { BodySizeLimitError, readBoundedBytes } from "./bounded.ts";
import { inspectChat, transformChat } from "./chat.ts";
import {
  resolveNerDetectorConfig,
  resolveRateLimit,
  resolveSemanticDetectorConfig,
  resolveSurrogatePolicy,
  resolveWorkloadConfig,
} from "./config.ts";
import { createSurrogateState, prepareDurableSurrogates } from "./surrogate.ts";
import { RateLimiter } from "./ratelimit.ts";
import { OPTIONAL_DETECTOR_IDS } from "./classifier.ts";
import { createNerDetector, REFERENCE_NER_DETECTOR_ID } from "./ner.ts";
import { Metrics } from "./metrics.ts";
import { decide } from "./policy.ts";
import {
  invokeProvider,
  mapResponseContent,
  ProviderError,
  type ProviderInvocation,
} from "./providers.ts";
import { ReceiptStore } from "./receipts.ts";
import { Exporter, resolveExportConfig } from "./export.ts";
import { observeResponseText, scanResponse, UNSCANNED } from "./response.ts";
import { createDetectors } from "./classifier.ts";
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
  private readonly limiter = new RateLimiter();
  private exporter: Exporter | null = null;

  // Content-free events go to the log and, when configured, to the sink.
  private record(body: Record<string, unknown>): void {
    console.error(JSON.stringify(body));
    this.exporter?.event(body);
  }

  // A hold is cleared by naming the receipt this gateway issued for it, so an
  // acknowledgement cannot be forged by sending an arbitrary header value.
  private acknowledged(request: Request): boolean {
    const token = request.headers.get("x-egrysa-acknowledge")?.trim();
    if (!token || !this.pendingReviews.has(token)) return false;
    this.pendingReviews.delete(token);
    return true;
  }

  // Key material for workload-scoped surrogates; the same secret that keys
  // receipt fingerprints, so a deployment has one secret to rotate.
  private readonly surrogateSecret = Deno.env.get("EGRYSA_RECEIPT_FINGERPRINT_KEY") ?? "";

  private constructor(
    private readonly config: AppConfig,
    private readonly auth: InboundAuth,
    private readonly receipts: ReceiptStore,
  ) {}

  static async create(config: AppConfig): Promise<Gateway> {
    createSemanticDetector(config);
    createNerDetector(config);
    const auth = await InboundAuth.fromEnvironment();
    // A policy for a workload that has no inbound key is probably a typo.
    // It is not fatal, because keys and configuration are managed separately.
    const known = new Set(auth.workloadIds());
    for (const workloadId of Object.keys(config.workloads ?? {})) {
      if (!known.has(workloadId)) {
        console.error(JSON.stringify({
          level: "warn",
          event: "workload_policy_without_key",
          workloadId,
        }));
      }
    }
    // The exporter is attached after the store exists because it anchors the
    // store's checkpoints; the store's commit hook reaches it through a
    // closure so the order of construction does not matter to callers.
    let exporter: Exporter | null = null;
    const gateway = new Gateway(
      config,
      auth,
      await ReceiptStore.open({
        onCommitted: (receipt) => exporter?.receipt(receipt),
        fingerprintKey: Deno.env.get("EGRYSA_RECEIPT_FINGERPRINT_KEY") ?? "",
        privateKeyPkcs8: Deno.env.get("EGRYSA_RECEIPT_ED25519_PRIVATE_KEY") ?? "",
        publicKeySpki: Deno.env.get("EGRYSA_RECEIPT_ED25519_PUBLIC_KEY") ?? "",
        chainId: config.receiptChainId,
        logPath: config.receiptLogPath,
        capacity: config.receiptCapacity,
        maxLogBytes: config.receiptMaxLogBytes ?? 64 * 1024 * 1024,
      }),
    );
    const settings = resolveExportConfig(config);
    if (settings) {
      exporter = new Exporter(settings, () => gateway.receipts.checkpoint());
      gateway.exporter = exporter;
    }
    return gateway;
  }

  async close(): Promise<void> {
    await this.exporter?.close();
    await this.receipts.close();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/messages") {
      return await this.anthropic(request);
    }
    return await this.route(request, url);
  }

  // Anthropic Messages API ingress: the same pipeline, translated on the way
  // in and on the way out. The internal response is OpenAI-shaped; problems
  // are the gateway's problem documents.
  private async anthropic(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return this.anthropicProblem(problem(404, "not_found", "Route not found."));
    }
    const url = new URL(request.url);
    const internal = await this.route(request, url, "anthropic");
    const contentType = internal.headers.get("content-type") ?? "";
    if (internal.status >= 400 && contentType.includes("application/json")) {
      return this.anthropicProblem(internal);
    }
    if (contentType.includes("text/event-stream")) {
      const model = internal.headers.get("x-egrysa-model") ?? "";
      const headers = new Headers(internal.headers);
      headers.delete("x-egrysa-model");
      return new Response(toAnthropicStream(internal.body!, model), {
        status: internal.status,
        headers,
      });
    }
    if (contentType.includes("application/json")) {
      const data = await internal.json() as Record<string, unknown>;
      const headers = new Headers(internal.headers);
      headers.delete("x-egrysa-model");
      return new Response(JSON.stringify(toAnthropicMessage(data)), {
        status: internal.status,
        headers,
      });
    }
    return internal;
  }

  private async anthropicProblem(internal: Response): Promise<Response> {
    const body = await internal.json().catch(() => ({})) as Record<string, unknown>;
    const status = internal.status === 422 ? 400 : internal.status;
    const headers = new Headers(internal.headers);
    return new Response(JSON.stringify(toAnthropicError(status, body)), { status, headers });
  }

  private async route(
    request: Request,
    url: URL,
    ingress: "openai" | "anthropic" = "openai",
  ): Promise<Response> {
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
    if (request.method === "GET" && url.pathname === "/readyz") {
      return json({ status: "ready" });
    }
    const auth = await this.auth.authorize(request.headers.get("authorization"));
    if (!auth) {
      return problem(401, "unauthorized", "A valid gateway bearer token is required.");
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      if (this.exporter) {
        this.metrics.exportSent = this.exporter.stats.sent;
        this.metrics.exportDropped = this.exporter.stats.dropped;
        this.metrics.exportFailedBatches = this.exporter.stats.failedBatches;
        this.metrics.exportQueued = this.exporter.stats.queued;
      }
      return new Response(this.metrics.render(), {
        headers: { "content-type": "text/plain; version=0.0.4", ...securityHeaders() },
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/receipts/")) {
      if (url.pathname === "/v1/receipts/checkpoint") return json(await this.receipts.checkpoint());
      if (url.pathname === "/v1/receipts/public-key") return json(this.receipts.publicKeyInfo());
      const receipt = this.receipts.get(url.pathname.slice("/v1/receipts/".length));
      // A caller sees only its own workload's receipts; an auditor sees all.
      return receipt && (auth.role === "auditor" || receipt.workloadId === auth.workloadId)
        ? json(receipt)
        : problem(404, "not_found", "Receipt not found.");
    }
    if (auth.role === "auditor") {
      return problem(403, "forbidden", "Auditor keys are read-only.");
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return this.models(auth.workloadId);
    }
    const chatRoute = ingress === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
    if (request.method !== "POST" || url.pathname !== chatRoute) {
      return problem(404, "not_found", "Route not found.");
    }
    return await this.chat(request, auth.workloadId, ingress);
  }

  private async chat(
    request: Request,
    workloadId: string,
    ingress: "openai" | "anthropic" = "openai",
  ): Promise<Response> {
    // Everything below decides against the workload's effective policy.
    const config = resolveWorkloadConfig(this.config, workloadId);
    const workload = this.config.workloads?.[workloadId];
    const limit = resolveRateLimit(config.policy);
    if (limit) {
      const waitMs = this.limiter.take(workloadId, limit);
      if (waitMs > 0) {
        this.metrics.rateLimited++;
        this.exporter?.event({ level: "info", event: "rate_limited", workloadId });
        const response = problem(
          429,
          "rate_limited",
          "This workload has exceeded its request rate.",
        );
        response.headers.set("retry-after", String(Math.max(1, Math.ceil(waitMs / 1000))));
        return response;
      }
    }
    this.metrics.requests++;
    this.metrics.inFlight++;
    let receiptId: string | undefined;
    let providerInvocationFailed = false;
    try {
      const raw = await readJson(request, this.config.maxRequestBytes);
      let body: unknown = raw;
      if (ingress === "anthropic") {
        const refusal = validateAnthropicRequest(raw);
        if (refusal) return problem(422, "unsupported_request", refusal);
        body = toChatRequest(raw as never);
      }
      const validation = validateChat(body);
      if (validation) return problem(422, "unsupported_request", validation);
      const chat = body as ChatRequest;
      if (workload?.allowedModels && !workload.allowedModels.includes(chat.model)) {
        return problem(422, "unsupported_request", "model is not approved for this workload");
      }
      const originalJson = JSON.stringify(chat);
      const inspection = await inspectChat(chat, config);
      const findings = inspection.findings;
      const detectorReceipt = this.recordDetectorEvidence(inspection);
      if (this.requiredDetectorUnavailable(inspection)) {
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
          "A required local detector was unavailable.",
          receipt.id,
        );
      }
      const requestedProvider = request.headers.get("x-egrysa-provider");
      let policy = decide(findings, requestedProvider, config);
      if (
        workload?.allowedProviders && policy.provider &&
        !workload.allowedProviders.includes(policy.provider.id)
      ) {
        policy = {
          decision: "deny",
          provider: null,
          reason: "provider is not approved for this workload",
        };
      }
      const untransformableTransformFindings = inspection.untransformableFindings.filter((
        finding,
      ) => config.policy.transformKinds.includes(finding.kind));
      if (
        policy.decision === "transform" && untransformableTransformFindings.length > 0 &&
        untransformableTransformFindings.every((finding) =>
          finding.precision !== undefined && finding.precision !== "high"
        )
      ) {
        const localProvider = config.providers.find((provider) =>
          provider.id === config.policy.localProvider && provider.local
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
        const allowed = new Set(config.policy.transformKinds);
        const surrogates = resolveSurrogatePolicy(config.policy);
        const state = createSurrogateState(surrogates.style);
        if (surrogates.scope === "workload") {
          await prepareDurableSurrogates(state, inspection.findings, allowed, {
            secret: this.surrogateSecret,
            workloadId,
          });
        }
        const transformed = transformChat(chat, inspection, allowed, state);
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
        const receipt = await this.receipts.create({
          ...receiptContext,
          egress: "failed",
          response: UNSCANNED,
        });
        receiptId = receipt.id;
        providerInvocationFailed = true;
        throw error;
      }
      // Response scanning runs before the receipt is signed and before
      // recomposition, so the receipt records what the provider sent back and
      // the customer's own restored values are never counted.
      const detectors = createDetectors(config);
      const scan = invocation.type === "stream"
        ? null
        : await scanResponse(invocation.data, config, detectors, aggregateMap);
      if (scan) this.recordResponseScan(scan.evidence);
      const receipt = await this.receipts.create({
        ...receiptContext,
        egress: invocation.type === "stream" && !invocation.emulated ? "started" : "completed",
        response: scan ? scan.evidence : UNSCANNED,
      });
      receiptId = receipt.id;
      if (scan?.denied) {
        return problem(
          403,
          "response_denied",
          "The provider response contained data in a blocked class.",
          receipt.id,
        );
      }
      if (invocation.type === "stream") {
        // A stream's receipt is already signed, so the text that passes is
        // observed and recorded in metrics and a content-free log event.
        let observed = "";
        const limit = this.config.maxResponseBytes ?? 32 * 1024 * 1024;
        const stream = recomposeOpenAiStream(
          invocation.response.body!,
          aggregateMap,
          (error) => {
            if (error instanceof RecompositionError) this.metrics.recompositionFailures++;
            else this.metrics.providerErrors++;
          },
          () => {
            invocation.complete();
            void this.observeStream(observed, detectors, receipt.id, config, aggregateMap);
          },
          (text) => {
            if (observed.length < limit) observed += text;
          },
        );
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
            "x-egrysa-receipt": receipt.id,
            "x-egrysa-decision": policy.decision,
            ...(ingress === "anthropic" ? { "x-egrysa-model": chat.model } : {}),
            ...downgradeHeaders(invocation.downgraded),
            ...securityHeaders(),
          },
        });
      }
      let residueDetected = false;
      const recomposed = mapResponseContent(scan!.data, (text) => {
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

  private models(workloadId: string): Response {
    const workload = this.config.workloads?.[workloadId];
    const seen = new Set<string>();
    const data = this.config.providers
      .filter((provider) =>
        !workload?.allowedProviders || workload.allowedProviders.includes(provider.id)
      )
      .flatMap((provider) =>
        provider.allowedModels.filter((model) => {
          if (seen.has(model)) return false;
          if (workload?.allowedModels && !workload.allowedModels.includes(model)) return false;
          seen.add(model);
          return true;
        }).map((id) => ({ id, object: "model", created: 0, owned_by: "egrysa" }))
      );
    return json({ object: "list", data });
  }

  private recordResponseScan(
    evidence: { findingCounts: Record<string, number | undefined>; action: string },
  ): void {
    const total = Object.values(evidence.findingCounts).reduce<number>(
      (sum, n) => sum + (n ?? 0),
      0,
    );
    this.metrics.responseFindings += total;
    if (evidence.action === "redacted") this.metrics.responseRedactions++;
    if (evidence.action === "denied") this.metrics.responseDenials++;
  }

  private async observeStream(
    text: string,
    detectors: ReturnType<typeof createDetectors>,
    receiptId: string,
    config: AppConfig,
    surrogates: ReadonlyMap<string, string>,
  ): Promise<void> {
    try {
      const counts = await observeResponseText(text, config, detectors, surrogates);
      const total = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
      if (total === 0) return;
      this.metrics.responseFindings += total;
      this.record({
        level: "warn",
        event: "stream_response_findings",
        receiptId,
        findingCounts: counts,
      });
    } catch {
      // Observation is best effort; a detector failure here changes nothing
      // the caller already received.
    }
  }

  // Each optional detector carries its own failure mode. A request is refused
  // only when a detector that failed is one the operator configured to deny on.
  private requiredDetectorUnavailable(
    inspection: Awaited<ReturnType<typeof inspectChat>>,
  ): boolean {
    const failed = new Set(
      inspection.detectorExecutions.filter((e) => e.failureClass !== undefined).map((e) => e.id),
    );
    return (failed.has(REFERENCE_SEMANTIC_DETECTOR_ID) &&
      resolveSemanticDetectorConfig(this.config).onDetectorFailure === "deny") ||
      (failed.has(REFERENCE_NER_DETECTOR_ID) &&
        resolveNerDetectorConfig(this.config).onDetectorFailure === "deny");
  }

  private recordDetectorEvidence(
    inspection: Awaited<ReturnType<typeof inspectChat>>,
  ): { detectors?: ReceiptDetector[]; detectorDegraded?: boolean } {
    const modelDetectorEnabled = resolveSemanticDetectorConfig(this.config).enabled ||
      resolveNerDetectorConfig(this.config).enabled;
    for (
      const execution of inspection.detectorExecutions.filter((candidate) =>
        OPTIONAL_DETECTOR_IDS.has(candidate.id)
      )
    ) {
      this.metrics.recordDetectorRun(
        execution.latencyMs,
        execution.failureClass,
      );
      if (execution.failureClass !== undefined) {
        this.record({
          level: "warn",
          event: "detector_degraded",
          detectorId: execution.id,
          errorClass: execution.failureClass,
        });
      }
    }
    if (!inspection.detectorDegraded) {
      this.metrics.semanticFindings += inspection.findings.filter((finding) =>
        finding.detectorId !== undefined && OPTIONAL_DETECTOR_IDS.has(finding.detectorId)
      ).length;
    }
    if (!modelDetectorEnabled) return {};
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
