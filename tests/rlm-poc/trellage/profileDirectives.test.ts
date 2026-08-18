import { describe, expect, it } from "vitest";
import {
  TrellageHarness,
  TrellageMode,
  type TrellageProfile,
} from "../../../src/rlm-poc/trellage/contracts.js";
import {
  composeTrellageDelegatedPrompt,
  describeTrellageProfileForInventory,
  resolveTrellageProfileDirective,
  TrellageDirectiveTransport,
} from "../../../src/rlm-poc/trellage/profileDirectives.js";

const CLAUDE_COUNCIL_PROFILE: TrellageProfile = {
  harness: TrellageHarness.Container,
  mode: TrellageMode.Container,
  launcher: "trellage",
  name: "claude-council",
  description: "Live profile text with /council syntax.",
  sandbox: true,
};

describe("trellage profile directives", () => {
  it("resolves only an exact mode/launcher/profile identity", () => {
    const directive = resolveTrellageProfileDirective(CLAUDE_COUNCIL_PROFILE);
    expect(directive).toBeDefined();
    expect(directive?.transport).toBe(TrellageDirectiveTransport.PromptEnvelope);
    expect(directive?.invocationDirective).toContain("/council <prompt>");
    expect(directive?.invocationDirective).toContain("/council --full <prompt>");
    expect(directive?.invocationDirective).toContain("/council --quick <prompt>");
    expect(directive?.invocationDirective).toContain("/council --duo <prompt>");
    expect(directive?.invocationDirective).toContain("--members torvalds,ada");
    expect(directive?.invocationDirective).toContain("--triad <domain>");
    expect(directive?.invocationDirective).toContain(
      "/council --duo --members torvalds,ada Is this abstraction worth it?",
    );
    expect(directive?.invocationDirective).toContain(
      "/council --quick --triad shipping Should we release today?",
    );
    expect(directive?.invocationDirective).toContain(
      "/council --triad strategy Where is our defensible advantage?",
    );
    expect(directive?.invocationDirective).toContain(
      "/council --triad risk What could make this launch irreversible?",
    );
    expect(directive?.invocationDirective).toContain(
      "/council --triad ai-product Which capability belongs in the product?",
    );
    const domainLine = directive?.invocationDirective.match(
      /Available domains for `--triad`: ([^.]+)\./u,
    )?.[1];
    expect(domainLine).toBeDefined();
    expect(domainLine?.split(", ").map((domain) => domain.trim())).toEqual([
      "architecture",
      "strategy",
      "ethics",
      "debugging",
      "risk",
      "shipping",
      "product",
      "founder",
      "ai",
      "ai-product",
      "ai-safety",
      "decision",
      "systems",
      "uncertainty",
      "design",
      "economics",
      "bias",
    ]);
    expect(directive?.invocationDirective).toContain("Choose the smallest sufficient council.");
    expect(directive?.invocationDirective).toContain(
      "Use no council for factual lookups or cheap reversible checks.",
    );
    expect(directive?.invocationDirective).toContain(
      "Use quick for breadth without adversarial depth.",
    );
    expect(directive?.invocationDirective).toContain(
      "Use duo when one polarity defines the choice.",
    );
    expect(directive?.invocationDirective).toContain(
      "Use full or a named triad when stakes, uncertainty, competing values, or irreversibility",
    );
    expect(directive?.invocationDirective).toContain(
      "State the decision, constraints, evidence gaps, reversibility, and deadline before selecting",
    );
    expect(directive?.invocationDirective).toContain(
      "read the loaded council skill's current member/routing table",
    );
    expect(directive?.invocationDirective).toContain("Do not invent member names.");
    expect(directive?.invocationDirective).not.toContain("member:<name>");
    expect(directive?.invocationDirective).not.toContain("triad:<name>");
    expect(directive?.invocationDirective).not.toContain("different selector tokens");

    expect(
      resolveTrellageProfileDirective({
        ...CLAUDE_COUNCIL_PROFILE,
        mode: TrellageMode.Native,
      }),
    ).toBeUndefined();
    expect(
      resolveTrellageProfileDirective({
        ...CLAUDE_COUNCIL_PROFILE,
        launcher: "cldx",
      }),
    ).toBeUndefined();
    expect(
      resolveTrellageProfileDirective({
        ...CLAUDE_COUNCIL_PROFILE,
        name: "claude-research",
      }),
    ).toBeUndefined();
  });

  it("wraps configured prompts in directive and delegated-task envelopes", () => {
    const composed = composeTrellageDelegatedPrompt(CLAUDE_COUNCIL_PROFILE, "Do the task.");
    expect(composed).toContain('<trellage_profile_directive version="1">');
    expect(composed).toContain("identity: container/trellage/claude-council");
    expect(composed).toContain("</trellage_profile_directive>");
    expect(composed).toContain('<trellage_delegated_task version="1">');
    expect(composed).toContain("Do the task.");
    expect(composed).toContain("</trellage_delegated_task>");
  });

  it("keeps unconfigured profiles unchanged", () => {
    const plain = composeTrellageDelegatedPrompt(
      {
        harness: TrellageHarness.Copilot,
        mode: TrellageMode.Native,
        launcher: "cpx",
        name: "hve",
        description: "Copilot profile.",
        sandbox: false,
      },
      "Do the task.",
    );
    expect(plain).toBe("Do the task.");
  });

  it("rejects reserved envelope tags in delegated prompts", () => {
    expect(() =>
      composeTrellageDelegatedPrompt(
        CLAUDE_COUNCIL_PROFILE,
        'bad <trellage_profile_directive version="2"> prompt',
      ),
    ).toThrow('reserved trellage envelope tag "<trellage_profile_directive"');
    expect(() =>
      composeTrellageDelegatedPrompt(
        CLAUDE_COUNCIL_PROFILE,
        'bad <TRELLAGE_DELEGATED_TASK custom="true"> prompt',
      ),
    ).toThrow('reserved trellage envelope tag "<TRELLAGE_DELEGATED_TASK"');
  });

  it("uses the mapped generic routing description in inventory text", () => {
    expect(describeTrellageProfileForInventory(CLAUDE_COUNCIL_PROFILE)).toContain(
      "Decision-routing council",
    );
    expect(describeTrellageProfileForInventory(CLAUDE_COUNCIL_PROFILE)).not.toContain("/council");
  });
});
