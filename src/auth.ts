import { constantTimeEqual, sha256 } from "./crypto.ts";

export class InboundAuth {
  private constructor(private readonly keys: Array<{ workloadId: string; hash: string }>) {}

  static async fromEnvironment(): Promise<InboundAuth> {
    const entries = (Deno.env.get("EGRYSA_INBOUND_KEYS") ?? "").split(",").map((entry) =>
      entry.trim()
    ).filter(Boolean).map(parseEntry);
    if (!entries.length || entries.some((entry) => entry.key.length < 24)) {
      throw new Error(
        "EGRYSA_INBOUND_KEYS must contain workload_id=key entries with keys of at least 24 characters",
      );
    }
    if (new Set(entries.map((entry) => entry.workloadId)).size !== entries.length) {
      throw new Error("EGRYSA_INBOUND_KEYS contains duplicate workload IDs");
    }
    const hashed = await Promise.all(entries.map(async ({ workloadId, key }) => ({
      workloadId,
      hash: await sha256(key),
    })));
    if (new Set(hashed.map((entry) => entry.hash)).size !== hashed.length) {
      throw new Error("EGRYSA_INBOUND_KEYS assigns one key to multiple workload IDs");
    }
    return new InboundAuth(hashed);
  }

  workloadIds(): string[] {
    return this.keys.map((entry) => entry.workloadId);
  }

  async authorize(header: string | null): Promise<AuthContext | null> {
    if (!header?.startsWith("Bearer ")) return null;
    const candidate = await sha256(header.slice(7));
    let authorized: AuthContext | null = null;
    for (const entry of this.keys) {
      if (constantTimeEqual(candidate, entry.hash)) authorized = { workloadId: entry.workloadId };
    }
    return authorized;
  }
}

export interface AuthContext {
  workloadId: string;
}

function parseEntry(value: string): { workloadId: string; key: string } {
  const separator = value.indexOf("=");
  const workloadId = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (separator < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workloadId) || !key) {
    throw new Error("EGRYSA_INBOUND_KEYS entries must use workload_id=key format");
  }
  return { workloadId, key };
}
