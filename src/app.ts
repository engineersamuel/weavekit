import { loadMastermindRuntimeConfig } from "./config.js";
import {
  createMastermindApp,
  createMastermindExecutionCoordinator,
  GeneratedMastermindDecisionProvider,
  createTicketReviewHarness,
  LinearGraphQlGateway,
  MastermindDecisionLoop,
  MastermindService,
  SqliteMastermindStore,
  validateMastermindRuntimeConfig,
} from "./mastermind/index.js";

const config = await loadMastermindRuntimeConfig();
validateMastermindRuntimeConfig(config.mastermind, process.env);
const store = new SqliteMastermindStore(config.mastermind.sqlitePath);
const linear = new LinearGraphQlGateway(process.env.LINEAR_API_KEY!);
const decisions = new GeneratedMastermindDecisionProvider(undefined, {
  synthesisModel: config.mastermind.synthesisModel,
});
const reviewHarness = createTicketReviewHarness(config);
const loop = new MastermindDecisionLoop(config, store, linear, decisions, reviewHarness);
const service = new MastermindService(
  config.mastermind,
  store,
  loop,
  createMastermindExecutionCoordinator(config, store, linear),
);
await service.start();

const app = createMastermindApp({
  config: config.mastermind,
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  store,
  service,
});

export default app;
