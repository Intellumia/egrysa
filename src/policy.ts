import type { AppConfig, Decision, Finding, FindingKind, ProviderConfig } from "./types.ts";

export interface PolicyResult {
  decision: Decision;
  provider: ProviderConfig | null;
  reason: string;
  // Set when sensitivity is "review" and only a low-precision finding in a
  // blocked class stands between the request and its decision. The decision
  // above is what applies once a person acknowledges the hold.
  reviewRequired?: boolean;
}

export function decide(
  findings: Finding[],
  requestedProvider: string | null,
  config: AppConfig,
): PolicyResult {
  const kinds = new Set(findings.map((finding) => finding.kind));
  const highPrecisionBlocked = findings.some((finding) =>
    config.policy.blockKinds.includes(finding.kind) &&
    (finding.precision === undefined || finding.precision === "high")
  );
  if (highPrecisionBlocked) {
    return { decision: "deny", provider: null, reason: "blocked data class detected" };
  }

  const lowPrecisionBlocked = findings.some((finding) =>
    config.policy.blockKinds.includes(finding.kind) && finding.precision !== undefined &&
    finding.precision !== "high"
  );

  const sensitivity = config.policy.sensitivity ?? "balanced";
  if (lowPrecisionBlocked && sensitivity === "strict") {
    return {
      decision: "deny",
      provider: null,
      reason: "low-precision finding in a blocked data class, strict sensitivity",
    };
  }
  const reviewRequired = lowPrecisionBlocked && sensitivity === "review";

  const localRouteRequired = lowPrecisionBlocked || intersects(kinds, config.policy.localOnlyKinds);

  const providerId = localRouteRequired
    ? config.policy.localProvider
    : (requestedProvider ?? config.policy.defaultProvider);
  const provider = config.providers.find((candidate) => candidate.id === providerId) ?? null;
  if (!provider) return { decision: "deny", provider: null, reason: "provider is not configured" };

  if (localRouteRequired) {
    if (!provider.local) {
      return {
        decision: "deny",
        provider: null,
        reason: "local-only data cannot leave the trust boundary",
      };
    }
    return {
      decision: "local_only",
      provider,
      reason: lowPrecisionBlocked
        ? "candidate blocked data routed to local inference"
        : "confidential data routed to local inference",
      ...(reviewRequired ? { reviewRequired: true } : {}),
    };
  }

  if (intersects(kinds, config.policy.transformKinds)) {
    return {
      decision: "transform",
      provider,
      reason: "sensitive fields replaced with request-scoped surrogates",
    };
  }

  if (!provider.local && !provider.dataPolicy.allowRaw) {
    return {
      decision: "deny",
      provider: null,
      reason: "raw remote egress is disabled for this provider",
    };
  }
  return {
    decision: "allow_raw",
    provider,
    reason: provider.local ? "local inference" : "approved raw egress",
  };
}

function intersects(values: ReadonlySet<FindingKind>, candidates: FindingKind[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}
