// Throughput of the streaming recomposition path.
//
// Run with `deno task bench`. The shapes below vary the two things that drive
// cost: how many surrogates a request produced, and how many SSE chunks the
// provider emits. Recomposition work is per chunk and per token, so a wide
// mapping over a long stream is the case worth watching.
import { recomposeOpenAiStream } from "../src/streaming.ts";

const encoder = new TextEncoder();

function surrogate(kind: string, index: number): string {
  return `__EGRYSA_${kind}_${String(index).padStart(4, "0")}_aabbccddee${index % 10}f__`;
}

function buildMapping(count: number): Map<string, string> {
  const mapping = new Map<string, string>();
  for (let index = 1; index <= count; index++) {
    mapping.set(surrogate("EMAIL", index), `person${index}@example.com`);
  }
  return mapping;
}

// A realistic stream: mostly ordinary prose, with surrogates sprinkled through.
function buildChunks(mapping: Map<string, string>, chunks: number): string[] {
  const tokens = [...mapping.keys()];
  const prose = "The quarterly report is attached and the summary follows. ";
  const pieces: string[] = [];
  for (let index = 0; index < chunks; index++) {
    const token = tokens.length > 0 && index % 8 === 0 ? tokens[index % tokens.length] ?? "" : "";
    pieces.push(token ? `${token} ` : prose.slice(0, 24));
  }
  return pieces;
}

function sse(pieces: string[]): Uint8Array {
  const frames = pieces.map((content) =>
    `data: ${
      JSON.stringify({
        id: "bench",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })
    }\n\n`
  );
  frames.push("data: [DONE]\n\n");
  return encoder.encode(frames.join(""));
}

async function run(body: Uint8Array, mapping: ReadonlyMap<string, string>): Promise<void> {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      // One enqueue per SSE frame keeps the per-chunk path honest.
      controller.enqueue(body);
      controller.close();
    },
  });
  const out = recomposeOpenAiStream(upstream, mapping, () => {}, () => {});
  const reader = out.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

const shapes: Array<[string, number, number]> = [
  ["no surrogates, 200 chunks", 0, 200],
  ["1 surrogate, 200 chunks", 1, 200],
  ["8 surrogates, 200 chunks", 8, 200],
  ["32 surrogates, 200 chunks", 32, 200],
  ["32 surrogates, 800 chunks", 32, 800],
];

for (const [name, tokens, chunks] of shapes) {
  const mapping = buildMapping(tokens);
  const body = sse(buildChunks(mapping, chunks));
  Deno.bench(name, async () => {
    await run(body, mapping);
  });
}
