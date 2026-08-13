import type { HerdrReadSource } from "../../herdr/scope.js";
import type { TrellageProfile } from "./contracts.js";

export type TrellageSession = {
  /** Herdr agent target — a pane ID or unique agent name accepted by every `agent.*` method. */
  readonly agentId: string;
  readonly paneId: string;
  readonly tabId: string;
  /** Herdr's detected agent kind (`claude`, `codex`, `copilot`, …), when it classified one. */
  readonly kind?: string;
};

export type TrellageLaunchInput = {
  profile: TrellageProfile;
  /** Native Copilot (`cpx`) or native Claude (`cldx`) model override validated by the tool layer. */
  model?: string;
  /** Native Claude (`cldx`) reasoning-effort override validated by the tool layer. */
  effort?: string;
  /** Host directory the harness runs in; for container mode this becomes the bind-mounted root. */
  cwd: string;
  label: string;
};

/**
 * Seam between the drive loop and the terminal multiplexer that actually owns the PTY.
 *
 * `trellage` asserts `[[ -t 0 && -t 1 ]]`, so it can only be driven from a real terminal. The
 * default implementation delegates to Herdr, which owns the PTY and TTY-scrapes it into a
 * lifecycle state machine. Tests supply a fake so they never need a TTY.
 */
export type TrellageBackend = {
  launch(input: TrellageLaunchInput): Promise<TrellageSession>;
  prompt(session: TrellageSession, text: string): Promise<void>;
  /** Blocks until the agent reaches one of `states`, then reports the state it observed. */
  waitForState(
    session: TrellageSession,
    states: readonly string[],
    timeoutMs: number,
  ): Promise<string>;
  /** Reports the agent's status without blocking. `exited` means the pane's process is gone. */
  status(session: TrellageSession): Promise<string>;
  read(
    session: TrellageSession,
    options?: { source?: HerdrReadSource; lines?: number },
  ): Promise<string>;
  sendKeys(session: TrellageSession, keys: string[]): Promise<void>;
  dispose(session: TrellageSession): Promise<void>;
};

/** Status reported when the hosting pane's process has exited. */
export const TRELLAGE_EXITED_STATUS = "exited";
