import { loadConfig, resolveNerDetectorConfig, resolveSemanticDetectorConfig } from "./config.ts";
import { createNerDetector } from "./ner.ts";
import { createSemanticDetector } from "./semantic.ts";
import { loadSemanticEvalCases, runSemanticEvaluation } from "./semantic_eval.ts";

// `--detector=ner` scores the local NER detector on the same cases, on the
// two kinds it claims; the default scores the semantic detector on all three.
const config = await loadConfig();
const casesPath = Deno.args.find((arg) => arg.startsWith("--cases="))?.split("=")[1];
const cases = await loadSemanticEvalCases(casesPath);
const report = Deno.args.includes("--detector=ner")
  ? await (async () => {
    const settings = resolveNerDetectorConfig(config);
    if (!settings.enabled) {
      throw new Error("eval:ner requires nerDetector.enabled=true in EGRYSA_CONFIG");
    }
    const detector = createNerDetector(config);
    if (!detector) throw new Error("NER detector is unavailable");
    return await runSemanticEvaluation(cases, detector, "live", settings.baseUrl, settings.kinds);
  })()
  : await (async () => {
    const settings = resolveSemanticDetectorConfig(config);
    if (!settings.enabled) {
      throw new Error("eval:semantic requires semanticDetector.enabled=true in EGRYSA_CONFIG");
    }
    const detector = createSemanticDetector(config);
    if (!detector) throw new Error("semantic detector is unavailable");
    return await runSemanticEvaluation(
      cases,
      detector,
      "live",
      `${settings.providerId}/${settings.model}`,
    );
  })();
console.log(JSON.stringify(report, null, 2));
