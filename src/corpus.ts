// Fixture expansion for the evaluation corpora.
//
// A committed fixture must not be a credential-shaped string. GitHub push
// protection and the CI secret scanner block such a push, and the way around
// that, values a scanner ignores because they are obviously fake, is exactly
// the kind of fixture that measures nothing: the sequential alphabets and
// EXAMPLE-ONLY markers the corpora used to carry are allowlisted by every
// scanner the project has been compared against.
//
// So a fixture carries a placeholder, `{{rand:<alphabet>:<length>}}`, that is
// expanded when the corpus is loaded. The characters come from a generator
// seeded by the case id and the placeholder's position, so the same case
// expands to the same bytes on every run and every machine, results stay
// reproducible, and the committed file contains nothing a scanner recognises.
// The expanded values never leave the evaluation process unless an operator
// asks the report tool to write them out.

export const PLACEHOLDER = /\{\{rand:([a-z0-9]+):(\d{1,4})\}\}/g;

const ALPHABETS: Record<string, string> = {
  digits: "0123456789",
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  alpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  alnum: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  upperdigits: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  hex: "0123456789abcdef",
  base64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  urlsafe: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
};

export interface CorpusCase {
  id: string;
  prompt: string;
}

export interface LoadedCorpus<T extends CorpusCase> {
  cases: T[];
  // SHA-256 of the committed file, so a report can name the exact corpus
  // version it measured.
  digest: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// Deterministic, not cryptographic: the point is reproducibility, not
// secrecy. The values only have to look like what a scanner or a pattern
// expects, and to differ from case to case.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function expandFixtures(text: string, seed: string): string {
  let occurrence = 0;
  return text.replace(PLACEHOLDER, (_whole, alphabet: string, length: string) => {
    const chars = ALPHABETS[alphabet];
    if (!chars) throw new Error(`unknown placeholder alphabet "${alphabet}" in ${seed}`);
    const next = mulberry32(fnv1a(`${seed}#${occurrence++}`));
    let value = "";
    for (let index = 0; index < Number(length); index++) {
      value += chars[Math.floor(next() * chars.length)];
    }
    return value;
  });
}

export async function loadCorpus<T extends CorpusCase>(path: string): Promise<LoadedCorpus<T>> {
  const raw = await Deno.readTextFile(path);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const cases = raw.trim().split("\n").filter((line) => line.trim()).map((line) => {
    const item = JSON.parse(line) as T;
    return { ...item, prompt: expandFixtures(item.prompt, item.id) };
  });
  return { cases, digest };
}
