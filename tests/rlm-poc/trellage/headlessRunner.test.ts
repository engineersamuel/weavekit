import { describe, expect, it } from "vitest";
import { nativeTrellageProcessRunner } from "../../../src/rlm-poc/trellage/headlessRunner.js";

describe("nativeTrellageProcessRunner", () => {
  it.skipIf(process.platform === "win32")(
    "forces termination of a launcher that ignores SIGTERM",
    async () => {
      const result = await nativeTrellageProcessRunner.run({
        argv: ["/bin/sh", "-c", 'trap "" TERM; while :; do sleep 1; done'],
        cwd: process.cwd(),
        timeoutMs: 1_000,
      });

      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
    },
  );
});
