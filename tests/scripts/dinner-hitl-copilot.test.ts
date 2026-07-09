import { describe, expect, it } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import {
  buildTelegramQuestion,
  createUserInputResponse,
  parseOwnerChatId,
} from "../../scripts/dinner-hitl-copilot.js";

describe("dinner-hitl-copilot helpers", () => {
  it("formats ask_user questions and choices for Telegram", () => {
    const text = buildTelegramQuestion({
      question: "What would you like as a main course?",
      choices: ["salmon", "ribeye"],
      allowFreeform: true,
    });

    expect(text).toBe(
      "What would you like as a main course?\n\nChoices:\n1. salmon\n2. ribeye\n\nReply with a choice or your own answer.",
    );
  });

  it("marks exact choice replies as non-freeform", () => {
    expect(createUserInputResponse("ribeye", ["salmon", "ribeye"])).toEqual({
      answer: "ribeye",
      wasFreeform: false,
    });
  });

  it("marks non-choice replies as freeform", () => {
    expect(createUserInputResponse("chicken parmesan", ["salmon", "ribeye"])).toEqual({
      answer: "chicken parmesan",
      wasFreeform: true,
    });
  });

  it("parses the owner chat id as a number", () => {
    expect(parseOwnerChatId("12345")).toBe(12345);
  });

  it("rejects missing or non-numeric owner chat ids", () => {
    expect(() => parseOwnerChatId(undefined)).toThrow("Need TELEGRAM_OWNER_CHAT_ID in .env.");
    expect(() => parseOwnerChatId("not-a-number")).toThrow(
      "TELEGRAM_OWNER_CHAT_ID must be a number.",
    );
  });

  it("can import the Copilot SDK with the documented package entrypoint", () => {
    expect(typeof CopilotClient).toBe("function");
  });
});
