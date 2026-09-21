// Normalised views of a text surface for the deterministic pattern floor.
//
// The patterns match literal text. A value that is percent-encoded, escaped,
// entity-encoded, wrapped in markup, split by a line continuation, written
// with look-alike Unicode, or obfuscated with "[at]" and "[dot]" carries the
// same sensitive value in a shape the literal patterns cannot see. Pasted
// logs, request captures, templates, and configuration files are full of the
// first four, and a motivated insider will reach for the rest.
//
// Each variant here is a rewritten copy of the surface together with a map
// from every variant character back to the span of original characters it
// came from. A pattern match in a variant is reported against the original
// span, so surrogate replacement removes the encoded bytes that were actually
// present and recomposition restores them byte for byte. The decoded value is
// never persisted; it exists only to decide whether a pattern matches.
//
// Every rewrite only removes an encoding layer; nothing here guesses at
// meaning. Variants are produced only when a rewrite actually applied, so
// ordinary prose costs one scan and no allocation.

export interface TextVariant {
  readonly id: string;
  readonly text: string;
  // Map a [start, end) span in the variant back to the original text.
  toOriginal(start: number, end: number): { start: number; end: number };
}

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

type Rule = (text: string) => Edit[];

const decoder = new TextDecoder("utf-8", { fatal: true });

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  commat: "@",
  period: ".",
  colon: ":",
  num: "#",
  sol: "/",
  lowbar: "_",
  hyphen: "-",
  plus: "+",
  equals: "=",
  nbsp: " ",
};

function printableAscii(code: number): boolean {
  return code >= 0x21 && code <= 0x7e;
}

function collect(
  text: string,
  regex: RegExp,
  replace: (match: RegExpMatchArray) => string | null,
): Edit[] {
  const edits: Edit[] = [];
  for (const match of text.matchAll(regex)) {
    const replacement = replace(match);
    if (replacement === null || match.index === undefined) continue;
    edits.push({ start: match.index, end: match.index + match[0].length, replacement });
  }
  return edits;
}

// Percent-encoding as found in URLs, query strings, and proxy logs.
const percentEncoding: Rule = (text) =>
  collect(text, /%([0-9A-Fa-f]{2})/g, (match) => {
    const code = parseInt(match[1]!, 16);
    return printableAscii(code) ? String.fromCharCode(code) : null;
  });

// JSON and JavaScript string escapes for printable ASCII.
const jsonEscapes: Rule = (text) =>
  collect(text, /\\u([0-9A-Fa-f]{4})|\\(\/)/g, (match) => {
    if (match[2] !== undefined) return "/";
    const code = parseInt(match[1]!, 16);
    return printableAscii(code) ? String.fromCharCode(code) : null;
  });

// Numeric and the common named HTML entities.
const htmlEntities: Rule = (text) =>
  collect(text, /&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));/g, (match) => {
    if (match[3] !== undefined) return HTML_ENTITIES[match[3]] ?? null;
    const code = match[1] !== undefined ? Number(match[1]) : parseInt(match[2]!, 16);
    return printableAscii(code) || code === 0x20 ? String.fromCharCode(code) : null;
  });

// Markup wrapped around or inside a value, as a copied DOM fragment carries.
const htmlTags: Rule = (text) =>
  collect(text, /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, () => "");

// A backslash line continuation splitting a value across lines.
const lineContinuation: Rule = (text) => collect(text, /[ \t]*\\\r?\n[ \t]*/g, () => "");

// Full-width ASCII look-alikes, Unicode dashes, non-breaking spaces, and
// zero-width characters that hide a value from an ASCII pattern.
const LOOKALIKE_CLASS = new RegExp(
  "[" +
    "\\uFF01-\\uFF5E" + // full-width ASCII
    "\\u2010-\\u2015\\u2212\\uFE63" + // dashes and minus
    "\\u00A0\\u2007\\u202F" + // non-breaking spaces
    "\\u200B-\\u200D\\uFEFF\\u00AD" + // zero-width and soft hyphen
    "]",
  "g",
);

const unicodeLookalikes: Rule = (text) =>
  collect(text, LOOKALIKE_CLASS, (match) => {
    const code = match[0].codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    if (code === 0x00a0 || code === 0x2007 || code === 0x202f) return " ";
    if (
      code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x00ad
    ) {
      return "";
    }
    return "-";
  });

// Spelled-out or spaced email separators: "alex [at] example [dot] com",
// "alex(at)example.com", "alex @ example . com".
const obfuscatedSeparators: Rule = (text) => [
  ...collect(text, /\s*[[({<]\s*at\s*[\])}>]\s*/gi, () => "@"),
  ...collect(text, /\s*[[({<]\s*dot\s*[\])}>]\s*/gi, () => "."),
  ...collect(text, /(?<=\S) @ (?=\S)/g, () => "@"),
  ...collect(text, /(?<=\S) \. (?=[A-Za-z]{2,}(?![A-Za-z]))/g, () => "."),
];

const DECODING_RULES: Rule[] = [
  percentEncoding,
  jsonEscapes,
  htmlEntities,
  htmlTags,
  lineContinuation,
  unicodeLookalikes,
  obfuscatedSeparators,
];

// Base64 runs whose decoded bytes are ordinary text. Hashes, digests, and
// binary blobs share the alphabet but decode to bytes that fail the UTF-8 and
// control-character checks, so they produce no variant.
const BASE64_RUN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/g;
const MAX_BASE64_RUN = 64 * 1024;

function decodeBase64Text(run: string): string | null {
  if (run.length % 4 !== 0 || run.length > MAX_BASE64_RUN) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(run), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    if (control || code === 0x7f) return null;
  }
  return text;
}

const base64Text: Rule = (text) => collect(text, BASE64_RUN, (match) => decodeBase64Text(match[0]));

function applyEdits(id: string, original: string, edits: Edit[]): TextVariant | null {
  if (edits.length === 0) return null;
  // Earlier rules take precedence; a later edit overlapping an accepted one is
  // dropped rather than composed, so every variant character maps to exactly
  // one original span.
  const accepted: Edit[] = [];
  const sorted = edits.map((edit, order) => ({ edit, order })).sort((a, b) =>
    a.edit.start - b.edit.start || a.order - b.order
  );
  let cursor = 0;
  for (const { edit } of sorted) {
    if (edit.start < cursor) continue;
    accepted.push(edit);
    cursor = edit.end;
  }
  let text = "";
  const spanStart: number[] = [];
  const spanEnd: number[] = [];
  let position = 0;
  const copy = (from: number, to: number) => {
    for (let index = from; index < to; index++) {
      spanStart.push(index);
      spanEnd.push(index + 1);
    }
    text += original.slice(from, to);
  };
  for (const edit of accepted) {
    copy(position, edit.start);
    for (let index = 0; index < edit.replacement.length; index++) {
      spanStart.push(edit.start);
      spanEnd.push(edit.end);
    }
    text += edit.replacement;
    position = edit.end;
  }
  copy(position, original.length);
  if (text === original) return null;
  return {
    id,
    text,
    toOriginal(start, end) {
      if (start >= end || start < 0 || end > text.length) throw new RangeError("invalid span");
      return { start: spanStart[start]!, end: spanEnd[end - 1]! };
    },
  };
}

export function textVariants(original: string): TextVariant[] {
  const variants: TextVariant[] = [];
  const decoded = applyEdits(
    "decoded",
    original,
    DECODING_RULES.flatMap((rule) => rule(original)),
  );
  if (decoded) variants.push(decoded);
  const base64 = applyEdits("base64", original, base64Text(original));
  if (base64) variants.push(base64);
  return variants;
}
