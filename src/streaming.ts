import { hasSurrogateResidue, mayContainSurrogate } from "./surrogate.ts";

export class RecompositionError extends Error {}

const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export function recomposeOpenAiStream(
  upstream: ReadableStream<Uint8Array>,
  mapping: ReadonlyMap<string, string>,
  onFailure: (error: unknown) => void,
  onComplete: () => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  const states = new Map<string, BufferedRecomposer>();
  let input = "";
  let bufferedBytes = 0;
  let scanFrom = 0;
  let template: Record<string, unknown> | null = null;
  let upstreamDone = false;
  let completed = false;
  const output: string[] = [];

  const complete = () => {
    if (completed) return;
    completed = true;
    onComplete();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (output.length === 0 && !upstreamDone) {
          const { value, done } = await reader.read();
          bufferedBytes += value?.byteLength ?? 0;
          input += decoder.decode(value, { stream: !done });
          while (true) {
            const boundary = nextEventBoundary(input, scanFrom);
            if (!boundary) {
              scanFrom = Math.max(0, input.length - 3);
              if (bufferedBytes > MAX_SSE_EVENT_BYTES) {
                throw new Error("provider SSE event exceeded the size limit");
              }
              break;
            }
            const frame = input.slice(0, boundary.index);
            if (encoder.encode(frame).byteLength > MAX_SSE_EVENT_BYTES) {
              throw new Error("provider SSE event exceeded the size limit");
            }
            const consumed = input.slice(0, boundary.index + boundary.length);
            bufferedBytes = Math.max(0, bufferedBytes - encoder.encode(consumed).byteLength);
            input = input.slice(boundary.index + boundary.length);
            scanFrom = 0;
            const event = processFrame(
              frame,
              states,
              mapping,
              template,
              (value) => template = value,
            );
            if (event) output.push(event);
          }
          if (!done) continue;
          upstreamDone = true;
          if (input.trim()) {
            const event = processFrame(
              input,
              states,
              mapping,
              template,
              (value) => template = value,
            );
            if (event) output.push(event);
          }
          const tail = flushAll(states, template);
          if (tail) output.push(`data: ${JSON.stringify(tail)}\n\n`);
          complete();
        }
        const next = output.shift();
        if (next) controller.enqueue(encoder.encode(next));
        else if (upstreamDone) controller.close();
      } catch (error) {
        onFailure(error);
        const payload = {
          error: {
            type: error instanceof RecompositionError
              ? "recomposition_error"
              : "upstream_stream_error",
            message: "The provider stream could not be safely completed.",
          },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        controller.close();
        await reader.cancel().catch(() => undefined);
        complete();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        complete();
      }
    },
  });
}

class BufferedRecomposer {
  #buffer = "";
  readonly #holdback: number;

  constructor(private readonly mapping: ReadonlyMap<string, string>) {
    this.#holdback = mapping.size === 0
      ? 0
      : Math.max(...[...mapping.keys()].map((token) => token.length + 16));
  }

  push(value: string): string {
    this.#buffer += value;
    this.#assertSafe(false);
    this.#replaceKnown();
    if (this.#buffer.length <= this.#holdback) return "";
    const cut = this.#buffer.length - this.#holdback;
    this.#assertNoSurrogatePrefixBefore(cut);
    const output = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    return output;
  }

  flush(): string {
    this.#assertSafe(true);
    this.#replaceKnown();
    this.#assertNoSurrogatePrefixBefore(Number.POSITIVE_INFINITY);
    const output = this.#buffer;
    this.#buffer = "";
    return output;
  }

  #assertSafe(complete: boolean): void {
    if (this.mapping.size > 0 && hasSurrogateResidue(this.#buffer, this.mapping, complete)) {
      throw new RecompositionError("provider damaged a surrogate token");
    }
  }

  #replaceKnown(): void {
    // Every token carries the sentinel, so a buffer without it has nothing to
    // replace and does not need a pass per token.
    if (!mayContainSurrogate(this.#buffer)) return;
    for (const [token, original] of this.mapping) {
      this.#buffer = this.#buffer.replaceAll(token, original);
    }
  }

  #assertNoSurrogatePrefixBefore(boundary: number): void {
    if (this.mapping.size === 0) return;
    // Both alternatives below require the literal sentinel, and blanking a
    // recomposed original cannot introduce one, so its absence is conclusive.
    if (!mayContainSurrogate(this.#buffer)) return;
    let audit = this.#buffer;
    for (const original of this.mapping.values()) {
      if (original) audit = audit.replaceAll(original, "\0".repeat(original.length));
    }
    for (const match of audit.matchAll(/(?:_+egrysa[_-]|\begrysa[_-][\w-]{4,128})/gi)) {
      if ((match.index ?? Number.POSITIVE_INFINITY) < boundary) {
        throw new RecompositionError("provider damaged a surrogate token");
      }
    }
  }
}

function processFrame(
  frame: string,
  states: Map<string, BufferedRecomposer>,
  mapping: ReadonlyMap<string, string>,
  template: Record<string, unknown> | null,
  setTemplate: (value: Record<string, unknown>) => void,
): string {
  const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart()).join("\n");
  if (!data) return "";
  if (data === "[DONE]") {
    const tail = flushAll(states, template);
    return `${tail ? `data: ${JSON.stringify(tail)}\n\n` : ""}data: [DONE]\n\n`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new RecompositionError("provider emitted malformed SSE JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RecompositionError("provider emitted an invalid SSE event");
  }
  const chunk = structuredClone(parsed) as Record<string, unknown>;
  setTemplate(chunk);
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  for (const choiceValue of choices) {
    if (!choiceValue || typeof choiceValue !== "object" || Array.isArray(choiceValue)) continue;
    const choice = choiceValue as Record<string, unknown>;
    const choiceIndex = typeof choice.index === "number" ? choice.index : 0;
    const delta = choice.delta;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    const typedDelta = delta as Record<string, unknown>;
    if (typeof typedDelta.content === "string") {
      typedDelta.content = state(states, `${choiceIndex}:content`, mapping).push(
        typedDelta.content,
      );
    }
    const toolCalls = Array.isArray(typedDelta.tool_calls) ? typedDelta.tool_calls : [];
    for (const callValue of toolCalls) {
      if (!callValue || typeof callValue !== "object" || Array.isArray(callValue)) continue;
      const call = callValue as Record<string, unknown>;
      const toolIndex = typeof call.index === "number" ? call.index : 0;
      const fn = call.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
      const typedFunction = fn as Record<string, unknown>;
      if (typeof typedFunction.arguments === "string") {
        typedFunction.arguments = state(
          states,
          `${choiceIndex}:tool:${toolIndex}`,
          mapping,
        ).push(typedFunction.arguments);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      appendChoiceTail(typedDelta, choiceIndex, states);
    }
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function appendChoiceTail(
  delta: Record<string, unknown>,
  choiceIndex: number,
  states: Map<string, BufferedRecomposer>,
): void {
  const contentKey = `${choiceIndex}:content`;
  const contentState = states.get(contentKey);
  if (contentState) {
    const tail = contentState.flush();
    delta.content = `${typeof delta.content === "string" ? delta.content : ""}${tail}`;
    states.delete(contentKey);
  }
  const toolTails: Array<Record<string, unknown>> = [];
  for (const [key, value] of states) {
    const prefix = `${choiceIndex}:tool:`;
    if (!key.startsWith(prefix)) continue;
    const tail = value.flush();
    const index = Number(key.slice(prefix.length));
    if (tail) toolTails.push({ index, function: { arguments: tail } });
    states.delete(key);
  }
  if (toolTails.length) {
    delta.tool_calls = [...(Array.isArray(delta.tool_calls) ? delta.tool_calls : []), ...toolTails];
  }
}

function flushAll(
  states: Map<string, BufferedRecomposer>,
  template: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (states.size === 0) return null;
  const byChoice = new Map<number, Record<string, unknown>>();
  for (const key of states.keys()) {
    const choiceIndex = Number(key.split(":", 1)[0]);
    const delta = byChoice.get(choiceIndex) ?? {};
    appendChoiceTail(delta, choiceIndex, states);
    byChoice.set(choiceIndex, delta);
  }
  return {
    ...(template
      ? Object.fromEntries(Object.entries(template).filter(([key]) => key !== "choices"))
      : { object: "chat.completion.chunk" }),
    choices: [...byChoice].map(([index, delta]) => ({ index, delta, finish_reason: null })),
  };
}

function state(
  states: Map<string, BufferedRecomposer>,
  key: string,
  mapping: ReadonlyMap<string, string>,
): BufferedRecomposer {
  let value = states.get(key);
  if (!value) {
    value = new BufferedRecomposer(mapping);
    states.set(key, value);
  }
  return value;
}

function nextEventBoundary(
  value: string,
  fromIndex: number,
): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/g;
  match.lastIndex = fromIndex;
  const result = match.exec(value);
  return result ? { index: result.index, length: result[0].length } : null;
}
