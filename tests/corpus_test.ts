import { expandFixtures, loadCorpus, PLACEHOLDER } from "../src/corpus.ts";

Deno.test("fixture placeholders expand deterministically from the case id", () => {
  const text = "token ghp_{{rand:alnum:36}} key {{rand:base64:40}} id AKIA{{rand:upperdigits:16}}";
  const first = expandFixtures(text, "case-1");
  const again = expandFixtures(text, "case-1");
  const other = expandFixtures(text, "case-2");
  if (first !== again) throw new Error("expansion is not deterministic");
  if (first === other) throw new Error("different cases expanded to the same values");
  if (PLACEHOLDER.test(first)) throw new Error(`a placeholder survived expansion: ${first}`);
  const token = first.match(/ghp_([A-Za-z0-9]+)/)?.[1];
  const key = first.match(/key ([A-Za-z0-9+/]+) id/)?.[1];
  const akid = first.match(/AKIA([A-Z0-9]+)/)?.[1];
  if (token?.length !== 36 || key?.length !== 40 || akid?.length !== 16) {
    throw new Error(`expanded lengths or alphabets are wrong: ${first}`);
  }
  let threw = false;
  try {
    expandFixtures("{{rand:emoji:4}}", "case-3");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("an unknown alphabet was accepted");
});

Deno.test("committed corpora hold no unexpanded placeholders after loading", async () => {
  for (const path of ["evals/cases.jsonl", "evals/adversarial.jsonl", "evals/scenarios.jsonl"]) {
    const { cases, digest } = await loadCorpus(path);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${path}: digest missing`);
    for (const item of cases) {
      if (PLACEHOLDER.test(item.prompt)) {
        throw new Error(`${path} ${item.id}: placeholder did not expand`);
      }
      PLACEHOLDER.lastIndex = 0;
    }
  }
});
