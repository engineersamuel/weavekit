# Design question

Compare and contrast if WeaveKit should use Flue or Mastra or LangGraph for v0 workflow and agent harness orchestration layer for a Design Council that orchestrates GitHub Copilot SDK persona sessions and uses BAML for typed fan-in contracts?

Constraints:

- Keep the public interface small.
- Produce Markdown and JSON artifacts.
- Stop in no more than three rounds.
- Have strongly typed outputs and intermediate layer with BAML.
- Observability
- Extensibility
- Ability to receive and process external connections and notifications.
- Easy ability to create multiple workflows and manage them.

References:

- https://flueframework.com/
- https://mastra.ai/
- https://github.com/langchain-ai/langgraph
