import {
  type AppConfig,
  FINDING_KINDS,
  type FindingKind,
  NER_FINDING_KINDS,
  type NerDetectorConfig,
  type NerFindingKind,
  PROVIDER_CAPABILITY_KEYS,
  PROVIDER_KINDS,
  type ProviderConfig,
  SEMANTIC_FINDING_KINDS,
  type SemanticDetectorConfig,
  type SemanticFindingKind,
  SENSITIVITIES,
  type WorkloadPolicy,
} from "./types.ts";
import { validateExportConfig } from "./export.ts";
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

export interface ResolvedNerDetectorConfig {
  enabled: boolean;
  baseUrl: string;
  timeoutMs: number;
  totalTimeoutMs: number;
  maxInputBytes: number;
  minConfidence: number;
  onDetectorFailure: "degrade" | "deny";
  kinds: NerFindingKind[];
}

export interface ResolvedResponsePolicy {
  scan: boolean;
  blocked: "redact" | "deny";
  transformable: "pass" | "redact";
}

export function resolveResponsePolicy(config: AppConfig): ResolvedResponsePolicy {
  const raw = config.policy.response;
  return {
    scan: raw?.scan ?? true,
    blocked: raw?.blocked ?? "redact",
    transformable: raw?.transformable ?? "pass",
  };
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
  validateNerDetectorConfig(config);
  validatePolicyTaxonomy(config.policy);
  validateResponsePolicy(config.policy);
  validateRateLimit(config.policy);
  validateSurrogatePolicy(config.policy);
  validateWorkloads(config);
  validateExportConfig(config);
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

export function resolveNerDetectorConfig(config: AppConfig): ResolvedNerDetectorConfig {
  const detector = config.nerDetector;
  return {
    enabled: detector?.enabled ?? false,
    baseUrl: detector?.baseUrl ?? "http://127.0.0.1:11436",
    timeoutMs: detector?.timeoutMs ?? 2_000,
    totalTimeoutMs: detector?.totalTimeoutMs ?? 6_000,
    maxInputBytes: detector?.maxInputBytes ?? 16_384,
    minConfidence: detector?.minConfidence ?? 0.5,
    onDetectorFailure: detector?.onDetectorFailure ?? "degrade",
    kinds: [...(detector?.kinds ?? NER_FINDING_KINDS)],
  };
}

// The NER detector is a separate local process. It is held to the same
// boundary as the semantic detector's provider: loopback only, no credentials
// in the URL, and explicit bounds on every deadline and size.
export function validateNerDetectorConfig(config: AppConfig): void {
  const raw: NerDetectorConfig | undefined = config.nerDetector;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || typeof raw.enabled !== "boolean") {
    throw new Error("nerDetector.enabled must be boolean");
  }
  if (raw.baseUrl !== undefined && (typeof raw.baseUrl !== "string" || !raw.baseUrl)) {
    throw new Error("nerDetector.baseUrl must be a non-empty string");
  }
  if (raw.kinds !== undefined && !Array.isArray(raw.kinds)) {
    throw new Error("nerDetector.kinds must be an array");
  }
  const detector = resolveNerDetectorConfig(config);
  let url: URL;
  try {
    url = new URL(detector.baseUrl);
  } catch {
    throw new Error("nerDetector.baseUrl must be a valid URL");
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("nerDetector.baseUrl must use a loopback endpoint");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("nerDetector.baseUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("nerDetector.baseUrl cannot contain credentials, query, or fragment");
  }
  if (
    !Number.isInteger(detector.timeoutMs) || detector.timeoutMs < 100 ||
    detector.timeoutMs > 300_000
  ) throw new Error("nerDetector.timeoutMs must be between 100 ms and 5 minutes");
  if (
    !Number.isInteger(detector.totalTimeoutMs) || detector.totalTimeoutMs < 100 ||
    detector.totalTimeoutMs > 300_000
  ) throw new Error("nerDetector.totalTimeoutMs must be between 100 ms and 5 minutes");
  if (detector.totalTimeoutMs < detector.timeoutMs) {
    throw new Error("nerDetector.totalTimeoutMs must be at least timeoutMs");
  }
  if (
    !Number.isInteger(detector.maxInputBytes) || detector.maxInputBytes < 256 ||
    detector.maxInputBytes > config.maxRequestBytes
  ) throw new Error("nerDetector.maxInputBytes must be between 256 and maxRequestBytes");
  if (
    typeof detector.minConfidence !== "number" || !Number.isFinite(detector.minConfidence) ||
    detector.minConfidence < 0 || detector.minConfidence > 1
  ) throw new Error("nerDetector.minConfidence must be between 0 and 1");
  if (!(["degrade", "deny"] as const).includes(detector.onDetectorFailure)) {
    throw new Error("nerDetector.onDetectorFailure must be degrade or deny");
  }
  if (
    detector.kinds.length === 0 || new Set(detector.kinds).size !== detector.kinds.length ||
    detector.kinds.some((kind) => !NER_FINDING_KINDS.includes(kind))
  ) throw new Error("nerDetector.kinds must contain unique NER finding kinds");
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

// The effective configuration for one workload: the global policy with the
// workload's override fields applied. Provider and detector definitions are
// never changed here; allowedProviders and allowedModels are enforced by the
// gateway against the request instead.
export function resolveWorkloadConfig(config: AppConfig, workloadId: string): AppConfig {
  const override = config.workloads?.[workloadId];
  if (!override) return config;
  const { allowedProviders: _providers, allowedModels: _models, ...policy } = override;
  return { ...config, policy: { ...config.policy, ...policy } };
}

const WORKLOAD_FIELDS = new Set([
  "blockKinds",
  "localOnlyKinds",
  "transformKinds",
  "sensitiveTerms",
  "sensitivity",
  "response",
  "rateLimit",
  "surrogates",
  "defaultProvider",
  "allowedProviders",
  "allowedModels",
]);

function validateWorkloads(config: AppConfig): void {
  const raw = config.workloads;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("workloads must be an object keyed by workload id");
  }
  const providerIds = new Set(config.providers.map((provider) => provider.id));
  for (const [workloadId, override] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workloadId)) {
      throw new Error(`workloads: invalid workload id ${JSON.stringify(workloadId)}`);
    }
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error(`workloads.${workloadId} must be an object`);
    }
    for (const key of Object.keys(override)) {
      if (!WORKLOAD_FIELDS.has(key)) {
        throw new Error(`workloads.${workloadId} has unknown field: ${key}`);
      }
    }
    const typed = override as WorkloadPolicy;
    for (const list of ["allowedProviders", "allowedModels"] as const) {
      const values = typed[list];
      if (values === undefined) continue;
      if (
        !Array.isArray(values) || values.length === 0 ||
        values.some((value) => typeof value !== "string" || !value) ||
        new Set(values).size !== values.length
      ) throw new Error(`workloads.${workloadId}.${list} must be a non-empty list of unique ids`);
    }
    for (const id of typed.allowedProviders ?? []) {
      if (!providerIds.has(id)) {
        throw new Error(`workloads.${workloadId}.allowedProviders names unknown provider ${id}`);
      }
    }
    const merged = resolveWorkloadConfig(config, workloadId);
    if (!providerIds.has(merged.policy.defaultProvider)) {
      throw new Error(`workloads.${workloadId}.defaultProvider does not exist`);
    }
    if (
      typed.allowedProviders !== undefined &&
      !typed.allowedProviders.includes(merged.policy.defaultProvider)
    ) {
      throw new Error(`workloads.${workloadId}: defaultProvider must be in allowedProviders`);
    }
    if (
      merged.policy.sensitivity !== undefined && !SENSITIVITIES.includes(merged.policy.sensitivity)
    ) throw new Error(`workloads.${workloadId}.sensitivity is invalid`);
    if (!Array.isArray(merged.policy.sensitiveTerms)) {
      throw new Error(`workloads.${workloadId}.sensitiveTerms must be an array`);
    }
    for (const item of merged.policy.sensitiveTerms) {
      if (
        typeof item?.term !== "string" || typeof item.label !== "string" || item.term.length < 4 ||
        !item.label
      ) {
        throw new Error(
          `workloads.${workloadId}: sensitive terms require a label and four characters`,
        );
      }
    }
    try {
      validatePolicyTaxonomy(merged.policy);
      validateResponsePolicy(merged.policy);
      validateRateLimit(merged.policy);
      validateSurrogatePolicy(merged.policy);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`workloads.${workloadId}: ${message}`);
    }
  }
}

export function resolveSurrogatePolicy(
  policy: AppConfig["policy"],
): { style: "token" | "synthetic"; scope: "request" | "workload" } {
  return {
    style: policy.surrogates?.style ?? "token",
    scope: policy.surrogates?.scope ?? "request",
  };
}

function validateSurrogatePolicy(policy: AppConfig["policy"]): void {
  const raw = policy.surrogates;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("policy.surrogates must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!["style", "scope"].includes(key)) {
      throw new Error(`policy.surrogates has unknown field: ${key}`);
    }
  }
  if (raw.style !== undefined && !["token", "synthetic"].includes(raw.style)) {
    throw new Error("policy.surrogates.style must be token or synthetic");
  }
  if (raw.scope !== undefined && !["request", "workload"].includes(raw.scope)) {
    throw new Error("policy.surrogates.scope must be request or workload");
  }
}

export function resolveRateLimit(
  policy: AppConfig["policy"],
): { requestsPerMinute: number; burst: number } | null {
  const raw = policy.rateLimit;
  if (!raw) return null;
  return { requestsPerMinute: raw.requestsPerMinute, burst: raw.burst ?? raw.requestsPerMinute };
}

function validateRateLimit(policy: AppConfig["policy"]): void {
  const raw = policy.rateLimit;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("policy.rateLimit must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!["requestsPerMinute", "burst"].includes(key)) {
      throw new Error(`policy.rateLimit has unknown field: ${key}`);
    }
  }
  if (
    !Number.isInteger(raw.requestsPerMinute) || raw.requestsPerMinute < 1 ||
    raw.requestsPerMinute > 1_000_000
  ) throw new Error("policy.rateLimit.requestsPerMinute must be an integer from 1 to 1000000");
  if (
    raw.burst !== undefined &&
    (!Number.isInteger(raw.burst) || raw.burst < 1 || raw.burst > 1_000_000)
  ) throw new Error("policy.rateLimit.burst must be an integer from 1 to 1000000");
}

function validateResponsePolicy(policy: AppConfig["policy"]): void {
  const raw = policy.response;
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("policy.response must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!["scan", "blocked", "transformable"].includes(key)) {
      throw new Error(`policy.response has unknown field: ${key}`);
    }
  }
  if (raw.scan !== undefined && typeof raw.scan !== "boolean") {
    throw new Error("policy.response.scan must be boolean");
  }
  if (raw.blocked !== undefined && !["redact", "deny"].includes(raw.blocked)) {
    throw new Error("policy.response.blocked must be redact or deny");
  }
  if (raw.transformable !== undefined && !["pass", "redact"].includes(raw.transformable)) {
    throw new Error("policy.response.transformable must be pass or redact");
  }
}

function validatePolicyTaxonomy(policy: AppConfig["policy"]): void {
  const groups: Array<[string, FindingKind[]]> = [
    ["blockKinds", policy.blockKinds],
    ["localOnlyKinds", policy.localOnlyKinds],
    ["transformKinds", policy.transformKinds],
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
  const envName = /^[A-Z_][A-Z0-9_]*$/;
  if (provider.apiKeyEnv !== undefined && !envName.test(provider.apiKeyEnv)) {
    throw new Error(`provider ${provider.id} apiKeyEnv must be an environment variable name`);
  }
  if (!PROVIDER_KINDS.includes(provider.kind)) {
    throw new Error(`provider ${provider.id} has unknown kind: ${provider.kind}`);
  }
  if (provider.kind === "azure-openai") {
    if (!provider.deployment || !/^[A-Za-z0-9._-]{1,64}$/.test(provider.deployment)) {
      throw new Error(`provider ${provider.id} requires a deployment name`);
    }
    if (
      !provider.apiVersion || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-preview)?$/.test(provider.apiVersion)
    ) {
      throw new Error(`provider ${provider.id} requires an apiVersion such as 2024-10-21`);
    }
    if (!provider.local && !provider.apiKeyEnv) {
      throw new Error(`provider ${provider.id} requires apiKeyEnv`);
    }
  } else if (provider.kind === "bedrock") {
    if (!provider.region || !/^[a-z]{2}-[a-z]+-\d$/.test(provider.region)) {
      throw new Error(`provider ${provider.id} requires an AWS region`);
    }
    const credentials = provider.credentialsEnv;
    if (credentials !== undefined) {
      if (
        !credentials || typeof credentials !== "object" ||
        !envName.test(credentials.accessKeyId ?? "") ||
        !envName.test(credentials.secretAccessKey ?? "") ||
        (credentials.sessionToken !== undefined && !envName.test(credentials.sessionToken))
      ) throw new Error(`provider ${provider.id} credentialsEnv must name environment variables`);
    }
    if (!provider.local && !provider.apiKeyEnv && !credentials) {
      throw new Error(`provider ${provider.id} requires apiKeyEnv or credentialsEnv`);
    }
  } else if (provider.kind === "vertex") {
    if (!provider.region || !/^[a-z]+-[a-z]+\d$/.test(provider.region)) {
      throw new Error(`provider ${provider.id} requires a Google Cloud region`);
    }
    if (!provider.project || !/^[a-z][a-z0-9-]{4,29}$/.test(provider.project)) {
      throw new Error(`provider ${provider.id} requires a Google Cloud project id`);
    }
    if (provider.serviceAccountEnv !== undefined && !envName.test(provider.serviceAccountEnv)) {
      throw new Error(
        `provider ${provider.id} serviceAccountEnv must be an environment variable name`,
      );
    }
    if (provider.tokenUrl !== undefined) {
      const tokenUrl = new URL(provider.tokenUrl);
      const loopbackToken = ["localhost", "127.0.0.1", "::1"].includes(tokenUrl.hostname);
      if (tokenUrl.protocol !== "https:" && !(provider.local && loopbackToken)) {
        throw new Error(`provider ${provider.id} tokenUrl must use HTTPS`);
      }
    }
    if (!provider.local && !provider.apiKeyEnv && !provider.serviceAccountEnv) {
      throw new Error(`provider ${provider.id} requires apiKeyEnv or serviceAccountEnv`);
    }
  } else if (!provider.local && !provider.apiKeyEnv) {
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
