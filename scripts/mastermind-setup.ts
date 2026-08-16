#!/usr/bin/env node
/**
 * Scaffolds the `~/.weavekit/config.toml` blocks Mastermind needs to run against a real Linear
 * workspace: `[[mastermind.project_mappings]]` (one per team) and a matching `[projects.<id>]`
 * stanza pointed at this repository checkout. It also ensures the mastermind-* workflow labels
 * exist on each team (the one-shot `mise run mastermind` script expects them to already exist and
 * refuses to create them itself - only `mastermind:live`'s interactive setup did that before).
 *
 * Usage:
 *   mise run mastermind:setup
 *
 * Requires LINEAR_API_KEY to already be set (via ~/.weavekit/config.toml or the environment).
 */
import { loadLocalEnvFiles, loadWeavekitConfig } from "../src/config.js";

loadWeavekitConfig();
loadLocalEnvFiles();

const LINEAR_API_URL = "https://api.linear.app/graphql";

type LinearTeam = { id: string; key: string; name: string };
type LinearLabel = { id: string; name: string; team?: { id: string } };

const REQUIRED_LABEL_NAMES = [
  "mastermind-reviewed",
  "mastermind-ready",
  "mastermind-needs-input",
  "mastermind-review-failed",
  "mastermind-code-review",
  "mastermind-code-review-passed",
  "mastermind-changes-requested",
];

async function linearQuery<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(
      `Linear request failed with HTTP ${response.status}${details ? `: ${details}` : "."}`,
    );
  }
  const envelope = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (envelope.errors?.length) {
    throw new Error(`Linear error: ${envelope.errors.map((error) => error.message).join(", ")}`);
  }
  if (!envelope.data) {
    throw new Error("Linear response did not include data.");
  }
  return envelope.data;
}

async function fetchTeamsAndLabels(
  apiKey: string,
): Promise<{ organizationName: string; teams: LinearTeam[]; labels: LinearLabel[] }> {
  const data = await linearQuery<{
    organization?: { name?: string };
    teams?: { nodes?: LinearTeam[] };
    issueLabels?: { nodes?: Array<{ id: string; name: string; team?: { id: string } }> };
  }>(
    apiKey,
    `
      query MastermindSetupTeams {
        organization { name }
        teams { nodes { id key name } }
        issueLabels { nodes { id name team { id } } }
      }
    `,
  );
  const teams = data.teams?.nodes ?? [];
  if (teams.length === 0) {
    throw new Error("Linear returned no teams for this API key.");
  }
  return {
    organizationName: data.organization?.name ?? "your workspace",
    teams,
    labels: data.issueLabels?.nodes ?? [],
  };
}

async function ensureLabel(
  apiKey: string,
  teamId: string,
  existingLabels: LinearLabel[],
  name: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const existing = existingLabels.find(
    (label) =>
      label.team?.id === teamId && label.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (existing) {
    return { id: existing.id, name: existing.name, created: false };
  }
  const data = await linearQuery<{
    issueLabelCreate?: { success?: boolean; issueLabel?: { id: string; name: string } };
  }>(
    apiKey,
    `
      mutation MastermindSetupCreateLabel($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name }
        }
      }
    `,
    {
      input: {
        teamId,
        name,
        description: "Managed by weavekit-mastermind ticket review.",
        color: "#5E6AD2",
      },
    },
  );
  const label = data.issueLabelCreate?.issueLabel;
  if (!data.issueLabelCreate?.success || !label) {
    throw new Error(`Failed to create Linear label "${name}" for team ${teamId}.`);
  }
  return { id: label.id, name: label.name, created: true };
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function printScaffold(repoRoot: string, teams: LinearTeam[]): void {
  process.stdout.write(
    "\nAdd the block(s) below to ~/.weavekit/config.toml, keeping only the team(s) you want\n" +
      "Mastermind to watch. Replace `project_id` / `working_tree` if this checkout isn't the one\n" +
      "you want Mastermind executing against.\n\n",
  );
  for (const team of teams) {
    const projectId = slugify(team.key || team.name);
    process.stdout.write(
      [
        `# ${team.name} (key: ${team.key})`,
        "[[mastermind.project_mappings]]",
        `team_id = "${team.id}"`,
        `project_id = "${projectId}"`,
        "",
        `[projects.${projectId}]`,
        `display_name = "${team.name}"`,
        `working_tree = "${repoRoot}"`,
        `repository_mode = "existing"`,
        `mainline = "origin main"`,
        `validation_commands = ["nub run typecheck", "nub run test"]`,
        "",
        `[projects.${projectId}.execution.direct]`,
        `enabled = false`,
        `allowed_executors = ["herdr-copilot"]`,
        `allowed_pr_hosts = ["github.com"]`,
        "",
        "",
      ].join("\n"),
    );
  }
}

try {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'LINEAR_API_KEY is required. Set it in ~/.weavekit/config.toml (root-level `LINEAR_API_KEY = "lin_api_..."`) first, then re-run this task.',
    );
  }
  const { organizationName, teams, labels } = await fetchTeamsAndLabels(apiKey);
  process.stdout.write(`Found ${teams.length} team(s) in ${organizationName}:\n`);
  for (const team of teams) {
    process.stdout.write(`  - ${team.name} (${team.key}) team_id=${team.id}\n`);
  }

  process.stdout.write(
    `\nEnsuring the ${REQUIRED_LABEL_NAMES.length} mastermind-* workflow labels exist on each team ` +
      "(the one-shot `mise run mastermind` command expects these to already exist)...\n",
  );
  for (const team of teams) {
    for (const name of REQUIRED_LABEL_NAMES) {
      const label = await ensureLabel(apiKey, team.id, labels, name);
      process.stdout.write(
        `  - ${team.name}: ${label.name} ${label.created ? "(created)" : "(already existed)"}\n`,
      );
    }
  }

  const repoRoot = process.env.PWD?.trim() || process.cwd();
  printScaffold(repoRoot, teams);
  process.stdout.write(
    "`project_mappings` entries default `execution.direct.enabled = false` (review-only). Flip it\n" +
      "to `true` only once you're comfortable with autopilot execution against this project.\n",
  );
} catch (error) {
  process.stderr.write(
    `mastermind:setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
