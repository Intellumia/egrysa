// Response-side scanning.
//
// The request path decides what may leave the boundary. This module decides
// what may come back in. A provider can return sensitive data the customer
// never sent: a credential or card number recalled from training data, a
// value leaked from another tenant's context, or personal data the model
// produced on its own. The same detectors that inspect requests inspect the
// provider's text, and policy decides per data class whether a finding is
// passed, redacted, or grounds for refusing the whole response.
//
// Scanning happens before recomposition. At that point the customer's own
// values are still surrogate tokens, so anything found is provider-originated
// by construction, and restoring the customer's values afterwards can never be
// mistaken for a leak. A finding whose text overlaps a surrogate token is
// dropped for the same reason.
//
// The result is recorded in the signed receipt as counts per kind and the
// action taken, never as text. Streams are signed when they begin and cannot
// be amended, so a stream is observed rather than enforced: the gateway scans
// what passed after the stream completes and records it in metrics and a
// content-free log event, and the receipt says `unscanned`.
import { classifyDetectors } from "./classifier.ts";
import { resolveResponsePolicy } from "./config.ts";
import type { LocalDetector } from "./detectors.ts";
import { mapResponseContent } from "./providers.ts";
import { mayContainSurrogate } from "./surrogate.ts";
import type { AppConfig, Finding, FindingKind, ResponseEvidence } from "./types.ts";

export interface ResponseScan {
  data: Record<string, unknown>;
  evidence: ResponseEvidence;
  denied: boolean;
  detectorDegraded: boolean;
}

export const UNSCANNED: ResponseEvidence = { findingCounts: {}, action: "unscanned" };

type KindAction = "pass" | "redact" | "deny";

export function responseActionFor(kind: FindingKind, config: AppConfig): KindAction {
  // Injection is a property of a request, not of a reply; a model quoting an
  // attack back is not attacking. It is never redacted or denied here.
  if (kind === "prompt_injection") return "pass";
  const policy = resolveResponsePolicy(config);
  if (config.policy.blockKinds.includes(kind)) return policy.blocked;
  if (config.policy.transformKinds.includes(kind)) return policy.transformable;
  // Confidential terms and other local-only kinds are the customer's own
  // vocabulary; a provider repeating them back is not a disclosure.
  return "pass";
}

export async function scanResponse(
  data: Record<string, unknown>,
  config: AppConfig,
  detectors: LocalDetector[],
): Promise<ResponseScan> {
  const policy = resolveResponsePolicy(config);
  if (!policy.scan) return { data, evidence: UNSCANNED, denied: false, detectorDegraded: false };
  const surfaces: string[] = [];
  mapResponseContent(data, (text) => {
    surfaces.push(text);
    return text;
  });
  const results = await Promise.all(
    surfaces.map((text) => classifyDetectors(text, detectors)),
  );
  const detectorDegraded = results.some((result) => result.detectorDegraded);
  const perSurface = results.map((result) =>
    result.findings.filter((finding) => !mayContainSurrogate(finding.value))
  );
  const findingCounts: ResponseEvidence["findingCounts"] = {};
  for (const finding of perSurface.flat()) {
    findingCounts[finding.kind] = (findingCounts[finding.kind] ?? 0) + 1;
  }
  const actions = new Map<FindingKind, KindAction>();
  for (const kind of Object.keys(findingCounts) as FindingKind[]) {
    actions.set(kind, responseActionFor(kind, config));
  }
  if ([...actions.values()].includes("deny")) {
    return { data, evidence: { findingCounts, action: "denied" }, denied: true, detectorDegraded };
  }
  let redacted = false;
  let index = 0;
  const output = mapResponseContent(data, (text) => {
    const findings = perSurface[index++]!.filter((finding) =>
      actions.get(finding.kind) === "redact"
    );
    if (findings.length === 0) return text;
    redacted = true;
    return redact(text, findings);
  });
  return {
    data: output,
    evidence: { findingCounts, action: redacted ? "redacted" : "none" },
    denied: false,
    detectorDegraded,
  };
}

// Replaces each finding with a marker naming only the data class. Findings
// arrive non-overlapping from overlap resolution; they are sorted here so the
// output is built in one pass.
export function redact(text: string, findings: Finding[]): string {
  let output = "";
  let cursor = 0;
  for (const finding of [...findings].sort((a, b) => a.start - b.start)) {
    if (finding.start < cursor) continue;
    output += text.slice(cursor, finding.start);
    output += `[REDACTED:${finding.kind.toUpperCase()}]`;
    cursor = finding.end;
  }
  return output + text.slice(cursor);
}

// Counts findings in text that already reached the caller. Used for streams,
// where the receipt was signed before the text existed.
export async function observeResponseText(
  text: string,
  config: AppConfig,
  detectors: LocalDetector[],
): Promise<ResponseEvidence["findingCounts"]> {
  if (!resolveResponsePolicy(config).scan || !text) return {};
  const result = await classifyDetectors(text, detectors);
  const counts: ResponseEvidence["findingCounts"] = {};
  for (const finding of result.findings) {
    if (mayContainSurrogate(finding.value)) continue;
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}
