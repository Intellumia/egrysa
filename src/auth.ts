import { constantTimeEqual, sha256 } from "./crypto.ts";

// Two roles. A caller key submits requests and reads its own workload's
// receipts. An auditor key, from a separate variable so it can be issued and
// rotated by a different team, reads every workload's receipts and the
// metrics, and cannot submit anything.
export type Role = "caller" | "auditor";

interface KeyEntry {
  workloadId: string;
  hash: string;
  role: Role;
}

export class InboundAuth {
  private constructor(private readonly keys: KeyEntry[]) {}

  static async fromEnvironment(): Promise<InboundAuth> {
    const callers = parseVariable("EGRYSA_INBOUND_KEYS", "caller", true);
    const auditors = parseVariable("EGRYSA_AUDITOR_KEYS", "auditor", false);
    const entries = [...callers, ...auditors];
    if (new Set(entries.map((entry) => entry.workloadId)).size !== entries.length) {
      throw new Error("inbound keys contain duplicate workload IDs across caller and auditor keys");
    }
    const hashed = await Promise.all(entries.map(async ({ workloadId, key, role }) => ({
      workloadId,
      role,
      hash: await sha256(key),
    })));
    if (new Set(hashed.map((entry) => entry.hash)).size !== hashed.length) {
      throw new Error("inbound keys assign one key to multiple workload IDs");
    }
    return new InboundAuth(hashed);
  }

  workloadIds(): string[] {
    return this.keys.filter((entry) => entry.role === "caller").map((entry) => entry.workloadId);
  }

  async authorize(header: string | null): Promise<AuthContext | null> {
    if (!header?.startsWith("Bearer ")) return null;
    const candidate = await sha256(header.slice(7));
    let authorized: AuthContext | null = null;
    for (const entry of this.keys) {
      if (constantTimeEqual(candidate, entry.hash)) {
        authorized = { workloadId: entry.workloadId, role: entry.role };
      }
    }
    return authorized;
  }
}

export interface AuthContext {
  workloadId: string;
  role: Role;
}

function parseVariable(
  name: string,
  role: Role,
  required: boolean,
): Array<{ workloadId: string; key: string; role: Role }> {
  const entries = (Deno.env.get(name) ?? "").split(",").map((entry) => entry.trim())
    .filter(Boolean).map((entry) => ({ ...parseEntry(entry, name), role }));
  if (required && !entries.length) {
    throw new Error(`${name} must contain workload_id=key entries`);
  }
  if (entries.some((entry) => entry.key.length < 24)) {
    throw new Error(`${name} keys must be at least 24 characters`);
  }
  return entries;
}

function parseEntry(value: string, name: string): { workloadId: string; key: string } {
  const separator = value.indexOf("=");
  const workloadId = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (separator < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workloadId) || !key) {
    throw new Error(`${name} entries must use workload_id=key format`);
  }
  return { workloadId, key };
}
