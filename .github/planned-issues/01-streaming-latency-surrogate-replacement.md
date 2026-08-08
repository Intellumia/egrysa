Egrysa intercepts outbound OpenAI/Anthropic-compatible requests to dynamically detect and swap
PII/secrets with request-scoped surrogates. Currently, during active network streams, the regex
tokenization and text parsing logic introduces minor latency spikes. We need to optimize the
processing pipeline to ensure zero-copy or minimal-overhead chunk evaluation as tokens flow through
the proxy.

## Requirements

- Profile the current streaming pipeline (`src/`) to identify CPU bottlenecks during token
  evaluation.
- Optimize the in-flight surrogate map swapping logic for Server-Sent Events (SSE).
- Ensure execution remains strictly within the native Deno capability sandbox without calling
  external subprocesses.

## Entry points

- [`src/streaming.ts`](https://github.com/Intellumia/egrysa/blob/main/src/streaming.ts) —
  `recomposeOpenAiStream` is the SSE recomposition path and the main place chunk evaluation cost
  accumulates.
- [`src/surrogate.ts`](https://github.com/Intellumia/egrysa/blob/main/src/surrogate.ts) —
  `recompose`, `recomposeChecked`, and `hasSurrogateResidue` implement the in-flight surrogate map
  swapping.
- [`src/classifier.ts`](https://github.com/Intellumia/egrysa/blob/main/src/classifier.ts) — the
  `patterns` table near the top drives tokenization cost; every pattern runs over each evaluated
  span.
- [`tests/streaming_test.ts`](https://github.com/Intellumia/egrysa/blob/main/tests/streaming_test.ts)
  — five existing tests cover holdback and residue behavior and must stay green.

The sandbox constraint is enforced by the task definitions in
[`deno.json`](https://github.com/Intellumia/egrysa/blob/main/deno.json): no task grants
`--allow-run` or `--allow-ffi`, and any optimization must keep it that way.
