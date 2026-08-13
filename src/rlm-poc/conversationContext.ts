import type { SessionEvent } from "@github/copilot-sdk";
import type { RlmSessionReference } from "./session.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown | undefined>;
};

function renderEvent(event: SessionEvent, toolCalls: Map<string, ToolCall>): string | undefined {
  const agent = event.agentId ? ` agent=${event.agentId}` : "";
  switch (event.type) {
    case "user.message":
      return `[user${agent}] ${event.data.content}`;
    case "assistant.message":
      return `[assistant${agent}] ${event.data.content}`;
    case "tool.execution_start": {
      toolCalls.set(event.data.toolCallId, {
        name: event.data.toolName,
        ...(event.data.arguments ? { arguments: event.data.arguments } : {}),
      });
      const args = event.data.arguments ? ` ${JSON.stringify(event.data.arguments)}` : "";
      return `[assistant tool call${agent}] ${event.data.toolName}${args}`;
    }
    case "tool.execution_complete": {
      const call = toolCalls.get(event.data.toolCallId);
      toolCalls.delete(event.data.toolCallId);
      const name = call?.name ?? event.data.toolDescription?.name ?? "unknown";
      const result = event.data.result?.content ?? event.data.error?.message ?? "";
      const status = event.data.success ? "success" : "failure";
      return `[tool result: ${name}; ${status}${agent}] ${result}`;
    }
    default:
      return undefined;
  }
}

/**
 * Reads the root Submind's persisted event history at the moment an `ask_user` request arrives.
 * This keeps the isolated answerer grounded in the complete parent conversation without re-entering
 * the root's active turn.
 */
export async function snapshotConversation(sessionReference: RlmSessionReference): Promise<string> {
  const session = sessionReference.current;
  if (!session?.getEvents) {
    throw new Error("Cannot answer ask_user: the root Submind conversation is unavailable.");
  }

  const events = await session.getEvents();
  const toolCalls = new Map<string, ToolCall>();
  const transcript = events
    .map((event) => renderEvent(event, toolCalls))
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
  const instructions = sessionReference.instructions?.trim();
  return instructions ? `[parent instructions]\n${instructions}\n\n${transcript}` : transcript;
}
