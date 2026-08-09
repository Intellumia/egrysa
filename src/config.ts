import {
  type AppConfig,
  FINDING_KINDS,
  type FindingKind,
  PROVIDER_CAPABILITY_KEYS,
  type ProviderConfig,
  SEMANTIC_FINDING_KINDS,
  type SemanticDetectorConfig,
  type SemanticFindingKind,
  SENSITIVITIES,
} from "./types.ts";
import { PROVIDER_CAPABILITY_TABLE } from "./provider_capabilities.ts";

const DEFAULT_PATH = "config/egrysa.example.json";

export interface ResolvedSemanticDetectorConfig {
  enabled: boolean;
  providerId: string;
  model: string;
  timeoutMs: number;
  totalTimeoutMs: number;
  maxInputBytes: number;
  onDetectorFailure: "degrade" | "deny";
  kinds: SemanticFindingKind[];
}

export async function loadConfig(
  path = Deno.env.get("EGRYSA_CONFIG") ?? DEFAULT_PATH,
): Promise<AppConfig> {
  const parsed = JSON.parse(await Deno.readTextFile(path)) as AppConfig;
  validateConfig(parsed);
  return parsed;
}

export function validateConfig(config: AppConfig): void {
  if (
    !config.listen?.hostname || !Number.isInteger(config.listen.port) || config.listen.port < 1 ||
    config.listen.port > 65_535
  ) {
    throw new Error("invalid listen config");
  }
  if (config.maxRequestBytes < 1024 || config.maxRequestBytes > 10 * 1024 * 1024) {
    throw new Error("maxRequestBytes must be between 1 KiB and 10 MiB");
  }
  const maxResponseBytes = config.maxResponseBytes ?? 32 * 1024 * 1024;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 64 * 1024) {
    throw new Error("maxResponseBytes must be at least 64 KiB");
  }
  if (
    !Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 100 ||
    config.requestTimeoutMs > 300_000
  ) throw new Error("requestTimeoutMs must be between 100 ms and 5 minutes");
  if (
    !Number.isInteger(config.receiptCapacity) || config.receiptCapacity < 1 ||
    config.receiptCapacity > 1_000_000
  ) throw new Error("receiptCapacity must be between 1 and 1000000");
  if (typeof config.receiptLogPath !== "string" || !config.receiptLogPath.trim()) {
    throw new Error("receiptLogPath must be a non-empty path");
  }
  const receiptMaxLogBytes = config.receiptMaxLogBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isInteger(receiptMaxLogBytes) || receiptMaxLogBytes < 1024 ||
    receiptMaxLogBytes > 1024 * 1024 * 1024
  ) {
    throw new Error("receiptMaxLogBytes must be between 1 KiB and 1 GiB");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.receiptChainId)) {
    throw new Error("receiptChainId must be a stable identifier");
  }
  if (!config.providers?.length) throw new Error("at least one provider is required");
  const ids = new Set<string>();
  for (const provider of config.providers) {
    if (ids.has(provider.id)) throw new Error(`duplicate provider: ${provider.id}`);
    ids.add(provider.id);
    validateProvider(provider);
  }
  if (!ids.has(config.policy.defaultProvider)) throw new Error("defaultProvider does not exist");
  if (!ids.has(config.policy.localProvider)) throw new Error("localProvider does not exist");
  if (!config.providers.find((provider) => provider.id === config.policy.localProvider)?.local) {
    throw new Error("localProvider must reference a provider inside the local trust boundary");
  }
  validateSemanticDetectorConfig(config);
  validatePolicyTaxonomy(config);
  if (
    config.policy.sensitivity !== undefined &&
    !SENSITIVITIES.includes(config.policy.sensitivity)
  ) {
    throw new Error(`policy.sensitivity must be one of ${SENSITIVITIES.join(", ")}`);
  }
  if (!Array.isArray(config.policy.sensitiveTerms)) {
    throw new Error("sensitiveTerms must be an array");
  }
  for (const item of config.policy.sensitiveTerms) {
    if (
      typeof item?.term !== "string" || typeof item.label !== "string" || item.term.length < 4 ||
      !item.label
    ) throw new Error("sensitive terms require a label and at least four characters");
  }
}

export function resolveSemanticDetectorConfig(config: AppConfig): ResolvedSemanticDetectorConfig {
  const detector = config.semanticDetector;
  return {
    enabled: detector?.enabled ?? false,
    providerId: detector?.providerId ?? config.policy.localProvider,
    model: detector?.model ?? "gpt-oss:20b",
    timeoutMs: detector?.timeoutMs ?? 10_000,
    totalTimeoutMs: detector?.totalTimeoutMs ?? 30_000,
    maxInputBytes: detector?.maxInputBytes ?? 16_384,
    onDetectorFailure: detector?.onDetectorFailure ?? "degrade",
    kinds: [...(detector?.kinds ?? SEMANTIC_FINDING_KINDS)],
  };
}

export function validateSemanticDetectorConfig(config: AppConfig): void {
  const raw = config.semanticDetector;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || typeof raw.enabled !== "boolean") {
    throw new Error("semanticDetector.enabled must be boolean");
  }
  validateOptionalSemanticFields(raw);
  const detector = resolveSemanticDetectorConfig(config);
  const provider = config.providers.find((candidate) => candidate.id === detector.providerId);
  if (!provider) throw new Error("semanticDetector.providerId does not exist");
  if (!provider.local) {
    throw new Error("semanticDetector.providerId must reference a local provider");
  }
  const detectorUrl = new URL(provider.baseUrl);
  if (!["localhost", "127.0.0.1", "::1"].includes(detectorUrl.hostname)) {
    throw new Error("semanticDetector provider must use a loopback endpoint");
  }
  if (provider.kind === "anthropic") {
    throw new Error("semanticDetector provider must be OpenAI-compatible");
  }
  if (!provider.allowedModels.includes(detector.model)) {
    throw new Error("semanticDetector.model is not allowed by its local provider");
  }
  if (
    !Number.isInteger(detector.timeoutMs) || detector.timeoutMs < 100 ||
    detector.timeoutMs > 300_000
  ) {
    throw new Error("semanticDetector.timeoutMs must be between 100 ms and 5 minutes");
  }
  if (
    !Number.isInteger(detector.totalTimeoutMs) || detector.totalTimeoutMs < 100 ||
    detector.totalTimeoutMs > 300_000
  ) {
    throw new Error("semanticDetector.totalTimeoutMs must be between 100 ms and 5 minutes");
  }
  if (detector.totalTimeoutMs < detector.timeoutMs) {
    throw new Error("semanticDetector.totalTimeoutMs must be at least timeoutMs");
  }
  if (
    !Number.isInteger(detector.maxInputBytes) || detector.maxInputBytes < 256 ||
    detector.maxInputBytes > config.maxRequestBytes
  ) {
    throw new Error("semanticDetector.maxInputBytes must be between 256 and maxRequestBytes");
  }
  if (!(["degrade", "deny"] as const).includes(detector.onDetectorFailure)) {
    throw new Error("semanticDetector.onDetectorFailure must be degrade or deny");
  }
  if (
    detector.kinds.length === 0 || new Set(detector.kinds).size !== detector.kinds.length ||
    detector.kinds.some((kind) => !SEMANTIC_FINDING_KINDS.includes(kind))
  ) {
    throw new Error("semanticDetector.kinds must contain unique semantic finding kinds");
  }
}

function validateOptionalSemanticFields(config: SemanticDetectorConfig): void {
  if (
    config.providerId !== undefined && (typeof config.providerId !== "string" || !config.providerId)
  ) {
    throw new Error("semanticDetector.providerId must be a non-empty string");
  }
  if (config.model !== undefined && (typeof config.model !== "string" || !config.model)) {
    throw new Error("semanticDetector.model must be a non-empty string");
  }
  if (config.kinds !== undefined && !Array.isArray(config.kinds)) {
    throw new Error("semanticDetector.kinds must be an array");
  }
}

function validatePolicyTaxonomy(config: AppConfig): void {
  const groups: Array<[string, FindingKind[]]> = [
    ["blockKinds", config.policy.blockKinds],
    ["localOnlyKinds", config.policy.localOnlyKinds],
    ["transformKinds", config.policy.transformKinds],
  ];
  const allowed = new Set<string>(FINDING_KINDS);
  const assignments = new Map<FindingKind, string[]>();
  for (const [group, values] of groups) {
    if (!Array.isArray(values)) throw new Error(`${group} must be an array`);
    if (new Set(values).size !== values.length) throw new Error(`${group} contains duplicates`);
    for (const value of values) {
      if (!allowed.has(value)) throw new Error(`${group} contains unknown data class: ${value}`);
      const kind = value as FindingKind;
      assignments.set(kind, [...(assignments.get(kind) ?? []), group]);
    }
  }
  for (const kind of FINDING_KINDS) {
    const assigned = assignments.get(kind) ?? [];
    if (assigned.length !== 1) {
      throw new Error(
        assigned.length === 0
          ? `data class ${kind} has no policy action`
          : `data class ${kind} has conflicting policy actions: ${assigned.join(", ")}`,
      );
    }
  }
}

function validateProvider(provider: ProviderConfig): void {
  const url = new URL(provider.baseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `provider ${provider.id} baseUrl cannot contain credentials, query, or fragment`,
    );
  }
  if (provider.local && !loopback) {
    throw new Error(`provider ${provider.id} marked local must use a loopback endpoint`);
  }
  if (url.protocol !== "https:" && !(provider.local && loopback && url.protocol === "http:")) {
    throw new Error(
      `provider ${provider.id} must use HTTPS; HTTP is allowed only for loopback local providers`,
    );
  }
  if (
    !Array.isArray(provider.allowedModels) || !provider.allowedModels.length ||
    provider.allowedModels.some((model) => typeof model !== "string" || !model) ||
    new Set(provider.allowedModels).size !== provider.allowedModels.length
  ) {
    throw new Error(`provider ${provider.id} requires an explicit model allowlist`);
  }
  if (
    !provider.local &&
    (!provider.apiKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(provider.apiKeyEnv))
  ) {
    throw new Error(`provider ${provider.id} requires apiKeyEnv`);
  }
  if (
    !provider.dataPolicy || !["disabled", "enabled", "unknown"].includes(
      provider.dataPolicy.training,
    ) || !["none", "standard", "unknown"].includes(provider.dataPolicy.retention) ||
    typeof provider.dataPolicy.allowRaw !== "boolean"
  ) throw new Error(`provider ${provider.id} requires an explicit dataPolicy`);
  if (provider.capabilities !== undefined) {
    if (
      !provider.capabilities || typeof provider.capabilities !== "object" ||
      Array.isArray(provider.capabilities)
    ) throw new Error(`provider ${provider.id} capabilities must be an object`);
    const known = new Set<string>(PROVIDER_CAPABILITY_KEYS);
    for (const [key, value] of Object.entries(provider.capabilities)) {
      if (!known.has(key)) {
        throw new Error(`provider ${provider.id} has unknown capability: ${key}`);
      }
      if (typeof value !== "boolean") {
        throw new Error(`provider ${provider.id} capability ${key} must be boolean`);
      }
      if (
        value &&
        !PROVIDER_CAPABILITY_TABLE[provider.kind][key as keyof typeof provider.capabilities]
      ) {
        throw new Error(`provider ${provider.id} cannot enable unsupported capability: ${key}`);
      }
    }
  }
}
