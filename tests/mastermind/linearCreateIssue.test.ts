import { describe, expect, it } from "vitest";
import { LinearGraphQlGateway } from "../../src/mastermind/linear/client.js";

function fakeFetch(
  handler: (body: { query: string; variables: Record<string, unknown> }) => unknown,
): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    return {
      ok: true,
      json: async () => ({ data: handler(body) }),
    } as Response;
  }) as typeof fetch;
}

describe("LinearGraphQlGateway.createIssue", () => {
  it("sends an issueCreate mutation and returns the created issue", async () => {
    let capturedVariables: Record<string, unknown> | undefined;
    const gateway = new LinearGraphQlGateway(
      "test-api-key",
      "https://api.linear.app/graphql",
      fakeFetch((body) => {
        capturedVariables = body.variables;
        expect(body.query).toContain("issueCreate");
        return {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-1",
              identifier: "ENG-99",
              url: "https://linear.app/eng/issue/ENG-99",
            },
          },
        };
      }),
    );

    const created = await gateway.createIssue({
      teamId: "team-1",
      title: "Self-improvement finding",
      description: "Body text",
      labelIds: ["label-1"],
    });

    expect(created).toEqual({
      id: "issue-1",
      identifier: "ENG-99",
      url: "https://linear.app/eng/issue/ENG-99",
    });
    expect(capturedVariables).toMatchObject({
      teamId: "team-1",
      title: "Self-improvement finding",
      description: "Body text",
      labelIds: ["label-1"],
      projectId: null,
    });
  });

  describe("LinearGraphQlGateway.setIssueState", () => {
    it("declares the workflow-state team variable as a Linear ID", async () => {
      const queries: string[] = [];
      const gateway = new LinearGraphQlGateway(
        "test-api-key",
        "https://api.linear.app/graphql",
        fakeFetch((body) => {
          queries.push(body.query);
          if (body.query.includes("MastermindIssue(")) {
            return {
              issue: {
                id: "issue-1",
                identifier: "ENG-10",
                url: "https://linear.app/eng/issue/ENG-10",
                title: "Prototype",
                description: "",
                team: { id: "team-1" },
                project: { id: "project-1" },
                state: { name: "Todo" },
                labels: { nodes: [] },
              },
            };
          }
          if (body.query.includes("MastermindWorkflowStates")) {
            return {
              workflowStates: {
                nodes: [{ id: "state-1", name: "In Progress" }],
              },
            };
          }
          return { issueUpdate: { success: true } };
        }),
      );

      await gateway.setIssueState("issue-1", "In Progress");

      expect(queries.find((query) => query.includes("MastermindWorkflowStates"))).toContain(
        "$teamId: ID!",
      );
    });
  });

  it("throws when Linear rejects issue creation", async () => {
    const gateway = new LinearGraphQlGateway(
      "test-api-key",
      "https://api.linear.app/graphql",
      fakeFetch(() => ({ issueCreate: { success: false, issue: null } })),
    );

    await expect(
      gateway.createIssue({ teamId: "team-1", title: "x", description: "y" }),
    ).rejects.toThrow("Linear rejected issue creation");
  });
});
