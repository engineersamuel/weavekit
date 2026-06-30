import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWeavekitConfig } from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("weavekit config loader", () => {
  it("loads environment values from a config file without overriding existing env vars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weavekit-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, 'COPILOT_PROXY_BASE_URL = "http://127.0.0.1:8080/v1"\nBAML_MODEL = "gpt-5-mini"\n');

    const original = process.env.COPILOT_PROXY_BASE_URL;
    process.env.COPILOT_PROXY_BASE_URL = "https://existing.example/v1";

    try {
      const loaded = loadWeavekitConfig(configPath, process.env);
      expect(loaded).toEqual({
        COPILOT_PROXY_BASE_URL: "http://127.0.0.1:8080/v1",
        BAML_MODEL: "gpt-5-mini",
      });
      expect(process.env.COPILOT_PROXY_BASE_URL).toBe("https://existing.example/v1");
      expect(process.env.BAML_MODEL).toBe("gpt-5-mini");
    } finally {
      if (original === undefined) {
        delete process.env.COPILOT_PROXY_BASE_URL;
      } else {
        process.env.COPILOT_PROXY_BASE_URL = original;
      }
      delete process.env.BAML_MODEL;
    }
  });
});
