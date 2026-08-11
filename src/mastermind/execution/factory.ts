import { MastermindHarnessTransport, type WeavekitConfig } from "../../config.js";
import {
  HerdrDirectExecutor,
  HerdrWorkspaceProvisioner,
  LocalExecutionCommandRunner,
} from "../../submind/index.js";
import { PostImplementationReviewCoordinator } from "../codeReview/coordinator.js";
import { createCodeReviewHarness } from "../codeReview/harness.js";
import { GeneratedMastermindDecisionProvider } from "../decision/bamlAdapters.js";
import type { LinearGateway } from "../linear/client.js";
import type { MastermindStore } from "../store/store.js";
import { MastermindExecutionCoordinator } from "./coordinator.js";

export function createMastermindExecutionCoordinator(
  config: WeavekitConfig,
  store: MastermindStore,
  linear: LinearGateway,
  onProgress?: (message: string) => void,
): MastermindExecutionCoordinator | undefined {
  if (!config.mastermind.execution) {
    return undefined;
  }
  const runner = new LocalExecutionCommandRunner();
  const implementationHarness = config.mastermind.harnesses?.implementation;
  const executionConfig = {
    ...config.mastermind.execution,
    harnessKind: implementationHarness?.kind ?? config.mastermind.execution.harnessKind,
    harnessCommand: implementationHarness?.command,
    harnessArgs: implementationHarness?.args,
  };
  return new MastermindExecutionCoordinator(
    config,
    store,
    linear,
    new HerdrWorkspaceProvisioner(),
    new HerdrDirectExecutor(executionConfig, undefined, runner),
    runner,
    onProgress,
    new PostImplementationReviewCoordinator(
      config,
      store,
      linear,
      createCodeReviewHarness(
        config.mastermind.harnesses?.codeReview ?? {
          transport: MastermindHarnessTransport.COMMAND,
          command: "copilot",
          args: ["--autopilot", "--allow-all", "--no-ask-user", "-p", "{prompt}"],
        },
      ),
      new GeneratedMastermindDecisionProvider(),
    ),
  );
}
