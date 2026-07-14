import { readFileSync } from "node:fs";
import type { ApiProvider } from "promptfoo";
import PromptfooRouterProvider, { type ProviderOptions } from "./promptfoo-router-provider.js";

type ProviderCallContext = Parameters<ApiProvider["callApi"]>[1];

type IsolatedProviderInput = {
  options: ProviderOptions;
  prompt: string;
  vars?: NonNullable<ProviderCallContext>["vars"];
};

async function main(): Promise<void> {
  const marker = process.env.WEAVEKIT_ROUTER_RESULT_MARKER;
  if (!marker) {
    throw new Error("WEAVEKIT_ROUTER_RESULT_MARKER is required.");
  }
  const input = JSON.parse(readFileSync(0, "utf8")) as IsolatedProviderInput;
  const provider = new PromptfooRouterProvider(input.options);
  const response = await provider.callApi(input.prompt, {
    prompt: {
      raw: input.prompt,
      label: "Router eval prompt",
    },
    vars: input.vars ?? {},
  });
  process.stdout.write(`${marker}${JSON.stringify(response)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
