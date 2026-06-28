import type { TelegramUpdate } from "./update.js";

/** The slice of a Telegram client the poller needs. */
export interface UpdateSource {
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

export type Poller = {
  /** Stop the loop and abort any in-flight long-poll request. */
  stop(): void;
  /** Resolves when the loop has fully stopped. */
  done: Promise<void>;
};

/**
 * Single-consumer Telegram update loop. Telegram permits only one getUpdates consumer per bot,
 * so the whole process must share exactly one poller; every update flows through `onUpdate`,
 * which is responsible for routing (see TelegramInquiry.handleUpdate). The offset is advanced
 * past each delivered update so confirmed updates are never redelivered.
 */
export function startPoller(
  source: UpdateSource,
  onUpdate: (update: TelegramUpdate) => void,
  options: { startOffset: number; longPollSec?: number },
): Poller {
  const controller = new AbortController();
  const longPoll = options.longPollSec ?? 25;
  let stopped = false;
  let offset = options.startOffset;

  const done = (async () => {
    while (!stopped) {
      let updates: TelegramUpdate[];
      try {
        updates = await source.getUpdates(offset, longPoll, controller.signal);
      } catch (err) {
        if (stopped) break; // aborted by stop()
        throw err;
      }
      for (const update of updates) {
        offset = update.update_id + 1;
        onUpdate(update);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
    },
    done: done.catch(() => {}),
  };
}
