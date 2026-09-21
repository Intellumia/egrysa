// Format-preserving synthetic surrogates.
//
// A sentinel token such as __EGRYSA_EMAIL_0001_ab12cd__ is unmistakable to a
// reviewer and to the residue audit, but a model treats it as noise and the
// answer suffers. A synthetic value in the same shape as the original reads
// naturally: the model addresses "Alder Voss" instead of a token, and local
// recomposition puts the real name back. Every value here comes from a
// reserved or fictional range so it can never collide with a real person,
// host, or account: RFC 2606 domains, TEST-NET addresses, the 555-01xx phone
// block, the 2001:db8::/32 prefix, locally administered MAC addresses, and
// fabricated names.
//
// Generation is deterministic from the bytes it is given. With random bytes a
// value is fresh per request; with a keyed hash of the original it is the same
// for the same original every time, which is what durable pseudonyms need.
import type { FindingKind } from "./types.ts";

const FIRST = [
  "Alder",
  "Bria",
  "Casimir",
  "Dalia",
  "Emeric",
  "Farah",
  "Galen",
  "Hollis",
  "Idris",
  "Juno",
  "Kasper",
  "Liora",
  "Marek",
  "Nadia",
  "Orin",
  "Priya",
  "Quillon",
  "Rosalind",
  "Soren",
  "Tamsin",
  "Ulric",
  "Vesna",
  "Wren",
  "Xavier",
  "Yara",
  "Zev",
  "Amara",
  "Bastian",
  "Celeste",
  "Dorian",
  "Elspeth",
  "Fenwick",
  "Greta",
  "Hamish",
  "Ines",
  "Jorah",
  "Kiran",
  "Lucan",
  "Mira",
  "Nikolai",
  "Odile",
  "Percival",
  "Radha",
  "Silas",
  "Thea",
  "Ulla",
  "Viggo",
  "Willa",
  "Yusuf",
  "Zora",
  "Anselm",
  "Beatrix",
  "Corin",
  "Delphine",
  "Eamon",
  "Freya",
  "Gideon",
  "Helka",
  "Ivo",
  "Jessamy",
  "Kenji",
  "Leda",
  "Matthias",
  "Noor",
];
const LAST = [
  "Voss",
  "Halloran",
  "Okafor",
  "Lindqvist",
  "Marchetti",
  "Abernathy",
  "Sato",
  "Delacroix",
  "Ferreira",
  "Novak",
  "Okonkwo",
  "Bergstrom",
  "Castellano",
  "Whitlock",
  "Nakamura",
  "Petrov",
  "Ashdown",
  "Kowalczyk",
  "Mbeki",
  "Reinholt",
  "Sandoval",
  "Tremblay",
  "Uzoma",
  "Valcourt",
  "Weatherby",
  "Yamazaki",
  "Zielinski",
  "Arbogast",
  "Brannigan",
  "Cavanaugh",
  "Dresden",
  "Eskildsen",
  "Fairweather",
  "Galbraith",
  "Hartigan",
  "Ivashkov",
  "Jaramillo",
  "Kettering",
  "Lockridge",
  "Mendonca",
  "Nightingale",
  "Oyelaran",
  "Pemberton",
  "Quintrell",
  "Rasmussen",
  "Steadman",
  "Thackeray",
  "Underhill",
  "Varga",
  "Wolstenholme",
  "Xiang",
  "Yeardley",
  "Zabinski",
  "Amsel",
  "Birchwood",
  "Coelho",
  "Duvalier",
  "Ekwueme",
  "Fjeldstad",
  "Grimaldi",
  "Hollingsworth",
  "Iyengar",
  "Jorgensen",
  "Kirkbride",
];
const STREETS = [
  "Alder",
  "Birch",
  "Cedar",
  "Dunmore",
  "Elm",
  "Fenwick",
  "Garnet",
  "Harbour",
  "Iron",
  "Juniper",
  "Kestrel",
  "Larch",
  "Meadow",
  "Norfolk",
  "Orchard",
  "Pembroke",
  "Quarry",
  "Rowan",
  "Sable",
  "Thistle",
  "Union",
  "Vale",
  "Willow",
  "Yew",
];
const STREET_TYPES = ["Street", "Road", "Avenue", "Lane", "Crescent", "Way", "Terrace", "Close"];
const TOWNS = [
  "Ashford",
  "Brackley",
  "Corwen",
  "Dunholme",
  "Eskdale",
  "Farleigh",
  "Glenmoor",
  "Hexley",
  "Inverlee",
  "Kelbrook",
  "Lynmouth",
  "Marlow",
  "Norbury",
  "Oakhurst",
  "Pendle",
  "Rydal",
  "Stanwick",
  "Thornbury",
  "Ulverton",
  "Wexcombe",
];
const ORG_A = [
  "Northwind",
  "Bluestone",
  "Harborlight",
  "Ironvale",
  "Kestrel",
  "Meridian",
  "Oakridge",
  "Pinecrest",
  "Redfern",
  "Silverbrook",
  "Tidewater",
  "Westmark",
  "Ashgrove",
  "Copperfield",
  "Greyhaven",
  "Lakeshore",
];
const ORG_B = [
  "Holdings",
  "Logistics",
  "Analytics",
  "Partners",
  "Systems",
  "Capital",
  "Industries",
  "Labs",
  "Foundry",
  "Dynamics",
  "Advisory",
  "Networks",
  "Ventures",
  "Biosciences",
  "Fabrication",
  "Textiles",
];
const ORG_C = ["Ltd", "Inc", "GmbH", "LLC", "Pte Ltd", "AG", "SA", "Pty Ltd"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Deterministic 16-bit draws from a byte string, wrapping with a counter once
// the bytes are consumed so long values still differ per draw.
class Draws {
  #index = 0;
  #wrap = 0;
  constructor(private readonly bytes: Uint8Array) {
    if (bytes.length < 2) throw new Error("synthetic surrogate needs at least two bytes");
  }
  next(): number {
    const hi = this.bytes[this.#index % this.bytes.length]!;
    const lo = this.bytes[(this.#index + 1) % this.bytes.length]!;
    this.#index += 2;
    if (this.#index >= this.bytes.length) {
      this.#index = 0;
      this.#wrap++;
    }
    return ((hi << 8) | lo) ^ (this.#wrap * 0x9e37);
  }
  pick<T>(list: readonly T[]): T {
    return list[this.next() % list.length]!;
  }
  range(low: number, high: number): number {
    return low + (this.next() % (high - low + 1));
  }
}

export function canSynthesize(kind: FindingKind): boolean {
  return kind in GENERATORS;
}

export function synthesize(kind: FindingKind, bytes: Uint8Array): string | null {
  const generator = GENERATORS[kind];
  return generator ? generator(new Draws(bytes)) : null;
}

const HEX = "0123456789abcdef";
const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const VIN_VALUES: Record<string, number> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};

function person(draws: Draws): string {
  return `${draws.pick(FIRST)} ${draws.pick(LAST)}`;
}

function hexGroups(draws: Draws, groups: number, width: number, separator: string): string {
  const out: string[] = [];
  for (let group = 0; group < groups; group++) {
    let value = "";
    for (let index = 0; index < width; index++) value += HEX[draws.next() % 16]!;
    out.push(value);
  }
  return out.join(separator);
}

function luhnComplete(prefix: string): string {
  const digits = [...prefix].map(Number);
  let sum = 0;
  let double = true;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = digits[index]!;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return prefix + String((10 - (sum % 10)) % 10);
}

function ibanWithCheck(country: string, bban: string): string {
  const rearranged = `${bban}${country}00`;
  const numeric = [...rearranged].map((char) =>
    /\d/.test(char) ? char : String(char.charCodeAt(0) - 55)
  ).join("");
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  const check = String(98 - remainder).padStart(2, "0");
  return `${country}${check}${bban}`;
}

const GENERATORS: Partial<Record<FindingKind, (draws: Draws) => string>> = {
  person_name: person,
  email: (draws) => {
    const name = person(draws).toLowerCase().replace(" ", ".");
    return `${name}${draws.range(2, 97)}@example.net`;
  },
  phone: (draws) =>
    `(${draws.range(200, 989)}) 555-01${String(draws.range(0, 99)).padStart(2, "0")}`,
  ipv4: (draws) => `${draws.pick(["192.0.2", "198.51.100", "203.0.113"])}.${draws.range(1, 254)}`,
  ipv6: (draws) => `2001:db8:${hexGroups(draws, 6, 4, ":")}`,
  mac_address: (draws) => `02:${hexGroups(draws, 5, 2, ":")}`,
  iban: (draws) => {
    let account = "";
    for (let index = 0; index < 14; index++) account += String(draws.next() % 10);
    return ibanWithCheck("GB", `SYNT${account}`);
  },
  // Blocked classes are never surrogated, but a card number in a
  // transformable configuration still gets a Luhn-valid synthetic.
  credit_card: (draws) => {
    let body = "411111";
    for (let index = 0; index < 9; index++) body += String(draws.next() % 10);
    return luhnComplete(body);
  },
  physical_address: (draws) =>
    `${draws.range(1, 240)} ${draws.pick(STREETS)} ${draws.pick(STREET_TYPES)}, ${
      draws.pick(TOWNS)
    }`,
  organization: (draws) => `${draws.pick(ORG_A)} ${draws.pick(ORG_B)} ${draws.pick(ORG_C)}`,
  date_of_birth: (draws) =>
    `${draws.range(1, 28)} ${draws.pick(MONTHS)} ${draws.range(1950, 2004)}`,
  crypto_wallet: (draws) => `0x${hexGroups(draws, 1, 40, "")}`,
  vin: (draws) => {
    const chars: string[] = [];
    for (let index = 0; index < 17; index++) chars.push(draws.pick([...VIN_ALPHABET]));
    let sum = 0;
    for (const [index, char] of chars.entries()) {
      if (index === 8) continue;
      sum += (/\d/.test(char) ? Number(char) : VIN_VALUES[char]!) * VIN_WEIGHTS[index]!;
    }
    const remainder = sum % 11;
    chars[8] = remainder === 10 ? "X" : String(remainder);
    return chars.join("");
  },
};
