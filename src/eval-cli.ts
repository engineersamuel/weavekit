import { runEval } from "./eval/run.js";

const filterIds = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

runEval({ filterIds: filterIds.length > 0 ? filterIds : undefined })
  .then((dir) => {
    console.log(`Eval complete. Results written to ${dir}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
