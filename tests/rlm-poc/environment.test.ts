import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("loads config TOML before stale home env files and supplies local proxy defaults", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "weavekit-rlm-env-"));
    temporaryDirectories.push(homeDirectory);
    await mkdir(join(homeDirectory, ".weavekit"));
    await writeFile(
      join(homeDirectory, ".weavekit", "config.toml"),
      [
        'LANGFUSE_PUBLIC_KEY = "config-public"',
        'LANGFUSE_SECRET_KEY = "config-secret"',
        'LANGFUSE_BASE_URL = "http://localhost:3000"',
        "",
        "[copilot]",
        "verbose_events = false",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(homeDirectory, ".env"),
      [
        "LANGFUSE_PUBLIC_KEY=stale-home-public",
        "LANGFUSE_SECRET_KEY=stale-home-secret",
        "RLM_CUSTOM_SETTING=available",
        "",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    const loadVarlock = vi.fn(async () => {
      expect(env.LANGFUSE_PUBLIC_KEY).toBe("config-public");
      expect(env.LANGFUSE_SECRET_KEY).toBe("config-secret");
      expect(env.LANGFUSE_BASE_URL).toBe("http://localhost:3000");
      expect(env.RLM_CUSTOM_SETTING).toBe("available");
      expect(env.COPILOT_PROXY_BASE_URL).toBe("http://127.0.0.1:8080/v1");
      expect(env.COPILOT_PROXY_API_KEY).toBe("sk-local");
      expect(env.copilot).toBeUndefined();
    });

    const loaded = await loadRlmEnvironment({ homeDirectory, env, loadVarlock });

    expect(loaded).toEqual(["RLM_CUSTOM_SETTING"]);
    expect(loadVarlock).toHaveBeenCalledOnce();
  });

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

  it("preserves explicit process values over Weavekit config and ~/.env", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "weavekit-rlm-env-"));
    temporaryDirectories.push(homeDirectory);
    const configDirectory = join(homeDirectory, ".weavekit");
    await mkdir(configDirectory);
    await writeFile(join(configDirectory, "config.toml"), 'TG_CHAT_ID = "from-config"\n');
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

  it("loads Weavekit config before legacy ~/.env values", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "weavekit-rlm-env-"));
    temporaryDirectories.push(homeDirectory);
    const configDirectory = join(homeDirectory, ".weavekit");
    await mkdir(configDirectory);
    await writeFile(
      join(configDirectory, "config.toml"),
      [
        'LANGFUSE_PUBLIC_KEY = "from-config-public"',
        'LANGFUSE_SECRET_KEY = "from-config-secret"',
      ].join("\n"),
    );
    await writeFile(
      join(homeDirectory, ".env"),
      [
        "LANGFUSE_PUBLIC_KEY=stale-home-public",
        "LANGFUSE_SECRET_KEY=stale-home-secret",
        "RLM_CUSTOM_SETTING=available",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    const loadVarlock = vi.fn(async () => {
      expect(env.LANGFUSE_PUBLIC_KEY).toBe("from-config-public");
      expect(env.LANGFUSE_SECRET_KEY).toBe("from-config-secret");
      expect(env.RLM_CUSTOM_SETTING).toBe("available");
    });

    const loaded = await loadRlmEnvironment({ homeDirectory, env, loadVarlock });

    expect(loaded).toEqual(["RLM_CUSTOM_SETTING"]);
    expect(loadVarlock).toHaveBeenCalledOnce();
  });
});
