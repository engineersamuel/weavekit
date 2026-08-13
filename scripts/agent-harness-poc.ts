import { runDemo } from "../src/agent-harness-poc/harness.js";

async function main(): Promise<void> {
  try {
    const result = await runDemo();
    console.log("--- Agent Harness POC ---");
    console.log("Loaded skills:", result.loadedSkills.join(", "));
    console.log("Metrics:", JSON.stringify(result.metrics));
    console.log("Headlines:", result.headlines.join(" | "));
    console.log("Approved report:", result.reportPath);
    console.log("\nTrace events:");
    for (const event of result.trace) {
      console.log(`${event.ts} ${event.type} ${event.message ?? ""}`);
    }
  } catch (error) {
    console.error("Demo failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
