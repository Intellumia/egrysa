import type {
  ChatRequest,
  ProviderCapabilities,
  ProviderCapabilityKey,
  ProviderConfig,
} from "./types.ts";

const OPENAI_COMPATIBLE_CAPABILITIES: ProviderCapabilities = {
  temperature: true,
  max_tokens: true,
  seed: true,
  top_p: true,
  frequency_penalty: true,
  presence_penalty: true,
  tools: true,
  tool_choice: true,
  parallel_tool_calls: true,
  stream: true,
  stream_options: true,
};

export const PROVIDER_CAPABILITY_TABLE: Readonly<
  Record<ProviderConfig["kind"], Readonly<ProviderCapabilities>>
> = {
  openai: OPENAI_COMPATIBLE_CAPABILITIES,
  "openai-compatible": OPENAI_COMPATIBLE_CAPABILITIES,
  anthropic: {
    temperature: true,
    max_tokens: true,
    seed: false,
    top_p: false,
    frequency_penalty: false,
    presence_penalty: false,
    tools: true,
    tool_choice: true,
    parallel_tool_calls: false,
    stream: true,
    stream_options: true,
  },
};

export const DROPPABLE_CAPABILITIES = [
  "seed",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "parallel_tool_calls",
] as const satisfies readonly ProviderCapabilityKey[];

export interface PreparedProviderRequest {
  request: ChatRequest;
  downgraded: string[];
}

export class ProviderCapabilityError extends Error {
  constructor(readonly capability: ProviderCapabilityKey) {
    super(`provider does not support requested capability: ${capability}`);
  }
}

export function resolveProviderCapabilities(provider: ProviderConfig): ProviderCapabilities {
  return { ...PROVIDER_CAPABILITY_TABLE[provider.kind], ...provider.capabilities };
}

export function prepareProviderRequest(
  provider: ProviderConfig,
  request: ChatRequest,
): PreparedProviderRequest {
  const capabilities = resolveProviderCapabilities(provider);
  const prepared = structuredClone(request);
  const downgraded: string[] = [];
  for (const key of DROPPABLE_CAPABILITIES) {
    if (request[key] === undefined || capabilities[key]) continue;
    delete prepared[key];
    downgraded.push(key);
  }
  for (const key of ["temperature", "max_tokens"] as const) {
    if (request[key] !== undefined && !capabilities[key]) throw new ProviderCapabilityError(key);
  }
  const usesTools = !!request.tools?.length && request.tool_choice !== "none";
  if (usesTools && !capabilities.tools) throw new ProviderCapabilityError("tools");
  if (
    usesTools && request.tool_choice !== undefined && request.tool_choice !== "auto" &&
    !capabilities.tool_choice
  ) throw new ProviderCapabilityError("tool_choice");
  if (usesTools && request.tool_choice === "auto" && !capabilities.tool_choice) {
    delete prepared.tool_choice;
  }
  if (request.stream && !capabilities.stream) throw new ProviderCapabilityError("stream");
  if (request.stream_options !== undefined && !capabilities.stream_options) {
    throw new ProviderCapabilityError("stream_options");
  }
  if (!usesTools) {
    delete prepared.tools;
    delete prepared.tool_choice;
    delete prepared.parallel_tool_calls;
  }
  return { request: prepared, downgraded };
}
