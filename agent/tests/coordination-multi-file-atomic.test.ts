import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLocksForPaths } from "../extensions/coordination/index.ts";
import {
  acquireLock,
  releaseLocksForToolCall,
  lockPathFor,
} from "../extensions/coordination/lock-store.ts";

// ── index.ts: multi-file atomic-acquire helper ─────────────────────────
// Given several target canonical paths from one `edit` tool call,
// acquireLocksForPaths sorts them lexicographically and acquires them in
// that order with a bounded retry/backoff. If any single acquisition in the
// sequence fails, every lock acquired so far in that same call must be
// rolled back (released) before the failure is reported — no partial lock
// state should survive a failed multi-file acquisition.
//
// `maxAttempts`/`backoffMs` are accepted as optional overrides purely to
// keep this suite fast and deterministic (a permanently-contended path would
// otherwise force the default retry/backoff to run to completion).

describe("coordination multi-file atomic acquire (index.ts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-atomic-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("acquires all 3 target locks atomically when none are contended", async () => {
    const pathA = path.join(tmpDir, "a-file.txt");
    const pathB = path.join(tmpDir, "b-file.txt");
    const pathC = path.join(tmpDir, "c-file.txt");

    const result = await acquireLocksForPaths({
      canonicalPaths: [pathC, pathA, pathB], // deliberately out of order — helper must sort
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-atomic",
      toolCallId: "call-atomic-1",
    });

    expect(result.acquired).toBe(true);
    expect(fs.existsSync(lockPathFor(tmpDir, pathA))).toBe(true);
    expect(fs.existsSync(lockPathFor(tmpDir, pathB))).toBe(true);
    expect(fs.existsSync(lockPathFor(tmpDir, pathC))).toBe(true);

    releaseLocksForToolCall("call-atomic-1");
  });

  it("rolls back every lock acquired so far when a later path in the sorted sequence is contended by a different live pid", async () => {
    const pathA = path.join(tmpDir, "a-file.txt"); // sorts 1st
    const pathB = path.join(tmpDir, "b-file.txt"); // sorts 2nd — pre-held by another live pid
    const pathC = path.join(tmpDir, "c-file.txt"); // sorts 3rd — must never even be attempted

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const otherPid = 999888;
    const preHeld = await acquireLock({
      canonicalPath: pathB,
      sessionDir: tmpDir,
      pid: otherPid,
      agentName: "worker-other",
      toolCallId: "call-other",
    });
    expect(preHeld.acquired).toBe(true);

    const result = await acquireLocksForPaths({
      canonicalPaths: [pathC, pathB, pathA], // deliberately out of order
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-atomic",
      toolCallId: "call-atomic-2",
      maxAttempts: 2,
      backoffMs: 5,
    });

    expect(result.acquired).toBe(false);

    // path A was acquired first in sorted order, then must be rolled back on
    // the later failure — no lock file should remain for it.
    expect(fs.existsSync(lockPathFor(tmpDir, pathA))).toBe(false);
    // path B remains held by the original (still-live) holder, untouched.
    expect(fs.existsSync(lockPathFor(tmpDir, pathB))).toBe(true);
    // path C sorts after the contended path B, so the sequence must never
    // have reached it.
    expect(fs.existsSync(lockPathFor(tmpDir, pathC))).toBe(false);

    killSpy.mockRestore();
    releaseLocksForToolCall("call-other");
  });
});
