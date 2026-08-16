import type { LinearTicketSnapshot } from "../store/store.js";
import {
  setMastermindSpanInput,
  setMastermindSpanOutput,
  setMastermindTicketAttributes,
  withMastermindSpan,
} from "../telemetry.js";

export type LinearIssueComment = {
  id: string;
  body: string;
  createdAt: string;
};

export type LinearGateway = {
  fetchIssue(issueId: string): Promise<LinearTicketSnapshot>;
  updateIssueContent(issueId: string, input: { title: string; description: string }): Promise<void>;
  replaceIssueLabels(issueId: string, input: { remove: string[]; add: string[] }): Promise<void>;
  setIssueState?(issueId: string, stateName: string): Promise<void>;
  findIssueCommentByMarker?(issueId: string, marker: string): Promise<string | undefined>;
  createIssueComment?(issueId: string, body: string): Promise<string>;
  updateIssueComment?(commentId: string, body: string): Promise<void>;
  listIssueComments?(issueId: string): Promise<LinearIssueComment[]>;
  createIssue?(input: {
    teamId: string;
    title: string;
    description: string;
    labelIds?: string[];
    projectId?: string;
  }): Promise<{ id: string; identifier: string; url: string }>;
};

type GraphQlEnvelope = {
  data?: Record<string, unknown>;
  errors?: Array<{ message?: string }>;
};

export class LinearGraphQlGateway implements LinearGateway {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.linear.app/graphql",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async fetchIssue(issueId: string): Promise<LinearTicketSnapshot> {
    return withMastermindSpan(
      "mastermind.linear.fetch_issue",
      {
        "langfuse.observation.type": "tool",
        "weavekit.mastermind.linear.operation": "fetch_issue",
        "weavekit.mastermind.issue_id": issueId,
      },
      async (span) => {
        setMastermindSpanInput(span, { issueId });
        const data = await this.query(
          `query MastermindIssue($id: String!) {
        issue(id: $id) {
          id
          identifier
          url
          title
          description
          updatedAt
          team { id }
          project { id }
          state { name }
          labels { nodes { id name } }
        }
      }`,
          { id: issueId },
        );
        const issue = asRecord(data.issue);
        const team = asRecord(issue.team);
        const project = asRecord(issue.project);
        const state = asRecord(issue.state);
        const labels = asRecord(issue.labels);
        if (!issue.id || !issue.url || !team.id) {
          throw new Error(`Linear issue ${issueId} returned an incomplete response.`);
        }
        const ticket = {
          id: String(issue.id),
          identifier: String(issue.identifier ?? issue.id),
          url: String(issue.url),
          title: String(issue.title ?? ""),
          description: String(issue.description ?? ""),
          updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : undefined,
          teamId: String(team.id),
          projectId: typeof project.id === "string" ? project.id : undefined,
          status: String(state.name ?? ""),
          labels: Array.isArray(labels.nodes)
            ? labels.nodes.flatMap((label) => {
                const record = asRecord(label);
                return typeof record.id === "string" && typeof record.name === "string"
                  ? [{ id: record.id, name: record.name }]
                  : [];
              })
            : [],
        };
        setMastermindTicketAttributes(span, ticket);
        setMastermindSpanOutput(span, {
          id: ticket.id,
          identifier: ticket.identifier,
          url: ticket.url,
          status: ticket.status,
          labels: ticket.labels,
        });
        return ticket;
      },
    );
  }

  async updateIssueContent(
    issueId: string,
    input: { title: string; description: string },
  ): Promise<void> {
    await withMastermindSpan(
      "mastermind.linear.update_issue_content",
      {
        "langfuse.observation.type": "tool",
        "weavekit.mastermind.linear.operation": "update_issue_content",
        "weavekit.mastermind.issue_id": issueId,
      },
      async (span) => {
        setMastermindSpanInput(span, { issueId, title: input.title });
        const data = await this.query(
          `mutation MastermindUpdateIssue(
        $id: String!
        $title: String!
        $description: String!
      ) {
        issueUpdate(id: $id, input: { title: $title, description: $description }) {
          success
        }
      }`,
          { id: issueId, title: input.title, description: input.description },
        );
        const result = asRecord(data.issueUpdate);
        if (result.success !== true) {
          throw new Error(`Linear rejected the content update for issue ${issueId}.`);
        }
        setMastermindSpanOutput(span, { success: true });
      },
    );
  }

  async replaceIssueLabels(
    issueId: string,
    input: { remove: string[]; add: string[] },
  ): Promise<void> {
    await withMastermindSpan(
      "mastermind.linear.replace_issue_labels",
      {
        "langfuse.observation.type": "tool",
        "weavekit.mastermind.linear.operation": "replace_issue_labels",
        "weavekit.mastermind.issue_id": issueId,
      },
      async (span) => {
        setMastermindSpanInput(span, { issueId, ...input });
        const issue = await this.fetchIssue(issueId);
        const remove = new Set(input.remove);
        const labelIds = [
          ...issue.labels.filter((label) => !remove.has(label.id)).map((label) => label.id),
          ...input.add,
        ];
        const uniqueLabelIds = [...new Set(labelIds)];
        if (
          uniqueLabelIds.length === issue.labels.length &&
          uniqueLabelIds.every((labelId) => issue.labels.some((label) => label.id === labelId))
        ) {
          setMastermindSpanOutput(span, { changed: false, labelIds: uniqueLabelIds });
          return;
        }

        const data = await this.query(
          `mutation MastermindAddIssueLabel($id: String!, $labelIds: [String!]!) {
        issueUpdate(id: $id, input: { labelIds: $labelIds }) {
          success
        }
      }`,
          { id: issueId, labelIds: uniqueLabelIds },
        );
        const result = asRecord(data.issueUpdate);
        if (result.success !== true) {
          throw new Error(`Linear rejected the label update for issue ${issueId}.`);
        }
        setMastermindSpanOutput(span, { changed: true, labelIds: uniqueLabelIds });
      },
    );
  }

  async setIssueState(issueId: string, stateName: string): Promise<void> {
    const issue = await this.fetchIssue(issueId);
    if (issue.status.toLocaleLowerCase() === stateName.toLocaleLowerCase()) return;
    const data = await this.query(
      `query MastermindWorkflowStates($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name }
        }
      }`,
      { teamId: issue.teamId },
    );
    const states = asRecord(data.workflowStates);
    const state = Array.isArray(states.nodes)
      ? states.nodes
          .map(asRecord)
          .find(
            (candidate) =>
              typeof candidate.name === "string" &&
              candidate.name.toLocaleLowerCase() === stateName.toLocaleLowerCase(),
          )
      : undefined;
    if (!state || typeof state.id !== "string") {
      throw new Error(`Linear workflow state does not exist for this team: ${stateName}`);
    }
    const updated = await this.query(
      `mutation MastermindUpdateIssueState($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: state.id },
    );
    if (asRecord(updated.issueUpdate).success !== true) {
      throw new Error(`Linear rejected workflow-state update for issue ${issueId}.`);
    }
  }

  async listIssueComments(issueId: string): Promise<LinearIssueComment[]> {
    const data = await this.query(
      `query MastermindIssueCommentsList($id: String!) {
        issue(id: $id) {
          comments {
            nodes { id body createdAt }
          }
        }
      }`,
      { id: issueId },
    );
    const issue = asRecord(data.issue);
    const comments = asRecord(issue.comments);
    if (!Array.isArray(comments.nodes)) {
      return [];
    }
    return comments.nodes.flatMap((comment) => {
      const record = asRecord(comment);
      return typeof record.id === "string" &&
        typeof record.body === "string" &&
        typeof record.createdAt === "string"
        ? [{ id: record.id, body: record.body, createdAt: record.createdAt }]
        : [];
    });
  }

  async findIssueCommentByMarker(issueId: string, marker: string): Promise<string | undefined> {
    const comments = await this.listIssueComments(issueId);
    return comments.find((comment) => comment.body.includes(marker))?.id;
  }

  async createIssueComment(issueId: string, body: string): Promise<string> {
    const data = await this.query(
      `mutation MastermindCreateIssueComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }`,
      { issueId, body },
    );
    const result = asRecord(data.commentCreate);
    const comment = asRecord(result.comment);
    if (result.success !== true || typeof comment.id !== "string") {
      throw new Error(`Linear rejected the comment for issue ${issueId}.`);
    }
    return comment.id;
  }

  async updateIssueComment(commentId: string, body: string): Promise<void> {
    const data = await this.query(
      `mutation MastermindUpdateIssueComment($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) {
          success
        }
      }`,
      { id: commentId, body },
    );
    const result = asRecord(data.commentUpdate);
    if (result.success !== true) {
      throw new Error(`Linear rejected the comment update ${commentId}.`);
    }
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    labelIds?: string[];
    projectId?: string;
  }): Promise<{ id: string; identifier: string; url: string }> {
    return withMastermindSpan(
      "mastermind.linear.create_issue",
      {
        "langfuse.observation.type": "tool",
        "weavekit.mastermind.linear.operation": "create_issue",
        "weavekit.mastermind.linear.team_id": input.teamId,
      },
      async (span) => {
        setMastermindSpanInput(span, {
          teamId: input.teamId,
          title: input.title,
          labelIds: input.labelIds,
          projectId: input.projectId,
        });
        const data = await this.query(
          `mutation MastermindCreateIssue(
        $teamId: String!
        $title: String!
        $description: String!
        $labelIds: [String!]
        $projectId: String
      ) {
        issueCreate(
          input: {
            teamId: $teamId
            title: $title
            description: $description
            labelIds: $labelIds
            projectId: $projectId
          }
        ) {
          success
          issue { id identifier url }
        }
      }`,
          {
            teamId: input.teamId,
            title: input.title,
            description: input.description,
            labelIds: input.labelIds ?? [],
            projectId: input.projectId ?? null,
          },
        );
        const result = asRecord(data.issueCreate);
        const issue = asRecord(result.issue);
        if (
          result.success !== true ||
          typeof issue.id !== "string" ||
          typeof issue.identifier !== "string" ||
          typeof issue.url !== "string"
        ) {
          throw new Error(`Linear rejected issue creation for team ${input.teamId}.`);
        }
        const created = { id: issue.id, identifier: issue.identifier, url: issue.url };
        setMastermindSpanOutput(span, created);
        return created;
      },
    );
  }

  private async query(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`Linear GraphQL request failed with HTTP ${response.status}.`);
    }
    const envelope = (await response.json()) as GraphQlEnvelope;
    if (envelope.errors && envelope.errors.length > 0) {
      throw new Error(
        `Linear GraphQL error: ${envelope.errors.map((error) => error.message ?? "unknown").join("; ")}`,
      );
    }
    if (!envelope.data) {
      throw new Error("Linear GraphQL response did not include data.");
    }
    return envelope.data;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
