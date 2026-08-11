import { ClientRegistry, Collector } from "@boundaryml/baml";
import { b } from "../../generated/baml_client/index.js";
import type {
  LinearTicketInput,
  MastermindNextActionDecision,
  MastermindProjectPolicyInput,
  MastermindReviewDecisionContext,
  PostImplementationReview,
  PostImplementationReviewDossier,
  ProposedLinearTicketPatch,
  TicketReviewDossier,
} from "../../generated/baml_client/index.js";
import {
  setMastermindBamlUsage,
  setMastermindSpanInput,
  setMastermindSpanOutput,
  withMastermindSpan,
} from "../telemetry.js";

type MastermindBamlCallOptions = {
  collector?: Collector;
  clientRegistry?: ClientRegistry;
};

type MastermindSynthesisClientEnv = {
  baseUrl?: string;
  apiKey?: string;
};

const DEFAULT_MASTERMIND_SYNTHESIS_MODEL = "gpt-5.5";

export type MastermindDecisionProvider = {
  synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch>;
  decideNextAction(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
  ): Promise<MastermindNextActionDecision>;
  assessPostImplementationReview?(
    ticket: LinearTicketInput,
    dossier: PostImplementationReviewDossier,
  ): Promise<PostImplementationReview>;
};

export type MastermindBamlClient = {
  SynthesizeLinearTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
    options?: MastermindBamlCallOptions,
  ): Promise<ProposedLinearTicketPatch>;
  DecideNextAction(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
    options?: MastermindBamlCallOptions,
  ): Promise<MastermindNextActionDecision>;
  AssessPostImplementationReview?(
    ticket: LinearTicketInput,
    dossier: PostImplementationReviewDossier,
    options?: MastermindBamlCallOptions,
  ): Promise<PostImplementationReview>;
};

export function createMastermindSynthesisClientRegistry(
  synthesisModel: string,
  env: MastermindSynthesisClientEnv = {},
): ClientRegistry {
  const registry = new ClientRegistry();
  registry.addLlmClient("MastermindSynthesisOverride", "openai-generic", {
    base_url: env.baseUrl ?? process.env.COPILOT_PROXY_BASE_URL ?? "http://127.0.0.1:8080/v1",
    api_key: env.apiKey ?? process.env.COPILOT_PROXY_API_KEY ?? "",
    model: synthesisModel,
  });
  registry.setPrimary("MastermindSynthesisOverride");
  return registry;
}

export class GeneratedMastermindDecisionProvider implements MastermindDecisionProvider {
  private readonly client: MastermindBamlClient;
  private readonly synthesisModel: string;
  private readonly synthesisClientRegistry: ClientRegistry;

  constructor(
    client: MastermindBamlClient = b as unknown as MastermindBamlClient,
    options: {
      synthesisModel?: string;
      synthesisClientEnv?: MastermindSynthesisClientEnv;
    } = {},
  ) {
    this.client = client;
    this.synthesisModel =
      options.synthesisModel ??
      (process.env.BAML_MODEL?.trim() || DEFAULT_MASTERMIND_SYNTHESIS_MODEL);
    this.synthesisClientRegistry = createMastermindSynthesisClientRegistry(
      this.synthesisModel,
      options.synthesisClientEnv,
    );
  }

  synthesizeTicketPatch(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    dossier: TicketReviewDossier,
  ): Promise<ProposedLinearTicketPatch> {
    return withMastermindSpan(
      "mastermind.baml.synthesize_ticket_patch",
      {
        "langfuse.observation.type": "generation",
        "gen_ai.system": "baml",
        "gen_ai.operation.name": "SynthesizeLinearTicketPatch",
        "gen_ai.request.model": this.synthesisModel,
        "weavekit.mastermind.baml.operation": "synthesis",
      },
      async (span) => {
        const collector = new Collector("mastermind.synthesize-ticket-patch");
        setMastermindSpanInput(span, {
          ticket,
          project,
          dossier,
          synthesisModel: this.synthesisModel,
        });
        try {
          const result = await this.client.SynthesizeLinearTicketPatch(ticket, project, dossier, {
            collector,
            clientRegistry: this.synthesisClientRegistry,
          });
          setMastermindSpanOutput(span, result);
          return result;
        } finally {
          setMastermindBamlUsage(span, collector);
        }
      },
    );
  }

  decideNextAction(
    ticket: LinearTicketInput,
    project: MastermindProjectPolicyInput,
    review: MastermindReviewDecisionContext,
  ): Promise<MastermindNextActionDecision> {
    return withMastermindSpan(
      "mastermind.baml.decide_next_action",
      {
        "langfuse.observation.type": "generation",
        "gen_ai.system": "baml",
        "gen_ai.operation.name": "DecideNextAction",
      },
      async (span) => {
        const collector = new Collector("mastermind.decide-next-action");
        setMastermindSpanInput(span, { ticket, project, review });
        try {
          const result = await this.client.DecideNextAction(ticket, project, review, {
            collector,
          });
          setMastermindSpanOutput(span, result);
          return result;
        } finally {
          setMastermindBamlUsage(span, collector);
        }
      },
    );
  }

  assessPostImplementationReview(
    ticket: LinearTicketInput,
    dossier: PostImplementationReviewDossier,
  ): Promise<PostImplementationReview> {
    return withMastermindSpan(
      "mastermind.baml.assess_post_implementation_review",
      {
        "langfuse.observation.type": "generation",
        "gen_ai.system": "baml",
        "gen_ai.operation.name": "AssessPostImplementationReview",
        "gen_ai.request.model": this.synthesisModel,
      },
      async (span) => {
        const collector = new Collector("mastermind.assess-post-implementation-review");
        setMastermindSpanInput(span, { ticket, dossier });
        try {
          if (!this.client.AssessPostImplementationReview) {
            throw new Error("BAML client does not support post-implementation review.");
          }
          const result = await this.client.AssessPostImplementationReview(ticket, dossier, {
            collector,
            clientRegistry: this.synthesisClientRegistry,
          });
          setMastermindSpanOutput(span, result);
          return result;
        } finally {
          setMastermindBamlUsage(span, collector);
        }
      },
    );
  }
}
