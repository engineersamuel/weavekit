import { MastermindHarnessTransport, type WeavekitConfig } from "../../config.js";
import {
  ExecutorKind,
  HerdrDirectExecutor,
  HerdrWorkspaceProvisioner,
  LocalExecutionCommandRunner,
  RlmDirectExecutor,
} from "../../submind/index.js";
import { PostImplementationReviewCoordinator } from "../codeReview/coordinator.js";
import { createCodeReviewHarness } from "../codeReview/harness.js";
import { GeneratedMastermindDecisionProvider } from "../decision/bamlAdapters.js";
import type { LinearGateway } from "../linear/client.js";
import { SelfImprovementCoordinator } from "../selfImprovement/coordinator.js";
import { LangfusePublicApiTraceFetcher } from "../selfImprovement/langfuseClient.js";
import type { MastermindStore } from "../store/store.js";
import { MastermindExecutionCoordinator, type DirectExecutorResolver } from "./coordinator.js";

export function createMastermindExecutionCoordinator(
  config: WeavekitConfig,
  store: MastermindStore,
  linear: LinearGateway,
  onProgress?: (message: string) => void,
): MastermindExecutionCoordinator | undefined {
  if (!config.mastermind.execution && !config.mastermind.rlmExecution) {
    return undefined;
  }
  const runner = new LocalExecutionCommandRunner();
  const executors: DirectExecutorResolver = {};
  if (config.mastermind.execution) {
    const implementationHarness = config.mastermind.harnesses?.implementation;
    const executionConfig = {
      ...config.mastermind.execution,
      harnessKind: implementationHarness?.kind ?? config.mastermind.execution.harnessKind,
      harnessCommand: implementationHarness?.command,
      harnessArgs: implementationHarness?.args,
    };
    executors[ExecutorKind.HERDR_COPILOT] = new HerdrDirectExecutor(
      executionConfig,
      undefined,
      runner,
    );
  }
  if (config.mastermind.rlmExecution) {
    executors[ExecutorKind.RLM_SUBMIND] = new RlmDirectExecutor(
      config.mastermind.rlmExecution,
      undefined,
      runner,
    );
  }
  return new MastermindExecutionCoordinator(
    config,
    store,
    linear,
    new HerdrWorkspaceProvisioner(),
    executors,
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
    config.mastermind.selfImprovement?.enabled
      ? new SelfImprovementCoordinator(
          config,
          store,
          linear,
          new LangfusePublicApiTraceFetcher(),
          new GeneratedMastermindDecisionProvider(),
        )
      : undefined,
  );
}
