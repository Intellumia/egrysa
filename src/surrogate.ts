import { randomToken } from "./crypto.ts";
import { type Finding, FINDING_KINDS } from "./types.ts";

export interface Transformation {
  text: string;
  mapping: Map<string, string>;
}

export interface Recomposition {
  text: string;
  residueDetected: boolean;
}

export interface SurrogateState {
  mapping: Map<string, string>;
  reusable: Map<string, string>;
  sequence: number;
}

export function createSurrogateState(): SurrogateState {
  return { mapping: new Map(), reusable: new Map(), sequence: 0 };
}

export function transform(
  text: string,
  findings: Finding[],
  allowedKinds: Set<string>,
  state: SurrogateState = createSurrogateState(),
): Transformation {
  let output = "";
  let cursor = 0;
  for (
    const finding of findings.filter((item) => allowedKinds.has(item.kind)).sort((a, b) =>
      a.start - b.start
    )
  ) {
    if (finding.start < cursor) throw new Error("transformation findings overlap");
    output += text.slice(cursor, finding.start);
    const identity = `${finding.kind}:${finding.value}`;
    let token = state.reusable.get(identity);
    if (!token) {
      token = `__EGRYSA_${finding.kind.toUpperCase()}_${
        String(++state.sequence).padStart(4, "0")
      }_${randomToken(6)}__`;
      state.reusable.set(identity, token);
      state.mapping.set(token, finding.value);
    }
    output += token;
    cursor = finding.end;
  }
  return { text: output + text.slice(cursor), mapping: state.mapping };
}

export function recompose(text: string, mapping: ReadonlyMap<string, string>): string {
  return recomposeChecked(text, mapping).text;
}

export function recomposeChecked(
  text: string,
  mapping: ReadonlyMap<string, string>,
): Recomposition {
  let output = text;
  for (const [token, original] of mapping) output = output.replaceAll(token, original);
  return {
    text: output,
    residueDetected: mapping.size > 0 && hasSurrogateResidue(text, mapping),
  };
}

// Residue is recognised by surrogate structure rather than by the product name.
//
// Matching a bare `egrysa[-_]word` failed closed on ordinary text: a request
// mentioning `/opt/egrysa-gateway` alongside any transformable value returned
// 502, and whether it did so depended on adjacent punctuation, because the
// audit strips whitespace before testing.
//
// Two shapes count as residue. Either the token skeleton survives, meaning the
// sentinel is followed by a finding kind and a sequence number, or the sentinel
// is followed by a token body and the closing delimiter. A mutation has to
// destroy both to escape, and neither shape occurs in prose.
const RESIDUE_KINDS = FINDING_KINDS
  .map((kind) => kind.toUpperCase().replace(/_/g, "[_-]"))
  .join("|");

const SURROGATE_SKELETON = `egrysa[_-]{0,2}(?:${RESIDUE_KINDS})[_-]{0,2}\\d{1,4}`;
const SURROGATE_TAIL = `egrysa[_-][\\w-]{1,128}[_-]{2}`;

const COMPLETE_RESIDUE = new RegExp(`(?:${SURROGATE_SKELETON})|(?:${SURROGATE_TAIL})`, "i");
const PARTIAL_RESIDUE = new RegExp(SURROGATE_TAIL, "i");

// Both residue patterns require the literal sentinel, and every issued token
// contains it. Text without the sentinel therefore cannot match, and removing
// tokens cannot introduce one: a token that is present already supplies it, and
// if none is present the removal changes nothing. Testing for it first turns the
// common chunk, which carries no surrogate at all, into a single scan instead of
// one pass per token.
const SENTINEL_PROBE = /egrysa/i;

export function hasSurrogateResidue(
  providerText: string,
  mapping: ReadonlyMap<string, string>,
  complete = true,
): boolean {
  if (!SENTINEL_PROBE.test(providerText.replace(/\s+/g, ""))) return false;
  let unknown = providerText;
  for (const token of mapping.keys()) unknown = unknown.replaceAll(token, "");
  unknown = unknown.replace(/\s+/g, "");
  return complete ? COMPLETE_RESIDUE.test(unknown) : PARTIAL_RESIDUE.test(unknown);
}

export function hasSurrogateResidueAfterRecomposition(
  text: string,
  mapping: ReadonlyMap<string, string>,
): boolean {
  if (mapping.size === 0) return false;
  let audit = text;
  for (const original of mapping.values()) {
    if (original) audit = audit.replaceAll(original, "");
  }
  audit = audit.replace(/\s+/g, "");
  return COMPLETE_RESIDUE.test(audit);
}

// Exported so the streaming recomposer can skip per-token work on a chunk that
// cannot contain a surrogate.
export function mayContainSurrogate(text: string): boolean {
  return SENTINEL_PROBE.test(text);
}
