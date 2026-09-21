import { renderProviderSupportMatrix } from "./conformance.ts";
import type { ProviderConfig } from "../src/types.ts";

const start = "<!-- provider-matrix:start -->";
const end = "<!-- provider-matrix:end -->";
const reports: Partial<Record<ProviderConfig["kind"], string>> = {};
try {
  for await (const entry of Deno.readDir("evals/conformance")) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    // Match the longer kind first because openai-compatible filenames also start with openai-.
    for (
      const kind of [
        "openai-compatible",
        "azure-openai",
        "anthropic",
        "bedrock",
        "vertex",
        "openai",
      ] as const
    ) {
      if (!entry.name.startsWith(`${kind}-`)) continue;
      const current = reports[kind];
      const candidate = `evals/conformance/${entry.name}`;
      if (!current || candidate > current) reports[kind] = candidate;
      break;
    }
  }
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
const readme = await Deno.readTextFile("README.md");
const begin = readme.indexOf(start);
const finish = readme.indexOf(end);
if (begin === -1 || finish === -1 || finish < begin) {
  throw new Error("README provider matrix markers are missing");
}
const matrix = renderProviderSupportMatrix(reports);
const updated = `${readme.slice(0, begin + start.length)}\n\n${matrix}\n\n${readme.slice(finish)}`;
await Deno.writeTextFile("README.md", updated);
