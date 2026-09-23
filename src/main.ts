import { loadConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { EGRYSA_VERSION } from "./version.ts";

// A packaged binary is asked what it is and how to start it before it is
// asked to run, so answer both without reading configuration or opening a
// port. Everything else about the process is unchanged.
if (Deno.args.includes("--version") || Deno.args.includes("-V")) {
  console.log(JSON.stringify({ name: "egrysa", version: EGRYSA_VERSION }));
  Deno.exit(0);
}
if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
  console.log(
    [
      `egrysa ${EGRYSA_VERSION}`,
      "",
      "A customer-owned AI egress boundary. It reads its configuration from the",
      "file named by EGRYSA_CONFIG and listens on the host and port that file sets.",
      "",
      "Usage:",
      "  EGRYSA_CONFIG=/path/to/egrysa.json egrysa",
      "  egrysa --version",
      "",
      "Keys come from the environment: EGRYSA_INBOUND_KEYS,",
      "EGRYSA_RECEIPT_FINGERPRINT_KEY, EGRYSA_RECEIPT_ED25519_PRIVATE_KEY, and",
      "EGRYSA_RECEIPT_ED25519_PUBLIC_KEY. Operations, policy, and runbooks:",
      "https://github.com/Intellumia/egrysa/tree/main/docs",
    ].join("\n"),
  );
  Deno.exit(0);
}

const config = await loadConfig();
const gateway = await Gateway.create(config);

console.log(
  JSON.stringify({
    level: "info",
    event: "gateway_started",
    hostname: config.listen.hostname,
    port: config.listen.port,
  }),
);
const server = Deno.serve(
  { ...config.listen, onListen: () => undefined },
  (request) => gateway.handle(request),
);
let shutdownRequested = false;
const requestShutdown = () => {
  if (shutdownRequested) return;
  shutdownRequested = true;
  void server.shutdown();
};
Deno.addSignalListener("SIGINT", requestShutdown);
Deno.addSignalListener("SIGTERM", requestShutdown);
try {
  await server.finished;
} finally {
  Deno.removeSignalListener("SIGINT", requestShutdown);
  Deno.removeSignalListener("SIGTERM", requestShutdown);
  await gateway.close();
}
