import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Trace } from "./trace.js";
import { SkillCatalog } from "./catalog.js";
import { DeterministicApproval } from "./approval.js";
import { ConfinedShell } from "./shell.js";
import { CodeActRunner } from "./codeact.js";
import { BackgroundCoordinator, DeferredBarrier } from "./background.js";

export type HarnessResult = {
  metrics: PortfolioMetrics;
  headlines: string[];
  loadedSkills: string[];
  reportPath: string;
  workspacePath: string;
  trace: ReturnType<Trace["list"]>;
};

type PortfolioMetrics = {
  total: number;
  byTicker: Record<string, number>;
};

export async function runDemo(): Promise<HarnessResult> {
  const trace = new Trace();
  const workRoot = mkdtempSync(path.join(os.tmpdir(), "agent-harness-"));
  trace.push("harness.start", `workspace ${workRoot}`);

  const catalog = new SkillCatalog(path.join(process.cwd(), "src/agent-harness-poc/skills"), trace);
  const discovered = catalog.discover();
  const portfolioDesc = discovered.find((d) => d.id === "portfolio-valuation");
  const marketDesc = discovered.find((d) => d.id === "market-headlines");
  if (!portfolioDesc || !marketDesc) {
    throw new Error("Required prototype skills were not discovered.");
  }

  catalog.loadSkillBody(portfolioDesc);
  trace.push("harness.skill.loaded", `loaded ${portfolioDesc.id}`);
  const holdings = [
    { ticker: "AAPL", qty: 10 },
    { ticker: "MSFT", qty: 5 },
  ];
  const prices = { AAPL: 150, MSFT: 300 };
  const jsCode = `return (function compute(input){ const {holdings, prices} = input; let total=0; const byTicker={}; for(const h of holdings){ const p = prices[h.ticker] || 0; const v = h.qty * p; byTicker[h.ticker]=v; total+=v; } return { total, byTicker }; })(input);`;
  const codeAct = new CodeActRunner(trace);
  const codeActOut = await codeAct.run(jsCode, { holdings, prices }, 2000);
  if (!codeActOut.ok || !isPortfolioMetrics(codeActOut.output)) {
    trace.push("harness.error", "codeact failed", { err: codeActOut.error });
    throw new Error(`CodeAct failed: ${codeActOut.error ?? "invalid metrics"}`);
  }
  const metrics = codeActOut.output;
  trace.push("harness.metrics", "metrics computed");

  catalog.loadSkillBody(marketDesc);
  trace.push("harness.skill.loaded", `loaded ${marketDesc.id}`);
  const bg = new BackgroundCoordinator(trace);
  const barrier = new DeferredBarrier(2);
  const appleWorker = async () => {
    barrier.markStarted();
    await barrier.wait();
    return {
      id: "AAPL",
      payload: ["AAPL: Services growth offsets softer hardware demand."],
    };
  };
  const microsoftWorker = async () => {
    barrier.markStarted();
    await barrier.wait();
    return {
      id: "MSFT",
      payload: ["MSFT: Cloud demand remains the primary growth driver."],
    };
  };

  const workersPromise = bg.runWorkersInParallel([appleWorker, microsoftWorker]);
  await barrier.allStarted();
  barrier.release();
  const results = await workersPromise;
  const headlines = results.flatMap((r) =>
    Array.isArray(r.payload) ? (r.payload as string[]) : [],
  );
  trace.push("harness.headlines", "collected headlines", { headlines });

  const approval = new DeterministicApproval(true);
  const shell = new ConfinedShell(workRoot, approval, trace);
  const reportPath = path.join(workRoot, "report.txt");
  const content = `Portfolio metrics:\n${JSON.stringify(metrics, null, 2)}\nHeadlines:\n${headlines.join("\n")}\n`;
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  const writeReport =
    "const fs=require('node:fs');const [name,data]=process.argv.slice(1);" +
    "fs.writeFileSync(name,Buffer.from(data,'base64'));";
  const execResult = await shell.exec("node", ["-e", writeReport, "report.txt", encodedContent], {
    cwd: ".",
    timeoutMs: 2000,
  });
  if (execResult.timedOut || execResult.code !== 0 || !existsSync(reportPath)) {
    trace.push("harness.report.fail", "report write failed", {
      code: execResult.code,
      stderr: execResult.stderr,
    });
    throw new Error("report write failed");
  }
  trace.push("harness.report", "wrote report via confined shell", { report: reportPath });
  trace.push("harness.end", "demo complete");
  return {
    metrics,
    headlines,
    loadedSkills: [portfolioDesc.id, marketDesc.id],
    reportPath,
    workspacePath: workRoot,
    trace: trace.list(),
  };
}

function isPortfolioMetrics(value: unknown): value is PortfolioMetrics {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Record<string, unknown>;
  if (
    typeof metrics.total !== "number" ||
    !metrics.byTicker ||
    typeof metrics.byTicker !== "object"
  ) {
    return false;
  }
  return Object.values(metrics.byTicker).every((amount) => typeof amount === "number");
}
