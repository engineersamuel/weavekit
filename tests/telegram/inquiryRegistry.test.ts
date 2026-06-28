import { describe, expect, it } from "vitest";
import { InquiryRegistry } from "../../src/telegram/inquiryRegistry.js";

describe("InquiryRegistry", () => {
  it("routes a reply to the resolver registered for that question message id", () => {
    const registry = new InquiryRegistry();
    const answers: string[] = [];

    registry.register(100, (answer) => answers.push(answer));
    const matched = registry.resolveReply(100, "salmon");

    expect(matched).toBe(true);
    expect(answers).toEqual(["salmon"]);
  });

  it("routes two concurrent pending questions independently by message id", () => {
    const registry = new InquiryRegistry();
    let answerA: string | undefined;
    let answerB: string | undefined;

    registry.register(100, (a) => (answerA = a));
    registry.register(200, (b) => (answerB = b));

    // Reply to the second question first — correlation must not depend on order.
    registry.resolveReply(200, "ribeye");
    registry.resolveReply(100, "salmon");

    expect(answerA).toBe("salmon");
    expect(answerB).toBe("ribeye");
  });

  it("returns false and resolves nothing for an unknown reply target", () => {
    const registry = new InquiryRegistry();

    expect(registry.resolveReply(999, "tofu")).toBe(false);
  });

  it("resolves a question only once and forgets it afterward", () => {
    const registry = new InquiryRegistry();
    let count = 0;

    registry.register(100, () => (count += 1));
    expect(registry.resolveReply(100, "first")).toBe(true);
    expect(registry.resolveReply(100, "second")).toBe(false);
    expect(count).toBe(1);
    expect(registry.pendingCount).toBe(0);
  });

  it("forgets a pending question when it is unregistered", () => {
    const registry = new InquiryRegistry();
    registry.register(100, () => {});

    registry.unregister(100);

    expect(registry.resolveReply(100, "salmon")).toBe(false);
    expect(registry.pendingCount).toBe(0);
  });
});
