import type { WorkQueueBackend } from "./backend.js";
import type { WorkItem } from "./schema.js";

export type DecisionCouncilBeadsWorkflow = {
  rootItem: WorkItem;
  runItem: WorkItem;
  reviewItem: WorkItem;
  followUpItem: WorkItem;
  items: WorkItem[];
};

export async function createDecisionCouncilBeadsWorkflow(args: {
  backend: WorkQueueBackend;
  title: string;
  inputPath?: string;
  outputDir?: string;
}): Promise<DecisionCouncilBeadsWorkflow> {
  const { backend, title, inputPath, outputDir } = args;
  const labels = ["weavekit", "decision-council"];
  const contextLines = [
    inputPath ? `Input: ${inputPath}` : undefined,
    outputDir ? `Output: ${outputDir}` : undefined,
  ].filter((line): line is string => line !== undefined);

  const rootItem = await backend.create({
    title: `Frame decision question: ${title}`,
    description: ["Frame the question and constraints for this Decision Council run.", ...contextLines].join("\n"),
    type: "decision",
    priority: 2,
    labels,
    dependencies: [],
  });

  const runItem = await backend.create({
    title: `Run Decision Council: ${title}`,
    description: ["Run Weavekit Decision Council for the framed question.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: rootItem.id }],
  });

  const reviewItem = await backend.create({
    title: `Review Decision Council report: ${title}`,
    description: ["Review the generated Decision Council report before follow-up work begins.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: runItem.id }],
  });

  const followUpItem = await backend.create({
    title: `Implement next experiment: ${title}`,
    description: ["Implement or refine the next experiment after reviewing the Decision Council report.", ...contextLines].join("\n"),
    type: "task",
    priority: 2,
    labels,
    dependencies: [{ type: "waits-for", id: reviewItem.id }],
  });

  return {
    rootItem,
    runItem,
    reviewItem,
    followUpItem,
    items: [rootItem, runItem, reviewItem, followUpItem],
  };
}
