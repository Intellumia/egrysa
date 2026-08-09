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

export interface ProviderConfig {
  id: string;
  kind: "openai" | "anthropic" | "openai-compatible";
  baseUrl: string;
  apiKeyEnv?: string;
  allowedModels: string[];
  local?: boolean;
  capabilities?: ProviderCapabilityOverrides;
  dataPolicy: DataPolicy;
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

export interface AppConfig {
  listen: { hostname: string; port: number };
  maxRequestBytes: number;
  maxResponseBytes?: number;
  requestTimeoutMs: number;
  receiptCapacity: number;
  receiptLogPath: string;
  receiptMaxLogBytes?: number;
  receiptChainId: string;
  providers: ProviderConfig[];
  semanticDetector?: SemanticDetectorConfig;
  policy: {
    defaultProvider: string;
    localProvider: string;
    blockKinds: FindingKind[];
    localOnlyKinds: FindingKind[];
    transformKinds: FindingKind[];
    sensitiveTerms: Array<{ term: string; label: string }>;
    sensitivity?: Sensitivity;
  };
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

export type PrivacyReceipt = PrivacyReceiptV2 | PrivacyReceiptV3 | PrivacyReceiptV4;

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
