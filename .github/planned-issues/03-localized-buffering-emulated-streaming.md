Anthropic streaming is currently buffered upstream and emitted as OpenAI SSE only after the full
response is available (explicitly flagged via the `x-egrysa-downgraded: stream-emulated` header). To
support smooth enterprise workflows, we need a refined, local buffering and emulation mechanism that
handles native stream chunking safely.

## Requirements

- Design a lightweight, memory-efficient local buffer to ingest upstream provider token chunks.
- Seamlessly transition the buffered payload into compliant OpenAI-style SSE token streams.
- Ensure bounded holdback recomposition works accurately without dropping token characters.

## Entry points

- [`src/providers.ts`](https://github.com/Intellumia/egrysa/blob/main/src/providers.ts) —
  `emulateOpenAiStream` is the current buffered emulation, and `invokeProvider` is the call path
  that reaches it.
- [`src/bounded.ts`](https://github.com/Intellumia/egrysa/blob/main/src/bounded.ts) —
  `readBoundedBytes` and `readBoundedText` define the existing memory bounds any new buffer should
  respect rather than bypass.
- [`src/streaming.ts`](https://github.com/Intellumia/egrysa/blob/main/src/streaming.ts) —
  `recomposeOpenAiStream` implements the bounded holdback that must keep working across chunk
  boundaries.
- [`src/provider_capabilities.ts`](https://github.com/Intellumia/egrysa/blob/main/src/provider_capabilities.ts)
  — declares native versus emulated streaming per provider and drives the disclosure header.
- [`tests/providers_test.ts`](https://github.com/Intellumia/egrysa/blob/main/tests/providers_test.ts)
  and
  [`tests/streaming_test.ts`](https://github.com/Intellumia/egrysa/blob/main/tests/streaming_test.ts)
  — existing stream coverage.

The `x-egrysa-downgraded: stream-emulated` disclosure must remain accurate: if a path stops being
emulated, the capability table and the header have to change together.
