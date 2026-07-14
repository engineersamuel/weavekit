import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const WeavekitOpportunityDiagnosticsSchema = z.object({
  discoveredOpportunityCount: z.number().int().nonnegative(),
  acceptedOpportunityCount: z.number().int().nonnegative(),
  rejectedOpportunityCount: z.number().int().nonnegative(),
  bundleCount: z.number().int().nonnegative(),
  bundles: z.array(z.object({ id: z.string(), opportunityIds: z.array(z.string()) })),
  plannedOpportunityIds: z.array(z.string()),
  expectedPracticeRecallBeforePlanning: z.number().min(0).max(1).nullable(),
  acceptedOpportunityRetention: z.number().min(0).max(1).nullable(),
  acceptedPracticeRetention: z.number().min(0).max(1).nullable(),
  rejectedOpportunityIdsRestored: z.array(z.string()),
  rejectedGroundedPracticesRestored: z.array(z.string()).nullable(),
  overlapOrContradictionFindings: z.array(z.string()),
  unavailableMetrics: z.array(z.string()),
});

export type WeavekitOpportunityDiagnostics = z.infer<typeof WeavekitOpportunityDiagnosticsSchema>;

export async function loadWeavekitOpportunityDiagnostics(
  runDir: string,
): Promise<WeavekitOpportunityDiagnostics> {
  const [mapping, review, portfolio] = await Promise.all([
    readPayload(join(runDir, "opportunity-mapping.payload.json")),
    readPayload(join(runDir, "council-review.payload.json")),
    readPayload(join(runDir, "plan-portfolio.payload.json")),
  ]);
  const councilInput = recordValue(mapping, "councilInputReview");
  const discoveredOpportunityIds = objectIds(arrayValue(councilInput, "opportunities"));
  const bundles = arrayValue(councilInput, "bundles")
    .map((value) => ({
      id: stringValue(value, "id"),
      opportunityIds: stringArray(value, "opportunityIds"),
    }))
    .filter((bundle) => bundle.id.length > 0);
  const acceptances = arrayValue(review, "opportunityAcceptances");
  const acceptedOpportunityIds = acceptances
    .filter((value) => booleanValue(value, "accepted") === true)
    .map((value) => stringValue(value, "id"))
    .filter(Boolean);
  const rejectedOpportunityIds = acceptances
    .filter((value) => booleanValue(value, "accepted") === false)
    .map((value) => stringValue(value, "id"))
    .filter(Boolean);
  const plannedOpportunityIds = unique([
    ...stringArray(recordValue(portfolio, "plan"), "opportunityIds"),
    ...arrayValue(portfolio, "plans").flatMap((value) => stringArray(value, "opportunityIds")),
  ]);
  const restored = plannedOpportunityIds.filter((id) => rejectedOpportunityIds.includes(id));
  const overlapOrContradictionFindings = [
    ...duplicateMembershipFindings(
      "bundle",
      bundles.map((bundle) => bundle.opportunityIds),
    ),
    ...duplicateMembershipFindings(
      "source plan",
      arrayValue(portfolio, "sourcePlans").map((value) => stringArray(value, "opportunityIds")),
    ),
    ...restored.map((id) => `Portfolio restored rejected opportunity ${id}.`),
  ];
  const unavailableMetrics = [
    "Expected-practice recall, accepted-practice retention, and restored grounded practices are unavailable because workflow payloads do not carry benchmark requirement ids.",
  ];
  for (const [name, value] of [
    ["opportunity mapping", mapping],
    ["council review", review],
    ["portfolio plan", portfolio],
  ] as const) {
    if (value === undefined) unavailableMetrics.push(`Missing ${name} payload.`);
  }
  return {
    discoveredOpportunityCount: discoveredOpportunityIds.length,
    acceptedOpportunityCount: acceptedOpportunityIds.length,
    rejectedOpportunityCount: rejectedOpportunityIds.length,
    bundleCount: bundles.length,
    bundles,
    plannedOpportunityIds,
    expectedPracticeRecallBeforePlanning: null,
    acceptedOpportunityRetention:
      acceptedOpportunityIds.length === 0
        ? null
        : fraction(
            acceptedOpportunityIds.filter((id) => plannedOpportunityIds.includes(id)).length,
            acceptedOpportunityIds.length,
          ),
    acceptedPracticeRetention: null,
    rejectedOpportunityIdsRestored: restored,
    rejectedGroundedPracticesRestored: null,
    overlapOrContradictionFindings,
    unavailableMetrics,
  };
}

async function readPayload(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordValue(value: unknown, key: string): Record<string, unknown> | undefined {
  return record(record(value)?.[key]);
}

function arrayValue(value: unknown, key: string): unknown[] {
  const candidate = record(value)?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function stringValue(value: unknown, key: string): string {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : "";
}

function booleanValue(value: unknown, key: string): boolean | undefined {
  const candidate = record(value)?.[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function stringArray(value: unknown, key: string): string[] {
  return arrayValue(value, key).filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
}

function objectIds(values: unknown[]): string[] {
  return unique(values.map((value) => stringValue(value, "id")).filter(Boolean));
}

function duplicateMembershipFindings(label: string, groups: string[][]): string[] {
  const counts = new Map<string, number>();
  for (const id of groups.flat()) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => `Opportunity ${id} appears in multiple ${label} groups.`);
}

function fraction(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(6));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
