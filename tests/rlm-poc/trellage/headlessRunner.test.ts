import { describe, expect, it } from "vitest";
import { nativeTrellageProcessRunner } from "../../../src/rlm-poc/trellage/headlessRunner.js";

describe("nativeTrellageProcessRunner", () => {
  it("forces termination of a launcher that ignores SIGTERM", async () => {
    const result = await nativeTrellageProcessRunner.run({
      argv: [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);',
      ],
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });
});
