import {
  classifyDetailed,
  createDetectors,
  type DetectorExecution,
  removeOverlaps,
} from "./classifier.ts";
import { createSurrogateState, transform } from "./surrogate.ts";
import type { AppConfig, ChatRequest, Finding, JsonValue } from "./types.ts";

interface TextSurface {
  path: Array<string | number>;
  text: string;
  findings: Finding[];
  transformable: boolean;
}

export interface ChatInspection {
  surfaces: TextSurface[];
  findings: Finding[];
  untransformableFindings: Finding[];
  detectorExecutions: DetectorExecution[];
  detectorDegraded: boolean;
}

export interface TransformedChat {
  chat: ChatRequest;
  mapping: Map<string, string>;
  transformedFields: number;
}

export async function inspectChat(chat: ChatRequest, config: AppConfig): Promise<ChatInspection> {
  const candidates: Array<Omit<TextSurface, "findings">> = [];
  for (const [messageIndex, message] of chat.messages.entries()) {
    if (typeof message.content === "string") {
      candidates.push({
        path: ["messages", messageIndex, "content"],
        text: message.content,
        transformable: true,
      });
    }
    for (const [callIndex, call] of (message.tool_calls ?? []).entries()) {
      candidates.push({
        path: ["messages", messageIndex, "tool_calls", callIndex, "function", "arguments"],
        text: call.function.arguments,
        transformable: true,
      });
    }
  }
  for (const [toolIndex, tool] of (chat.tools ?? []).entries()) {
    if (tool.function.description !== undefined) {
      candidates.push({
        path: ["tools", toolIndex, "function", "description"],
        text: tool.function.description,
        transformable: true,
      });
    }
    if (tool.function.parameters !== undefined) {
      collectJsonSurfaces(
        tool.function.parameters,
        ["tools", toolIndex, "function", "parameters"],
        candidates,
      );
    }
  }
  const detectors = createDetectors(config);
  const classified = await Promise.all(candidates.map(async (surface) => ({
    surface,
    result: await classifyDetailed(surface.text, config, detectors),
  })));
  // A detector that failed on any surface contributes nothing to the request:
  // partial model findings would make the receipt claim coverage it did not have.
  const degraded = new Set(
    classified.flatMap(({ result }) =>
      result.detectorExecutions.filter((e) => e.failureClass !== undefined).map((e) => e.id)
    ),
  );
  const detectorDegraded = degraded.size > 0;
  const surfaces: TextSurface[] = classified.map(({ surface, result }) => ({
    ...surface,
    findings: detectorDegraded
      ? removeOverlaps(
        result.findings.filter((finding) =>
          finding.detectorId === undefined || !degraded.has(finding.detectorId)
        ),
      )
      : result.findings,
  }));
  const findings = surfaces.flatMap((surface) => surface.findings);
  return {
    surfaces,
    findings,
    untransformableFindings: surfaces.filter((surface) => !surface.transformable).flatMap((
      surface,
    ) => surface.findings),
    detectorExecutions: classified.flatMap(({ result }) => result.detectorExecutions),
    detectorDegraded,
  };
}

export function transformChat(
  chat: ChatRequest,
  inspection: ChatInspection,
  allowedKinds: Set<string>,
): TransformedChat {
  const cloned = structuredClone(chat);
  const state = createSurrogateState();
  for (const surface of inspection.surfaces.filter((candidate) => candidate.transformable)) {
    const before = state.mapping.size;
    const result = transform(surface.text, surface.findings, allowedKinds, state);
    if (state.mapping.size === before && result.text === surface.text) continue;
    setPath(cloned as unknown as Record<string, unknown>, surface.path, result.text);
  }
  return { chat: cloned, mapping: state.mapping, transformedFields: state.mapping.size };
}

function collectJsonSurfaces(
  value: JsonValue,
  path: Array<string | number>,
  surfaces: Array<Omit<TextSurface, "findings">>,
): void {
  if (typeof value === "string") {
    surfaces.push({ path, text: value, transformable: true });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectJsonSurfaces(item, [...path, index], surfaces));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      surfaces.push({ path: [], text: key, transformable: false });
      collectJsonSurfaces(item, [...path, key], surfaces);
    }
  }
}

function setPath(root: Record<string, unknown>, path: Array<string | number>, value: string): void {
  let target: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!target || typeof target !== "object") throw new Error("invalid inspected chat path");
    target = (target as Record<string | number, unknown>)[segment];
  }
  if (!target || typeof target !== "object") throw new Error("invalid inspected chat path");
  (target as Record<string | number, unknown>)[path.at(-1)!] = value;
}
