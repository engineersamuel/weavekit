#!/usr/bin/env node
// Remove the mastermind-review-failed label from a ticket so the failed work item
// reopens on the next mastermind run (the documented explicit retry condition).
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { LinearSetupClient } from "../src/mastermind/live.js";
import { LinearGraphQlGateway } from "../src/mastermind/index.js";

loadLocalEnvFiles();
const identifier = process.argv[2]?.trim();
if (!identifier) throw new Error("usage: clear-review-failed.ts <ENG-nn>");

const config = await loadMastermindRuntimeConfig();
const apiKey = process.env.LINEAR_API_KEY?.trim();
if (!apiKey) throw new Error("LINEAR_API_KEY is required.");

const setupClient = new LinearSetupClient(apiKey);
const setup = await setupClient.getSetup();
const labelId = (name: string) => {
  const found = setup.labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`label ${name} not found`);
  return found.id;
};

let issue;
for (const mapping of config.mastermind.projectMappings) {
  const issues = await setupClient.listIssues(mapping.teamId);
  issue = issues.find((i) => i.identifier.toLowerCase() === identifier.toLowerCase());
  if (issue) break;
}
if (!issue) throw new Error(`issue ${identifier} not found`);

const gateway = new LinearGraphQlGateway(apiKey);
const before = await gateway.fetchIssue(issue.id);
process.stdout.write(`before: ${before.labels.map((l) => l.name).join(", ") || "<none>"}\n`);

await gateway.replaceIssueLabels(issue.id, {
  remove: [
    labelId(config.mastermind.reviewFailedLabelName),
    labelId(config.mastermind.reviewedLabelName),
    labelId(config.mastermind.readyLabelName),
    labelId(config.mastermind.needsInputLabelName),
  ],
  add: [],
});

const after = await gateway.fetchIssue(issue.id);
process.stdout.write(`after:  ${after.labels.map((l) => l.name).join(", ") || "<none>"}\n`);
