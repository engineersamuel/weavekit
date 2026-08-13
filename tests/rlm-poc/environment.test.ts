import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRlmEnvironment } from "../../src/rlm-poc/environment.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("loadRlmEnvironment", () => {
  it("loads all home .env values before invoking Varlock", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "weavekit-rlm-env-"));
    temporaryDirectories.push(homeDirectory);
    await writeFile(
      join(homeDirectory, ".env"),
      ["TG_BOT_ID=telegram-token", "TG_CHAT_ID=12345", "RLM_CUSTOM_SETTING=available", ""].join(
        "\n",
      ),
    );
    const env: NodeJS.ProcessEnv = {};
    const loadVarlock = vi.fn(async () => {
      expect(env.TG_BOT_ID).toBe("telegram-token");
      expect(env.TG_CHAT_ID).toBe("12345");
      expect(env.RLM_CUSTOM_SETTING).toBe("available");
    });

    const loaded = await loadRlmEnvironment({ homeDirectory, env, loadVarlock });

    expect(loaded).toEqual(["TG_BOT_ID", "TG_CHAT_ID", "RLM_CUSTOM_SETTING"]);
    expect(loadVarlock).toHaveBeenCalledOnce();
  });

  it("preserves explicit process values over ~/.env", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "weavekit-rlm-env-"));
    temporaryDirectories.push(homeDirectory);
    await writeFile(join(homeDirectory, ".env"), "TG_CHAT_ID=from-home\n");
    const env: NodeJS.ProcessEnv = { TG_CHAT_ID: "from-shell" };

    const loaded = await loadRlmEnvironment({
      homeDirectory,
      env,
      loadVarlock: async () => {},
    });

    expect(env.TG_CHAT_ID).toBe("from-shell");
    expect(loaded).toEqual([]);
  });
});
