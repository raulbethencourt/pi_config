import { afterEach, describe, expect, it, vi } from "vitest";
import { Semaphore, resolveMaxConcurrency } from "../extensions/mcp-server/concurrency.ts";

describe("Semaphore", () => {
  it("allows up to `max` concurrent acquisitions without blocking", async () => {
    const sem = new Semaphore(2);
    let acquired = 0;
    await sem.acquire();
    acquired++;
    await sem.acquire();
    acquired++;
    expect(acquired).toBe(2);
  });

  it("blocks the (max+1)th acquire() until a prior holder releases", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    let thirdAcquired = false;
    const thirdAcquire = sem.acquire().then(() => {
      thirdAcquired = true;
    });

    // Give any pending microtasks a chance to run; the third acquire must
    // still be pending because both slots are held.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(thirdAcquired).toBe(false);

    sem.release();
    await thirdAcquire;
    expect(thirdAcquired).toBe(true);
  });

  it("hands a released slot to the oldest waiter (FIFO)", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: string[] = [];
    const waiterA = sem.acquire().then(() => order.push("A"));
    const waiterB = sem.acquire().then(() => order.push("B"));

    sem.release(); // should wake A
    await waiterA;
    sem.release(); // should wake B
    await waiterB;

    expect(order).toEqual(["A", "B"]);
  });
});

describe("resolveMaxConcurrency", () => {
  const originalEnv = process.env.PI_MCP_SERVER_MAX_CONCURRENCY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PI_MCP_SERVER_MAX_CONCURRENCY;
    else process.env.PI_MCP_SERVER_MAX_CONCURRENCY = originalEnv;
    vi.restoreAllMocks();
  });

  // NOTE: as currently implemented, resolveMaxConcurrency() does NOT clamp an
  // out-of-range value to MAX_CONCURRENCY (16) — it falls back to the default
  // (4), same as a non-numeric value. This test locks in that actual behavior;
  // see the tester's report for a flagged discrepancy against the originally
  // stated spec ("clamps ... to the max (16)").
  it("falls back to the default (4) for an out-of-range value above the max (999), not clamped to 16", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PI_MCP_SERVER_MAX_CONCURRENCY = "999";
    expect(resolveMaxConcurrency()).toBe(4);
  });

  it("falls back to the default (4) for an out-of-range value below the min (0)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PI_MCP_SERVER_MAX_CONCURRENCY = "0";
    expect(resolveMaxConcurrency()).toBe(4);
  });

  it("falls back to the default (4) for a non-numeric value", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PI_MCP_SERVER_MAX_CONCURRENCY = "not-a-number";
    expect(resolveMaxConcurrency()).toBe(4);
  });

  it("falls back to the default (4) when unset", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.PI_MCP_SERVER_MAX_CONCURRENCY;
    expect(resolveMaxConcurrency()).toBe(4);
  });

  it("accepts an in-range integer value unchanged", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PI_MCP_SERVER_MAX_CONCURRENCY = "8";
    expect(resolveMaxConcurrency()).toBe(8);
  });
});
