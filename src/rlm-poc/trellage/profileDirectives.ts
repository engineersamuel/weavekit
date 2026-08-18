import { TrellageMode, type TrellageProfile } from "./contracts.js";

const PROFILE_DIRECTIVE_OPEN = '<trellage_profile_directive version="1">';
const PROFILE_DIRECTIVE_CLOSE = "</trellage_profile_directive>";
const DELEGATED_TASK_OPEN = '<trellage_delegated_task version="1">';
const DELEGATED_TASK_CLOSE = "</trellage_delegated_task>";
const RESERVED_ENVELOPE_TAG_PATTERN = /<\/?trellage_(?:profile_directive|delegated_task)\b/iu;

export type TrellageProfileDirectiveIdentity = `${TrellageMode}/${string}/${string}`;

export const TrellageDirectiveTransport = {
  PromptEnvelope: "prompt-envelope",
  AppendSystemPrompt: "append-system-prompt",
} as const;
export type TrellageDirectiveTransport =
  (typeof TrellageDirectiveTransport)[keyof typeof TrellageDirectiveTransport];

export type TrellageProfileDirective = {
  transport: TrellageDirectiveTransport;
  rootRoutingDescription: string;
  invocationDirective: string;
};

export type TrellageProfileDirectiveRegistry = Readonly<
  Partial<Record<TrellageProfileDirectiveIdentity, TrellageProfileDirective>>
>;

function directiveIdentity(profile: Pick<TrellageProfile, "mode" | "launcher" | "name">) {
  return `${profile.mode}/${profile.launcher}/${profile.name}` as TrellageProfileDirectiveIdentity;
}

const CLAUDE_COUNCIL_DIRECTIVE: TrellageProfileDirective = {
  transport: TrellageDirectiveTransport.PromptEnvelope,
  rootRoutingDescription:
    "Decision-routing council for materially consequential choices, pressure tests, and " +
    "consensus-building under uncertainty. Prefer it when one-lens reasoning is likely unsafe.",
  invocationDirective: `Use the loaded \`/council\` skill for decision work. Available domains for \`--triad\`: architecture, strategy, ethics, debugging, risk, shipping, product, founder, ai, ai-product, ai-safety, decision, systems, uncertainty, design, economics, bias.

Council modes and exact selectors:
- Full:
  - Shape: independent analysis, cross-examination, final stance, synthesis.
  - Use when stakes are high and competing frames need contact.
  - \`/council <prompt>\` and \`/council --full <prompt>\`.
- Quick:
  - Shape: restate, rapid analysis, final positions.
  - Use when breadth is useful but a full adversarial round is not.
  - \`/council --quick <prompt>\`.
- Duo:
  - Shape: opening positions, direct response, final statements.
  - Use when one polarity defines the decision.
  - \`/council --duo <prompt>\`.

Named selection:
- Before using \`--members\`, read the loaded council skill's current member/routing table and
  choose names from that table. Do not invent member names.
- Named members use \`--members torvalds,ada\`.
- Named triads use \`--triad <domain>\`.
- Examples:
  - \`/council --duo --members torvalds,ada Is this abstraction worth it?\`
  - \`/council --quick --triad shipping Should we release today?\`
  - \`/council --triad strategy Where is our defensible advantage?\`
  - \`/council --triad risk What could make this launch irreversible?\`
  - \`/council --triad ai-product Which capability belongs in the product?\`

Selection guidance:
1. Choose the smallest sufficient council.
2. Use no council for factual lookups or cheap reversible checks.
3. Use quick for breadth without adversarial depth.
4. Use duo when one polarity defines the choice.
5. Use full or a named triad when stakes, uncertainty, competing values, or irreversibility
   require contact between lenses.
6. State the decision, constraints, evidence gaps, reversibility, and deadline before selecting
   members.`,
};

export const TRELLAGE_PROFILE_DIRECTIVES: TrellageProfileDirectiveRegistry = {
  [`${TrellageMode.Container}/trellage/claude-council`]: CLAUDE_COUNCIL_DIRECTIVE,
};

export function resolveTrellageProfileDirective(
  profile: Pick<TrellageProfile, "mode" | "launcher" | "name">,
  registry: TrellageProfileDirectiveRegistry = TRELLAGE_PROFILE_DIRECTIVES,
): TrellageProfileDirective | undefined {
  return registry[directiveIdentity(profile)];
}

export function describeTrellageProfileForInventory(
  profile: TrellageProfile,
  registry: TrellageProfileDirectiveRegistry = TRELLAGE_PROFILE_DIRECTIVES,
): string {
  // Mapped generic routing text intentionally replaces live profile descriptions so root routing
  // context cannot absorb profile command syntax.
  return (
    resolveTrellageProfileDirective(profile, registry)?.rootRoutingDescription ??
    profile.description
  );
}

export function composeTrellageDelegatedPrompt(
  profile: TrellageProfile,
  prompt: string,
  directive: TrellageProfileDirective | undefined = resolveTrellageProfileDirective(profile),
): string {
  if (!directive || directive.transport !== TrellageDirectiveTransport.PromptEnvelope)
    return prompt;
  assertNoReservedEnvelopeTags(prompt);

  return [
    PROFILE_DIRECTIVE_OPEN,
    `identity: ${directiveIdentity(profile)}`,
    directive.invocationDirective,
    PROFILE_DIRECTIVE_CLOSE,
    "",
    DELEGATED_TASK_OPEN,
    prompt,
    DELEGATED_TASK_CLOSE,
  ].join("\n");
}

function assertNoReservedEnvelopeTags(prompt: string): void {
  const match = RESERVED_ENVELOPE_TAG_PATTERN.exec(prompt);
  if (match) {
    throw new Error(`Delegated prompt contains reserved trellage envelope tag "${match[0]}".`);
  }
}
