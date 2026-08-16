import { describe, expect, it } from "vitest";
import {
  buildTrellageHeadlessPrompt,
  formatTrellageAnswers,
  parseTrellageQuestions,
} from "../../../src/rlm-poc/trellage/questionProtocol.js";

const envelope = (json: string) =>
  `<trellage_questions version="1">\n${json}\n</trellage_questions>`;

describe("Trellage question protocol", () => {
  it("parses versioned, typed multiple questions", () => {
    expect(
      parseTrellageQuestions(
        envelope(
          '{"questions":[{"id":"database","text":"Which database?","choices":["Postgres","SQLite"],"reason":"Storage is unspecified"},{"id":"region","text":"Which region?"}]}',
        ),
      ),
    ).toEqual({
      kind: "questions",
      source: "envelope",
      questions: [
        {
          id: "database",
          text: "Which database?",
          choices: ["Postgres", "SQLite"],
          reason: "Storage is unspecified",
        },
        { id: "region", text: "Which region?" },
      ],
    });
  });

  it("rejects duplicate IDs and unsupported versions", () => {
    expect(
      parseTrellageQuestions(
        envelope('{"questions":[{"id":"q1","text":"A?"},{"id":"q1","text":"B?"}]}'),
      ),
    ).toMatchObject({ kind: "malformed", error: expect.stringContaining("Duplicate") });
    expect(
      parseTrellageQuestions(
        '<trellage_questions version="2">{"questions":[{"id":"q1","text":"A?"}]}</trellage_questions>',
      ),
    ).toMatchObject({ kind: "malformed", error: expect.stringContaining("Unsupported") });
  });

  it("gives one valid question envelope priority over surrounding harness prose", () => {
    expect(
      parseTrellageQuestions(
        `I cannot continue without this value.\n${envelope('{"questions":[{"id":"q1","text":"A?"}]}')}\nNo answer has been received.`,
      ),
    ).toEqual({
      kind: "questions",
      source: "envelope",
      questions: [{ id: "q1", text: "A?" }],
    });
  });

  it("retains the legacy NEEDS fallback but emits only the versioned protocol", () => {
    expect(parseTrellageQuestions("NEEDS: Which database?")).toEqual({
      kind: "questions",
      source: "legacy",
      questions: [{ id: "legacy-1", text: "Which database?" }],
    });
    expect(formatTrellageAnswers([{ id: "q1", answer: "Postgres" }])).toContain(
      '<trellage_answers version="1">',
    );
    expect(buildTrellageHeadlessPrompt("Implement it.")).toContain(
      '<trellage_questions version="1">',
    );
  });
});
