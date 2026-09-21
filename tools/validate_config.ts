// Validate a configuration file without starting the gateway, for a change
// ticket or a CI step before a rollout.
//
//   deno task config:check [path]        (default: $EGRYSA_CONFIG or config/egrysa.example.json)
//
// Prints the file's SHA-256 so the ticket can name exactly what was
// validated, and exits 1 with the validator's message on the first error.

import { loadConfig } from "../src/config.ts";
import { sha256 } from "../src/crypto.ts";

const path = Deno.args[0] ?? Deno.env.get("EGRYSA_CONFIG") ?? "config/egrysa.example.json";
try {
  const text = await Deno.readTextFile(path);
  const config = await loadConfig(path);
  console.log(JSON.stringify(
    {
      ok: true,
      path,
      sha256: await sha256(text),
      schemaVersion: config.schemaVersion ?? 1,
      providers: config.providers.map((provider) => provider.id),
      workloads: Object.keys(config.workloads ?? {}),
    },
    null,
    2,
  ));
} catch (error) {
  console.log(JSON.stringify({ ok: false, path, error: (error as Error).message }, null, 2));
  Deno.exit(1);
}
