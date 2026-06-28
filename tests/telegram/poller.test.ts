import { describe, expect, it } from "vitest";
import { startPoller, type UpdateSource } from "../../src/telegram/poller.js";
import type { TelegramUpdate } from "../../src/telegram/update.js";

function update(id: number): TelegramUpdate {
  return { update_id: id, message: { text: `m${id}`, chat: { id: 1 } } };
}

describe("startPoller", () => {
  it("delivers updates in order and advances the offset past the highest update_id", async () => {
    const requestedOffsets: number[] = [];
    const seen: number[] = [];
    let calls = 0;

    const source: UpdateSource = {
      async getUpdates(offset) {
        requestedOffsets.push(offset);
        calls += 1;
        if (calls === 1) return [update(5), update(6)];
        poller.stop();
        return [];
      },
    };

    const poller = startPoller(source, (u) => seen.push(u.update_id), {
      startOffset: 0,
      longPollSec: 0,
    });
    await poller.done;

    expect(seen).toEqual([5, 6]);
    expect(requestedOffsets[0]).toBe(0);
    expect(requestedOffsets[1]).toBe(7);
  });

  it("stops looping after stop() is called", async () => {
    let calls = 0;
    const source: UpdateSource = {
      async getUpdates() {
        calls += 1;
        poller.stop();
        return [];
      },
    };

    const poller = startPoller(source, () => {}, { startOffset: 0, longPollSec: 0 });
    await poller.done;

    expect(calls).toBe(1);
  });
});
