#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadLocalEnvFiles, loadMastermindRuntimeConfig } from "../src/config.js";
import { attachMastermindExecution, SqliteMastermindStore } from "../src/mastermind/index.js";

loadLocalEnvFiles();

let store: SqliteMastermindStore | undefined;
try {
  const selector = process.argv[2] ?? "";
  const config = await loadMastermindRuntimeConfig();
  store = new SqliteMastermindStore(config.mastermind.sqlitePath);
  await store.initialize();
  await attachMastermindExecution({
    selector,
    store,
    herdrEnv: process.env.HERDR_ENV,
    run: (command, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (exitCode) => resolve({ exitCode }));
      }),
  });
} catch (error) {
  process.stderr.write(
    `mastermind:attach failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  store?.close();
}
