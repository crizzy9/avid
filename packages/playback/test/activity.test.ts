import { describe, expect, it, vi } from "vitest";
import {
  ActivityAccumulator,
  ActivitySessionTracker,
  createActivityJournal,
  type ActivityChunk,
  type ActivityObservation,
} from "../src";

const epoch = Date.parse("2026-10-09T12:00:00Z");
const playing: ActivityObservation = {
  bookId: "book-a",
  fileId: "file-a",
  kind: "listening",
  active: true,
  position: 0,
  rate: 1,
};
const time = (seconds: number) => epoch + seconds * 1000;
function accumulator() {
  let id = 0;
  return new ActivityAccumulator({ makeId: () => `session-${++id}` });
}
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("activity accounting", () => {
  it("counts real elapsed listening time at 2x, not double source time", () => {
    const tracker = accumulator();
    tracker.observe({ ...playing, rate: 2 }, 0, epoch);
    tracker.observe({ ...playing, rate: 2, position: 20 }, 10_000, time(10));
    expect(tracker.flush()[0]?.session.duration).toBe(10);
    expect(tracker.flush()).toEqual([]);
  });
  it("does not credit repeated snapshots, stalls, or forward/backward seeks", () => {
    const tracker = accumulator();
    tracker.observe(playing, 0, epoch);
    tracker.observe({ ...playing, position: 2 }, 2_000, time(2));
    tracker.observe({ ...playing, position: 2 }, 10_000, time(10)); // stalled without a browser waiting event
    tracker.observe({ ...playing, position: 3 }, 11_000, time(11));
    tracker.observe({ ...playing, position: 90 }, 12_000, time(12)); // seek
    tracker.observe({ ...playing, position: 5 }, 13_000, time(13)); // seek backward
    tracker.observe({ ...playing, position: 6 }, 14_000, time(14));
    expect(tracker.flush()[0]?.session.duration).toBe(4);
  });
  it("excludes paused and buffering intervals and keeps original source times", () => {
    const tracker = accumulator();
    tracker.observe(playing, 0, epoch);
    const first = tracker.observe(
      { ...playing, active: false, position: 4 },
      4_000,
      time(4),
    );
    tracker.observe(
      { ...playing, active: false, position: 4 },
      14_000,
      time(14),
    );
    tracker.observe(
      { ...playing, active: true, position: 4 },
      15_000,
      time(15),
    );
    tracker.observe({ ...playing, position: 7 }, 18_000, time(18));
    const second = tracker.flush();
    expect(first[0]?.session).toMatchObject({
      duration: 4,
      startedAt: new Date(epoch).toISOString(),
    });
    expect(first[0]?.endedAt).toBe(new Date(time(4)).toISOString());
    expect(second[0]?.session.duration).toBe(3);
    expect(first[0]?.session.id).not.toBe(second[0]?.session.id);
  });
  it("does not lose media advancement between same-position heartbeat samples", () => {
    const tracker = accumulator();
    tracker.observe(playing, 0, epoch);
    tracker.observe(playing, 800, epoch + 800);
    tracker.observe({ ...playing, position: 1 }, 1_000, time(1));
    expect(tracker.flush()[0]?.session.duration).toBe(1);
  });
  it("flushes old identity independently before observing the next title", () => {
    const tracker = accumulator();
    tracker.observe(playing, 0, epoch);
    tracker.observe({ ...playing, position: 3 }, 3_000, time(3));
    const previous = tracker.observe(
      { ...playing, bookId: "book-b", fileId: "file-b" },
      4_000,
      time(4),
    );
    tracker.observe(
      { ...playing, bookId: "book-b", fileId: "file-b", position: 2 },
      6_000,
      time(6),
    );
    expect(previous[0]).toMatchObject({
      session: { bookId: "book-a", duration: 3 },
      fileId: "file-a",
    });
    expect(tracker.flush()[0]).toMatchObject({
      session: { bookId: "book-b", duration: 2 },
      fileId: "file-b",
    });
  });
  it("speech counts observed active intervals and discards long suspension gaps", () => {
    const tracker = accumulator();
    const speech: ActivityObservation = {
      ...playing,
      kind: "speech",
      position: undefined,
    };
    tracker.observe(speech, 0, epoch);
    tracker.observe(speech, 1_000, time(1));
    tracker.observe(speech, 2_000, time(2));
    tracker.observe(speech, 60_000, time(60)); // runtime suspended, state alone cannot prove speech continued
    const ready = tracker.observe(
      { ...speech, active: false },
      61_000,
      time(61),
    );
    expect(ready[0]?.session).toMatchObject({ kind: "speech", duration: 3 });
    expect(ready[0]?.endedAt).toBe(new Date(time(61)).toISOString());
  });
  it("carries fractional seconds between flushes instead of rounding them up twice", () => {
    const tracker = accumulator();
    tracker.observe(playing, 0, epoch);
    tracker.observe({ ...playing, position: 1.6 }, 1_600, epoch + 1_600);
    expect(tracker.flush()[0]?.session.duration).toBe(1);
    tracker.observe({ ...playing, position: 2.4 }, 2_400, epoch + 2_400);
    expect(tracker.flush()[0]?.session.duration).toBe(1);
    expect(tracker.flush()).toEqual([]);
  });
});

describe("activity recovery", () => {
  it("serializes concurrent flushes and retries the same immutable chunk after failure", async () => {
    const storage = memoryStorage();
    const journal = createActivityJournal(storage, "server-a/user-1");
    const record = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const tracker = new ActivitySessionTracker(record, {
      journal,
      onError,
      makeId: () => "stable-id",
    });
    tracker.observe(playing, 0, epoch);
    tracker.observe({ ...playing, position: 8 }, 8_000, time(8));
    const first = tracker.flush();
    const concurrent = tracker.flush();
    expect(first).toBe(concurrent);
    await first;
    expect(journal.read()[0]?.session.id).toBe("stable-id");
    expect(tracker.pendingCount).toBe(1);
    await tracker.flush();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]).toEqual(record.mock.calls[0]);
    expect(record.mock.calls[0]?.[2]).toEqual({
      endedAt: new Date(time(8)).toISOString(),
      readOnly: true,
    });
    expect(journal.read()).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("recovers only the selected account and keeps the original event timestamps", async () => {
    const storage = memoryStorage();
    const a = createActivityJournal(storage, "server-a/user-a");
    const b = createActivityJournal(storage, "server-a/user-b");
    const chunk: ActivityChunk = {
      session: {
        id: "recovered",
        bookId: "book",
        kind: "listening",
        startedAt: new Date(epoch).toISOString(),
        duration: 12,
      },
      fileId: "file",
      endedAt: new Date(time(12)).toISOString(),
      readOnly: false,
    };
    a.append([chunk]);
    const recordB = vi.fn().mockResolvedValue(undefined);
    await new ActivitySessionTracker(recordB, { journal: b }).flush();
    expect(recordB).not.toHaveBeenCalled();
    const recordA = vi.fn().mockResolvedValue(undefined);
    await new ActivitySessionTracker(recordA, { journal: a }).flush();
    expect(recordA).toHaveBeenCalledWith(chunk.session, "file", {
      endedAt: chunk.endedAt,
      readOnly: false,
    });
  });
  it("acknowledges by ID without overwriting a newer remount journal entry", () => {
    const storage = memoryStorage();
    const original = createActivityJournal(storage, "account");
    const remount = createActivityJournal(storage, "account");
    const a: ActivityChunk = {
      session: {
        id: "a",
        bookId: "book",
        kind: "speech",
        startedAt: new Date(epoch).toISOString(),
        duration: 2,
      },
      fileId: "file",
      endedAt: new Date(time(2)).toISOString(),
      readOnly: true,
    };
    const b = { ...a, session: { ...a.session, id: "b" } };
    original.append([a]);
    remount.append([b]);
    original.acknowledge(["a"]);
    expect(remount.read().map((chunk) => chunk.session.id)).toEqual(["b"]);
  });
  it("rejects malformed persisted activity rather than submitting it", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "avid:pending-playback:v1:account",
      '[{"session":{"duration":-10}}]',
    );
    const record = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    await new ActivitySessionTracker(record, {
      journal: createActivityJournal(storage, "account"),
      onError,
    }).flush();
    expect(record).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
  it("keeps read-only provenance after failed storage and a writable reconnect", async () => {
    const storage = memoryStorage();
    const journal = createActivityJournal(storage, "account");
    const unavailable = vi
      .fn()
      .mockRejectedValue(new Error("IndexedDB unavailable"));
    const options = {
      journal,
      readOnly: true,
      makeId: () => "read-only-chunk",
    };
    const before = new ActivitySessionTracker(unavailable, options);
    before.observe(playing, 0, epoch);
    // Permission is captured at construction, not read from a mutable caller object at flush.
    options.readOnly = false;
    before.observe({ ...playing, position: 3 }, 3_000, time(3));
    await before.flush();
    expect(journal.read()[0]).toMatchObject({ readOnly: true });
    const recovered = vi.fn().mockResolvedValue(undefined);
    const after = new ActivitySessionTracker(recovered, {
      journal,
      readOnly: false,
      makeId: () => "writable-chunk",
    });
    await after.flush();
    expect(recovered.mock.calls[0][2]).toMatchObject({ readOnly: true });
    after.observe(playing, 4_000, time(4));
    after.observe({ ...playing, position: 2 }, 6_000, time(6));
    await after.flush();
    expect(recovered.mock.calls[1][2]).toMatchObject({ readOnly: false });
  });
  it("recovers legacy journals locally even when the new tracker is writable", async () => {
    const storage = memoryStorage();
    const legacy = {
      session: {
        id: "legacy",
        bookId: "book",
        kind: "speech",
        startedAt: new Date(epoch).toISOString(),
        duration: 2,
      },
      fileId: "file",
      endedAt: new Date(time(2)).toISOString(),
    };
    storage.setItem(
      "avid:pending-playback:v1:account",
      JSON.stringify([legacy]),
    );
    const record = vi.fn().mockResolvedValue(undefined);
    await new ActivitySessionTracker(record, {
      journal: createActivityJournal(storage, "account"),
      readOnly: false,
    }).flush();
    expect(record).toHaveBeenCalledWith(legacy.session, "file", {
      endedAt: legacy.endedAt,
      readOnly: true,
    });
  });
});
