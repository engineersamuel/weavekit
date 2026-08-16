import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Trace } from "../../src/agent-harness-poc/trace.js";
import { SkillCatalog } from "../../src/agent-harness-poc/catalog.js";
import { DeterministicApproval } from "../../src/agent-harness-poc/approval.js";
import { ConfinedShell } from "../../src/agent-harness-poc/shell.js";
import { CodeActRunner } from "../../src/agent-harness-poc/codeact.js";
import { BackgroundCoordinator, DeferredBarrier } from "../../src/agent-harness-poc/background.js";
import { runDemo } from "../../src/agent-harness-poc/harness.js";

describe("Agent Harness POC", () => {
  it("catalog discovers skills without loading bodies", () => {
    const trace = new Trace();
    const catalog = new SkillCatalog(
      path.join(process.cwd(), "src/agent-harness-poc/skills"),
      trace,
    );
    const discovered = catalog.discover();
    expect(discovered.length).toBeGreaterThanOrEqual(2);
    const ids = discovered.map((descriptor) => descriptor.id);
    expect(ids).toContain("portfolio-valuation");
    expect(ids).toContain("market-headlines");
  });

  it("loads skill body only on demand", () => {
    const trace = new Trace();
    const catalog = new SkillCatalog(
      path.join(process.cwd(), "src/agent-harness-poc/skills"),
      trace,
    );
    const discovered = catalog.discover();
    const descriptor = discovered.find((skill) => skill.id === "portfolio-valuation");
    if (!descriptor) throw new Error("Expected portfolio skill descriptor.");
    expect(trace.list().some((event) => event.type.startsWith("catalog.load."))).toBe(false);
    const body = catalog.loadSkillBody(descriptor);
    expect(typeof body).toBe("string");
    expect(trace.list().some((event) => event.type === "catalog.load.start")).toBe(true);
  });

  it("approval gate denies actions deterministically", async () => {
    const approval = new DeterministicApproval(false);
    const shell = new ConfinedShell(
      mkdtempSync(path.join(os.tmpdir(), "ah-")),
      approval,
      new Trace(),
    );
    await expect(shell.exec("echo", ["hello"])).rejects.toThrow(/denied/);
  });

  it("confined shell writes file under workspace when approved", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "ah-"));
    try {
      const approval = new DeterministicApproval(true);
      const shell = new ConfinedShell(workspace, approval, new Trace());
      const script = "require('node:fs').writeFileSync('out.txt','ok')";
      const result = await shell.exec("node", ["-e", script], {
        cwd: ".",
        timeoutMs: 2000,
      });
      expect(result).toMatchObject({ code: 0, timedOut: false });
      expect(existsSync(path.join(workspace, "out.txt"))).toBe(true);
      expect(approval.requests).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("confined shell rejects traversal and absolute", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "ah-"));
    const approval = new DeterministicApproval(true);
    const shell = new ConfinedShell(ws, approval, new Trace());
    await expect(shell.exec("ls", [".."])).rejects.toThrow();
    await expect(shell.exec("/bin/ls", ["."])).rejects.toThrow();
    expect(approval.requests).toHaveLength(0);
    rmSync(ws, { recursive: true, force: true });
  });

  it("codeact computes deterministically", async () => {
    const trace = new Trace();
    const runner = new CodeActRunner(trace);
    const code = `return (function(input){ return {sum: input.a + input.b}; })(input);`;
    const out = await runner.run(code, { a: 2, b: 3 }, 1000);
    expect(out.ok).toBe(true);
    expect(out.output).toEqual({ sum: 5 });
  });

  it("codeact times out long running code", async () => {
    const trace = new Trace();
    const runner = new CodeActRunner(trace);
    const code = `while(true){};`;
    const out = await runner.run(code, {}, 100);
    expect(out.ok).toBe(false);
    expect(out.error).toBeDefined();
  });

  it("codeact denies filesystem reads", async () => {
    const trace = new Trace();
    const runner = new CodeActRunner(trace);
    const code = "return process.getBuiltinModule('node:fs').readFileSync('/etc/hosts', 'utf8');";
    const out = await runner.run(code, {}, 1000);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/restricted|permission|access/iu);
  });

  it("codeact denies child process creation", async () => {
    const runner = new CodeActRunner(new Trace());
    const code =
      "return process.getBuiltinModule('node:child_process').spawnSync(process.execPath, ['--version']);";
    const out = await runner.run(code, {}, 1000);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/restricted|permission|access/iu);
  });

  it("background coordinator runs workers concurrently and aggregates in order", async () => {
    const trace = new Trace();
    const bg = new BackgroundCoordinator(trace);
    const barrier = new DeferredBarrier(2);
    const w1 = async () => {
      trace.push("t.w1.start", "w1");
      barrier.markStarted();
      await barrier.wait();
      return { id: "a", payload: 1 };
    };
    const w2 = async () => {
      trace.push("t.w2.start", "w2");
      barrier.markStarted();
      await barrier.wait();
      return { id: "b", payload: 2 };
    };
    const outP = bg.runWorkersInParallel([w1, w2]);
    await barrier.allStarted();
    barrier.release();
    const results = await outP;
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("harness end-to-end runs", async () => {
    const result = await runDemo();
    try {
      expect(result.metrics).toEqual({
        total: 3000,
        byTicker: { AAPL: 1500, MSFT: 1500 },
      });
      expect(result.loadedSkills).toEqual(["portfolio-valuation", "market-headlines"]);
      expect(result.headlines).toHaveLength(2);
      expect(readFileSync(result.reportPath, "utf8")).toContain("MSFT");
      const eventTypes = result.trace.map((event) => event.type);
      expect(eventTypes).toContain("shell.exec.requested");
      expect(eventTypes).toContain("shell.exec.end");
      expect(eventTypes.filter((type) => type === "catalog.load.end")).toHaveLength(2);
    } finally {
      rmSync(result.workspacePath, { recursive: true, force: true });
    }
  });
});
