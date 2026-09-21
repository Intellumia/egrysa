import { resolveWorkloadConfig, validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import type { AppConfig, WorkloadPolicy } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const FINANCE_KEY = "a-finance-client-key-that-is-long-enough";
const TEST_KEY = "a-test-client-key-that-is-long-enough";

async function withTwoWorkloads(
  action: (config: AppConfig, providerCalls: () => number) => Promise<void>,
): Promise<void> {
  await configureTestEnvironment();
  Deno.env.set("EGRYSA_INBOUND_KEYS", `test-workload=${TEST_KEY},finance=${FINANCE_KEY}`);
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let calls = 0;
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, () => {
    calls++;
    return Response.json({
      id: "w",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  });
  try {
    const config = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    await action(config, () => calls);
  } finally {
    await provider.shutdown();
    Deno.env.set("EGRYSA_INBOUND_KEYS", `test-workload=${TEST_KEY}`);
  }
}

function chat(key: string, content: string, model = "approved-model", provider?: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(provider ? { "x-egrysa-provider": provider } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
}

Deno.test("a workload override changes the decision for that workload only", async () => {
  await withTwoWorkloads(async (config) => {
    // Finance treats email addresses as a blocked class; everyone else transforms them.
    config.workloads = {
      finance: {
        blockKinds: [...config.policy.blockKinds, "email"],
        transformKinds: config.policy.transformKinds.filter((kind) => kind !== "email"),
      },
    };
    const gateway = await Gateway.create(config);
    const finance = await gateway.handle(chat(FINANCE_KEY, "Mail alex@example.com the file."));
    const other = await gateway.handle(chat(TEST_KEY, "Mail alex@example.com the file."));
    if (finance.status !== 403 || other.status !== 200) {
      throw new Error(`expected 403 and 200, got ${finance.status} and ${other.status}`);
    }
    if (other.headers.get("x-egrysa-decision") !== "transform") {
      throw new Error("default workload did not transform");
    }
    const denied = await finance.json();
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${denied.receiptId}`, {
        headers: { authorization: `Bearer ${FINANCE_KEY}` },
      }),
    )).json();
    if (receipt.workloadId !== "finance" || receipt.decision !== "deny") {
      throw new Error("receipt did not attribute the workload decision");
    }
    await gateway.close();
  });
});

Deno.test("a workload can be limited to approved providers and models", async () => {
  await withTwoWorkloads(async (config, providerCalls) => {
    config.workloads = {
      finance: { allowedProviders: ["local"], allowedModels: ["approved-model"] },
    };
    config.providers[1]!.allowedModels = ["approved-model", "other-model"];
    const gateway = await Gateway.create(config);
    const remote = await gateway.handle(
      chat(FINANCE_KEY, "Summarise this.", "approved-model", "remote"),
    );
    const wrongModel = await gateway.handle(chat(FINANCE_KEY, "Summarise this.", "other-model"));
    const allowed = await gateway.handle(chat(FINANCE_KEY, "Summarise this."));
    if (remote.status !== 403 || wrongModel.status !== 422 || allowed.status !== 200) {
      throw new Error(
        `expected 403, 422, 200; got ${remote.status}, ${wrongModel.status}, ${allowed.status}`,
      );
    }
    if (providerCalls() !== 1) throw new Error("a refused request reached the provider");
    const models = await (await gateway.handle(
      new Request("http://gateway/v1/models", {
        headers: { authorization: `Bearer ${FINANCE_KEY}` },
      }),
    )).json();
    const ids = models.data.map((entry: { id: string }) => entry.id);
    if (JSON.stringify(ids) !== JSON.stringify(["approved-model"])) {
      throw new Error(`model discovery was not narrowed: ${ids}`);
    }
    await gateway.close();
  });
});

Deno.test("workload overrides are validated at startup under the same rules", () => {
  const base = testConfig();
  const attempts: Array<[string, Record<string, WorkloadPolicy>, string]> = [
    ["unassigned kind", { finance: { transformKinds: ["phone"] } }, "no policy action"],
    ["unknown provider", { finance: { defaultProvider: "nowhere" } }, "does not exist"],
    ["default outside allowed", {
      finance: { defaultProvider: "remote", allowedProviders: ["local"] },
    }, "allowedProviders"],
    ["bad workload id", { "bad id!": { sensitivity: "strict" } }, "workload id"],
    ["unknown field", { finance: { colour: "red" } as never }, "unknown field"],
  ];
  for (const [name, workloads, expected] of attempts) {
    const config = structuredClone(base);
    config.workloads = workloads;
    let message = "";
    try {
      validateConfig(config);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (!message.includes(expected)) {
      throw new Error(`${name}: expected "${expected}", got "${message}"`);
    }
  }
  const good = structuredClone(base);
  good.workloads = { finance: { sensitivity: "strict", response: { blocked: "deny" } } };
  validateConfig(good);
  const resolved = resolveWorkloadConfig(good, "finance");
  if (resolved.policy.sensitivity !== "strict" || resolved.policy.response?.blocked !== "deny") {
    throw new Error("override was not applied");
  }
  if (resolveWorkloadConfig(good, "unknown").policy.sensitivity !== base.policy.sensitivity) {
    throw new Error("a workload without an override did not fall back to the global policy");
  }
});
