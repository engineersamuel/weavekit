import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoist mocks before any module import
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  cpSync: vi.fn(),
  realpathSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { ensureSkillInstalled, resolveSkillsCacheDir } from "../../src/personas/skillInstaller.js";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockCpSync = vi.mocked(cpSync);
const mockRealpathSync = vi.mocked(realpathSync);
// execFile has complex overloads; cast to any for mockImplementation
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

const FAKE_PKG_ROOT = "/fake/claude-superskills";
const FAKE_CLI = join(FAKE_PKG_ROOT, "bin", "cli.js");
const FAKE_CACHE_DIR = "/fake/cache/skills";
const FAKE_DISCOVERY_DIR = join(FAKE_CACHE_DIR, ".github", "skills");

const testSkill = {
  name: "mckinsey-strategist",
  bundle: "mckinsey",
  installer: "claude-superskills",
} as const;

/** Make execFile immediately invoke its callback with success. */
function makeExecFileSucceed(): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: realpathSync returns the fake pkg root
  mockRealpathSync.mockReturnValue(FAKE_PKG_ROOT);
});

afterEach(() => {
  delete process.env.WEAVEKIT_SKILLS_DIR;
});

// ──────────────────────────────────────────────────────────────────────────────
// resolveSkillsCacheDir
// ──────────────────────────────────────────────────────────────────────────────
describe("resolveSkillsCacheDir", () => {
  it("(d) explicit cacheDir arg overrides env and default", () => {
    process.env.WEAVEKIT_SKILLS_DIR = "/from/env";
    const result = resolveSkillsCacheDir("/explicit/override");
    expect(result).toBe("/explicit/override");
  });

  it("(d) WEAVEKIT_SKILLS_DIR env overrides computed default", () => {
    process.env.WEAVEKIT_SKILLS_DIR = "/from/env/skills";
    const result = resolveSkillsCacheDir();
    expect(result).toBe("/from/env/skills");
  });

  it("(d) computed default ends with .weavekit/skills when package.json found", () => {
    // Allow the upward search to find package.json immediately
    mockExistsSync.mockImplementation((p) => String(p).endsWith("package.json"));
    const result = resolveSkillsCacheDir();
    expect(result).toMatch(/\.weavekit[/\\]skills$/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ensureSkillInstalled
// ──────────────────────────────────────────────────────────────────────────────
describe("ensureSkillInstalled", () => {
  it("(a) returns discoveryDir immediately when SKILL.md is present — no execFile call", async () => {
    // existsSync returns true → idempotency short-circuit
    mockExistsSync.mockReturnValue(true);

    const result = await ensureSkillInstalled({
      skill: testSkill,
      cacheDir: FAKE_CACHE_DIR,
    });

    expect(result).toBe(FAKE_DISCOVERY_DIR);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it("(b) on install: execFile receives correct args and bundles.json is copied to both probe paths", async () => {
    // First call (idempotency probe) → absent; second call (post-verify) → present
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    makeExecFileSucceed();

    await ensureSkillInstalled({ skill: testSkill, cacheDir: FAKE_CACHE_DIR });

    // execFile called with correct args
    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe(process.execPath);
    expect(args[0]).toMatch(/cli\.js$/);
    expect(args.slice(1)).toEqual(["install", "--bundle", "mckinsey", "--scope", "local", "-y"]);
    expect(opts.cwd).toBe(FAKE_CACHE_DIR);

    // bundles.json copied to both probe paths
    const copyDests = mockCpSync.mock.calls.map((c) => String(c[1]));
    expect(copyDests).toContain(join(FAKE_PKG_ROOT, "bundles.json"));
    expect(copyDests).toContain(join(FAKE_PKG_ROOT, "..", "bundles.json"));

    // mkdirSync called for discoveryDir
    expect(mockMkdirSync).toHaveBeenCalledWith(FAKE_DISCOVERY_DIR, { recursive: true });
  });

  it("(b) returns discoveryDir on successful install", async () => {
    mockExistsSync.mockReturnValueOnce(false).mockReturnValueOnce(true);
    makeExecFileSucceed();

    const result = await ensureSkillInstalled({ skill: testSkill, cacheDir: FAKE_CACHE_DIR });
    expect(result).toBe(FAKE_DISCOVERY_DIR);
  });

  it("(c) throws when SKILL.md is still absent after install", async () => {
    // Both calls return false (absent before and after install)
    mockExistsSync.mockReturnValue(false);
    makeExecFileSucceed();

    await expect(
      ensureSkillInstalled({ skill: testSkill, cacheDir: FAKE_CACHE_DIR }),
    ).rejects.toThrow(/mckinsey/);
  });

  it("throws a descriptive error when skill.bundle is missing", async () => {
    mockExistsSync.mockReturnValue(false); // not yet installed
    const skillNoBunde = { name: "mckinsey-strategist", installer: "claude-superskills" };

    await expect(
      ensureSkillInstalled({ skill: skillNoBunde, cacheDir: FAKE_CACHE_DIR }),
    ).rejects.toThrow(/bundle/i);

    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
