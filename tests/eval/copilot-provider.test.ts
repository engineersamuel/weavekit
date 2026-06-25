import { EventEmitter } from "node:events";
import { CopilotCliProvider } from "../../src/eval/providers/copilot.js";

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

describe("CopilotCliProvider", () => {
  it("passes the prompt and required flags and returns stdout", async () => {
    const child = makeFakeChild();
    let calledWith: { cmd: string; args: string[] } | undefined;
    const provider = new CopilotCliProvider({
      model: "auto",
      spawnFn: ((cmd: string, args: string[]) => {
        calledWith = { cmd, args };
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("Use A.\n"));
          child.emit("close", 0);
        });
        return child as never;
      }) as never,
    });
    const res = await provider.callApi("A or B?");
    expect(calledWith?.cmd).toBe("copilot");
    expect(calledWith?.args).toContain("-p");
    expect(calledWith?.args).toContain("A or B?");
    expect(calledWith?.args).toContain("--allow-all");
    expect(calledWith?.args).toContain("--no-color");
    expect(res.output).toBe("Use A.");
  });

  it("returns an error on non-zero exit", async () => {
    const child = makeFakeChild();
    const provider = new CopilotCliProvider({
      spawnFn: (() => {
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("nope"));
          child.emit("close", 1);
        });
        return child as never;
      }) as never,
    });
    const res = await provider.callApi("A or B?");
    expect(res.error).toMatch(/exit 1/);
    expect(res.error).toMatch(/nope/);
  });
});
