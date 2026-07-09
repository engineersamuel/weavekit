import type {
  MacroWorkflowRunStateLike,
  RuntimeWorkflowNode,
  WorkflowArtifactRef,
  WorkflowNodeExecutionResult,
} from "../types.js";

export type DashboardArtifactLink = {
  label: string;
  file: string;
  href: string;
};

export type DashboardArtifactSnapshot = {
  activeRunId?: string;
  run?: {
    runId?: string;
    status?: MacroWorkflowRunStateLike["status"];
  };
  state?: Pick<MacroWorkflowRunStateLike, "runId" | "status">;
};

export function buildNodeArtifactLinks(args: {
  node?: RuntimeWorkflowNode;
  result?: WorkflowNodeExecutionResult;
  snapshot?: DashboardArtifactSnapshot;
}): DashboardArtifactLink[] {
  const runId =
    args.snapshot?.activeRunId ?? args.snapshot?.run?.runId ?? args.snapshot?.state?.runId;
  if (!runId || !args.node) {
    return [];
  }

  const links = dedupeArtifactLinks([
    ...artifactRefLinks(runId, args.result?.artifacts),
    ...typedPayloadLinks(runId, args.result),
    ...topLevelWorkflowReportLinks(runId, args.node, args.snapshot),
  ]);
  return links;
}

export function artifactHref(runId: string, file: string): string {
  return `/api/artifact?runId=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}`;
}

function artifactRefLinks(
  runId: string,
  artifacts: WorkflowArtifactRef[] | undefined,
): DashboardArtifactLink[] {
  return (artifacts ?? []).flatMap((artifact) => {
    if (!artifact.path) {
      return [];
    }
    return [
      {
        label: artifactLabel(artifact),
        file: artifact.path,
        href: artifactHref(runId, artifact.path),
      },
    ];
  });
}

function typedPayloadLinks(
  runId: string,
  result: WorkflowNodeExecutionResult | undefined,
): DashboardArtifactLink[] {
  if (!result?.payload) {
    return [];
  }
  const file = `${result.nodeId}.payload.json`;
  return [
    {
      label: "Open typed payload JSON",
      file,
      href: artifactHref(runId, file),
    },
  ];
}

function topLevelWorkflowReportLinks(
  runId: string,
  node: RuntimeWorkflowNode,
  snapshot: DashboardArtifactSnapshot | undefined,
): DashboardArtifactLink[] {
  const isReportNode =
    node.id === "report" || node.harness === "reporter" || node.kind === "visualization";
  const runStatus = snapshot?.state?.status ?? snapshot?.run?.status;
  if (!isReportNode || runStatus === "running") {
    return [];
  }
  return [
    {
      label: "Open workflow report",
      file: "workflow-report.md",
      href: artifactHref(runId, "workflow-report.md"),
    },
  ];
}

function artifactLabel(artifact: WorkflowArtifactRef): string {
  const description = artifact.description?.trim().replace(/[.。]+$/u, "");
  if (description) {
    return `Open ${description}`;
  }
  if (artifact.kind) {
    return `Open ${artifact.kind} artifact`;
  }
  return "Open artifact";
}

function dedupeArtifactLinks(links: DashboardArtifactLink[]): DashboardArtifactLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.file)) {
      return false;
    }
    seen.add(link.file);
    return true;
  });
}
