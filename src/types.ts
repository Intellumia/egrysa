export const FINDING_KINDS = [
  "email",
  "phone",
  "ipv4",
  "iban",
  "ssn",
  "credit_card",
  "private_key",
  "api_secret",
  "confidential_term",
  "person_name",
  "physical_address",
  "semantic_confidential",
  // Added in 0.1.0-alpha.5. Every kind needs exactly one policy action, so a
  // configuration written for an earlier release must list these before it
  // starts; the startup error names the missing kind.
  "ipv6",
  "mac_address",
  "date_of_birth",
  "aadhaar",
  "india_pan",
  "uk_nino",
  "nhs_number",
  "passport",
  "bank_account",
  "crypto_wallet",
  "vin",
  "organization",
  // A request that tries to redirect the model. Found by the local NER
  // sidecar's classifier, low precision by construction, so the sensitivity
  // switch decides: balanced routes it to local inference, strict denies,
  // review holds it for a person. Request-side only.
  "prompt_injection",
] as const;

export type FindingKind = typeof FINDING_KINDS[number];

export const SEMANTIC_FINDING_KINDS = [
  "person_name",
  "physical_address",
  "semantic_confidential",
] as const satisfies readonly FindingKind[];

export type SemanticFindingKind = typeof SEMANTIC_FINDING_KINDS[number];

export type Decision = "allow_raw" | "transform" | "local_only" | "deny";

// How a low-precision finding in a blocked data class is handled. A
// high-precision finding always denies, in every mode.
//
//   strict   deny, accepting that a false positive blocks legitimate work
//   balanced route to local inference, the shipped default
//   review   hold the request and let a person decide
export const SENSITIVITIES = ["strict", "balanced", "review"] as const;

export type Sensitivity = typeof SENSITIVITIES[number];

export interface Finding {
  kind: FindingKind;
  start: number;
  end: number;
  value: string;
  label?: string;
  detectorId?: string;
  confidence?: number;
  precision?: "high" | "medium" | "low";
}

export interface DataPolicy {
  training: "disabled" | "enabled" | "unknown";
  retention: "none" | "standard" | "unknown";
  allowRaw: boolean;
}

export const PROVIDER_CAPABILITY_KEYS = [
  "temperature",
  "max_tokens",
  "seed",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "stream",
  "stream_options",
] as const;

export type ProviderCapabilityKey = typeof PROVIDER_CAPABILITY_KEYS[number];
export type ProviderCapabilities = Record<ProviderCapabilityKey, boolean>;
export type ProviderCapabilityOverrides = Partial<Record<ProviderCapabilityKey, boolean>>;

export const PROVIDER_KINDS = [
  "openai",
  "anthropic",
  "openai-compatible",
  "azure-openai",
  "bedrock",
  "vertex",
] as const;

export interface ProviderConfig {
  id: string;
  kind: typeof PROVIDER_KINDS[number];
  baseUrl: string;
  // Name of the environment variable holding the bearer credential: the API
  // key for openai, anthropic, openai-compatible, and azure-openai; a Bedrock
  // API key for bedrock; an OAuth access token for vertex.
  apiKeyEnv?: string;
  allowedModels: string[];
  local?: boolean;
  capabilities?: ProviderCapabilityOverrides;
  dataPolicy: DataPolicy;
  // azure-openai: the deployment name and API version the endpoint expects.
  deployment?: string;
  apiVersion?: string;
  // bedrock and vertex: the region; vertex also needs the project.
  region?: string;
  project?: string;
  // bedrock: IAM credentials as environment variable names, signed with
  // Signature Version 4. Used when apiKeyEnv is absent.
  credentialsEnv?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  // vertex: environment variable holding a service-account key JSON, exchanged
  // for access tokens. Used when apiKeyEnv is absent. tokenUrl overrides the
  // account's token endpoint, for tests.
  serviceAccountEnv?: string;
  tokenUrl?: string;
}

export interface SemanticDetectorConfig {
  enabled: boolean;
  providerId?: string;
  model?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxInputBytes?: number;
  onDetectorFailure?: "degrade" | "deny";
  kinds?: SemanticFindingKind[];
}

export const NER_FINDING_KINDS = [
  "person_name",
  "physical_address",
  "organization",
  "prompt_injection",
] as const;

export type NerFindingKind = typeof NER_FINDING_KINDS[number];

export interface NerDetectorConfig {
  enabled: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxInputBytes?: number;
  minConfidence?: number;
  onDetectorFailure?: "degrade" | "deny";
  kinds?: NerFindingKind[];
}

export interface AppConfig {
  // Configuration schema version; absent means 1. See docs/COMPATIBILITY.md.
  schemaVersion?: 1;
  listen: { hostname: string; port: number };
  maxRequestBytes: number;
  maxResponseBytes?: number;
  requestTimeoutMs: number;
  receiptCapacity: number;
  receiptLogPath: string;
  receiptMaxLogBytes?: number;
  receiptChainId: string;
  // Where receipts are signed; local (default) or a remote signing service. See src/signer.ts.
  receiptSigner?: { kind: "local" } | {
    kind: "remote";
    url: string;
    headersEnv?: string;
    timeoutMs?: number;
  };
  providers: ProviderConfig[];
  semanticDetector?: SemanticDetectorConfig;
  nerDetector?: NerDetectorConfig;
  policy: {
    defaultProvider: string;
    localProvider: string;
    blockKinds: FindingKind[];
    localOnlyKinds: FindingKind[];
    transformKinds: FindingKind[];
    sensitiveTerms: Array<{ term: string; label: string }>;
    sensitivity?: Sensitivity;
    // What to do with sensitive data the provider sends back. Findings are
    // made before recomposition, so they are provider-originated.
    response?: ResponsePolicyConfig;
    // How transformable values are replaced before egress. Style: a sentinel
    // token, or a synthetic value in the same shape. Scope: fresh per request,
    // or the same surrogate for the same value across a workload's requests,
    // derived by keyed hash and never stored.
    surrogates?: SurrogatePolicyConfig;
    // Requests per minute a workload may submit, with an optional burst
    // (default: the per-minute rate). Absent means unlimited by the gateway.
    rateLimit?: RateLimitConfig;
  };
  // OpenID Connect bearer tokens as an alternative to static keys; see src/oidc.ts.
  oidc?: {
    issuer: string;
    audience: string;
    jwksUrl?: string;
    workloadClaim?: string;
    roleClaim?: string;
    auditorRole?: string;
    clockSkewSeconds?: number;
    jwksTtlSeconds?: number;
  };
  // Evidence export to a SIEM or OpenTelemetry collector; see src/export.ts.
  export?: {
    url: string;
    format?: "jsonl" | "otlp";
    headersEnv?: string;
    batchSize?: number;
    flushIntervalMs?: number;
    queueCapacity?: number;
    checkpointEveryReceipts?: number;
    timeoutMs?: number;
  };
  // Per-workload overrides keyed by the workload id an inbound key carries.
  // Each override replaces the fields it names and inherits the rest; the
  // merged policy is validated at startup under the same rules as the global
  // one, so a workload can never end up with an unassigned data class.
  workloads?: Record<string, WorkloadPolicy>;
}

export interface WorkloadPolicy {
  blockKinds?: FindingKind[];
  localOnlyKinds?: FindingKind[];
  transformKinds?: FindingKind[];
  sensitiveTerms?: Array<{ term: string; label: string }>;
  sensitivity?: Sensitivity;
  response?: ResponsePolicyConfig;
  rateLimit?: RateLimitConfig;
  surrogates?: SurrogatePolicyConfig;
  defaultProvider?: string;
  // Providers this workload may use, by id. A request naming another
  // provider, or a default outside the list, is refused.
  allowedProviders?: string[];
  // Models this workload may request, across providers.
  allowedModels?: string[];
}

export type SurrogateStyle = "token" | "synthetic";
export type SurrogateScope = "request" | "workload";

export interface SurrogatePolicyConfig {
  style?: SurrogateStyle;
  scope?: SurrogateScope;
}

export interface RateLimitConfig {
  requestsPerMinute: number;
  burst?: number;
}

export interface ResponsePolicyConfig {
  scan?: boolean;
  blocked?: "redact" | "deny";
  transformable?: "pass" | "redact";
}

export type ResponseAction = "none" | "redacted" | "denied" | "unscanned";

export interface ResponseEvidence {
  findingCounts: Partial<Record<FindingKind, number>>;
  action: ResponseAction;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonObject;
    strict?: boolean;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  tools?: ChatTool[];
  tool_choice?: "none" | "auto" | "required" | {
    type: "function";
    function: { name: string };
  };
  parallel_tool_calls?: boolean;
  stream_options?: { include_usage?: boolean };
}

export interface ReceiptDetector {
  id: string;
  version: string;
}

interface PrivacyReceiptBase {
  id: string;
  chainId: string;
  sequence: number;
  timestamp: string;
  workloadId: string;
  requestFingerprint: string;
  decision: Decision;
  provider: string | null;
  model: string;
  findingCounts: Partial<Record<FindingKind, number>>;
  transformedFields: number;
  rawContentPersisted: false;
  providerStoreRequested: false;
  previousReceiptHash: string | null;
  receiptHash: string;
  signingKeyId: string;
  signature: string;
}

export interface PrivacyReceiptV2 extends PrivacyReceiptBase {
  version: "2";
}

export interface PrivacyReceiptV3 extends PrivacyReceiptBase {
  version: "3";
  detectors: ReceiptDetector[];
  detectorDegraded: boolean;
}

export type EgressOutcome = "completed" | "failed" | "started";

export interface PrivacyReceiptV4 extends PrivacyReceiptBase {
  version: "4";
  egress: EgressOutcome;
  detectors?: ReceiptDetector[];
  detectorDegraded?: boolean;
}

export interface PrivacyReceiptV5 extends PrivacyReceiptBase {
  version: "5";
  egress: EgressOutcome;
  response: ResponseEvidence;
  detectors?: ReceiptDetector[];
  detectorDegraded?: boolean;
}

export type PrivacyReceipt =
  | PrivacyReceiptV2
  | PrivacyReceiptV3
  | PrivacyReceiptV4
  | PrivacyReceiptV5;

export interface ReceiptCheckpoint {
  version: "1";
  chainId: string;
  sequence: number;
  receiptHash: string | null;
  timestamp: string;
  signingKeyId: string;
  signature: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
