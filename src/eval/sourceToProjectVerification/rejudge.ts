import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseProjectVerificationManifest, type ProjectVerificationManifest } from "./manifest.js";

export async function loadProjectVerificationRejudgeSource(args: {
  sourceDir: string;
  expectedCaseId: string;
  expectedCaseSha256: string;
  timestamp: string;
}): Promise<{
  outputDir: string;
  artifactRootDir: string;
  sourceManifestPath: string;
  manifest: ProjectVerificationManifest;
  promptfooSummary: Record<string, unknown>;
}> {
  const sourceDir = resolve(args.sourceDir);
  const manifest = parseProjectVerificationManifest(
    JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8")),
    { sourceDir },
  );
  if (manifest.caseId !== args.expectedCaseId) {
    throw new Error(
      `Rejudge case ${manifest.caseId} does not match current case ${args.expectedCaseId}.`,
    );
  }
  if (manifest.caseSha256 !== args.expectedCaseSha256) {
    throw new Error(
      `Rejudge case fingerprint ${manifest.caseSha256} does not match current case fingerprint ${args.expectedCaseSha256}.`,
    );
  }
  const promptfooSummary = await readStoredProviderReport(sourceDir);
  return {
    outputDir: join(sourceDir, "judge-replays", args.timestamp),
    artifactRootDir: sourceDir,
    sourceManifestPath: join(sourceDir, "manifest.json"),
    manifest,
    promptfooSummary,
  };
}

async function readStoredProviderReport(sourceDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(sourceDir, "promptfoo-report.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return JSON.parse(await readFile(join(sourceDir, "report.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }
}
