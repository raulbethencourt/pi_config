import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  releaseLocksForToolCall,
  lockPathFor,
} from "../extensions/coordination/lock-store.ts";
import { canonicalizePath } from "../extensions/coordination/session-dir.ts";

// ── lock-store: single-file acquire/release primitive ──────────────────
// acquireLock({ canonicalPath, sessionDir, pid, agentName, toolCallId }) is a
// single-shot, non-blocking attempt: it grants immediately if nobody holds
// the lock (or the recorded holder pid is dead), and otherwise reports
// contention with `heldBy`. There is no internal retry/backoff here — that
// lives one layer up, in index.ts's multi-file atomic helper.

describe("coordination lock-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-lock-store-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("grants immediately when no lock exists", async () => {
    const canonicalPath = path.join(tmpDir, "file-a.txt");

    const result = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-a",
      toolCallId: "call-1",
    });

    expect(result.acquired).toBe(true);
    expect(result.heldBy).toBeUndefined();
    expect(fs.existsSync(lockPathFor(tmpDir, canonicalPath))).toBe(true);

    releaseLocksForToolCall("call-1");
  });

  it("grants immediately with zero disk write when the same pid+toolCallId re-acquires (reentrancy)", async () => {
    const canonicalPath = path.join(tmpDir, "file-b.txt");

    const first = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-a",
      toolCallId: "call-2",
    });
    expect(first.acquired).toBe(true);

    const openSpy = vi.spyOn(fs.promises, "open");

    const second = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-a",
      toolCallId: "call-2",
    });

    expect(second.acquired).toBe(true);
    // Reentrant re-acquire must not touch disk at all — it's satisfied purely
    // from the in-process refcount map.
    expect(openSpy).not.toHaveBeenCalled();

    releaseLocksForToolCall("call-2");
  });

  it("denies when a different LIVE pid holds it, and does NOT delete the existing lock file", async () => {
    const canonicalPath = path.join(tmpDir, "file-c.txt");
    const holderPid = 123456;

    // Simulate the holder pid being alive: process.kill(pid, 0) does not throw.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const first = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: holderPid,
      agentName: "worker-holder",
      toolCallId: "call-3",
    });
    expect(first.acquired).toBe(true);

    const contender = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: 654321,
      agentName: "worker-contender",
      toolCallId: "call-4",
    });

    expect(contender.acquired).toBe(false);
    expect(contender.heldBy).toEqual({ pid: holderPid, agentName: "worker-holder" });
    // The original lock file must survive an unsuccessful contention attempt.
    expect(fs.existsSync(lockPathFor(tmpDir, canonicalPath))).toBe(true);

    killSpy.mockRestore();
    releaseLocksForToolCall("call-3");
  });

  it("reaps and grants when the recorded pid is dead", async () => {
    const canonicalPath = path.join(tmpDir, "file-d.txt");
    const deadPid = 222222;

    const aliveSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const first = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: deadPid,
      agentName: "worker-dead",
      toolCallId: "call-5",
    });
    expect(first.acquired).toBe(true);
    aliveSpy.mockRestore();

    const deadSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === deadPid) {
        const err: NodeJS.ErrnoException = new Error("ESRCH");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as never);

    const second = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: 333333,
      agentName: "worker-alive",
      toolCallId: "call-6",
    });

    expect(second.acquired).toBe(true);
    expect(second.heldBy).toBeUndefined();

    const lockContent = JSON.parse(fs.readFileSync(lockPathFor(tmpDir, canonicalPath), "utf8"));
    expect(lockContent.pid).toBe(333333);

    deadSpy.mockRestore();
    releaseLocksForToolCall("call-6");
  });

  // ── Regression: no TTL / elapsed-time reap trigger ────────────────────
  // Design decision under direct test here: a lock held by a LIVE pid is
  // NEVER reaped no matter how old its recorded/on-disk timestamp is. The
  // *only* thing that ever grants a reap is process.kill(pid, 0) throwing
  // ESRCH (see the "reaps and grants when the recorded pid is dead" test
  // above) — there is no separate "lock is older than N minutes, steal it
  // anyway" code path. This test backdates the lock file's mtime by 30 days
  // while keeping the holder pid mocked alive, and asserts the lock is still
  // denied to the contender.
  it("NEVER reaps a lock held by a live pid, even with a simulated very-old timestamp (no TTL reap trigger)", async () => {
    const canonicalPath = path.join(tmpDir, "file-e.txt");
    const holderPid = 444444;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const first = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: holderPid,
      agentName: "worker-old",
      toolCallId: "call-7",
    });
    expect(first.acquired).toBe(true);

    const lockPath = lockPathFor(tmpDir, canonicalPath);
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, ancient, ancient);

    const contender = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: 555555,
      agentName: "worker-new",
      toolCallId: "call-8",
    });

    expect(contender.acquired).toBe(false);
    expect(contender.heldBy).toEqual({ pid: holderPid, agentName: "worker-old" });
    // The ancient lock file must still be intact — elapsed time alone never
    // triggers a reap.
    expect(fs.existsSync(lockPath)).toBe(true);

    killSpy.mockRestore();
    releaseLocksForToolCall("call-7");
  });

  // ── Regression: real SIGKILL, no safety-net delay besides dead-pid check ──
  // Spawns a genuine short-lived subprocess, records its real pid as the lock
  // holder, SIGKILLs it, waits only for the OS-confirmed "exit" event (not an
  // artificial sleep/timeout), and asserts the very next acquisition attempt
  // succeeds immediately — proving dead-pid detection alone is sufficient,
  // with no elapsed-time grace period required.
  it("succeeds immediately once a real subprocess holding the lock is SIGKILLed (no artificial delay)", async () => {
    const canonicalPath = path.join(tmpDir, "file-f.txt");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);

    if (!child.pid) {
      throw new Error("failed to spawn test subprocess (no pid assigned)");
    }

    const first = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: child.pid,
      agentName: "worker-subprocess",
      toolCallId: "call-9",
    });
    expect(first.acquired).toBe(true);

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited; // OS-confirmed exit, not an artificial sleep

    const second = await acquireLock({
      canonicalPath,
      sessionDir: tmpDir,
      pid: process.pid,
      agentName: "worker-recover",
      toolCallId: "call-10",
    });

    expect(second.acquired).toBe(true);
    releaseLocksForToolCall("call-10");
  }, 10000);

  // ── Regression: genuine concurrent reapers racing the SAME stale lock ────
  // The bug this guards against: acquireLock's dead-pid reap path used to
  // unlink() the stale lock file and then re-attempt the exclusive create as
  // two separate, non-atomic steps. Two callers racing to reap the exact
  // same stale entry could interleave so BOTH believed they'd won: racer A
  // unlinks the stale file and recreates it (A now "holds" the lock), then
  // racer B — still acting on its own earlier read of the stale entry —
  // unlinks A's brand-new lock file (believing it's still the original stale
  // one) and recreates its own in the same spot. This is a genuine
  // cross-process race (real OS scheduling of separate `open`/`unlink`
  // syscalls), so it has to be reproduced with real separate processes
  // racing in real wall-clock time — a single Node process cannot interleave
  // acquireLock's synchronous reap steps against itself, since nothing
  // yields the event loop mid-reap, which is exactly why the existing
  // sequential, one-call-at-a-time tests above never caught it.
  describe("concurrent reapers racing the same dead-pid lock (real cross-process race)", () => {
    it("grants the lock to at most one of several racers reaping the same stale entry, and every loser observes real contention against the winner", async () => {
      const canonicalPath = path.join(tmpDir, "raced-file.txt");
      const sessionDir = tmpDir;
      const lockStorePath = fileURLToPath(
        new URL("../extensions/coordination/lock-store.ts", import.meta.url),
      );

      // A genuinely dead pid: spawn a throwaway subprocess and wait for its
      // real exit (same technique as the SIGKILL regression test above).
      const deadHolder = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await new Promise<void>((resolve) => deadHolder.once("exit", () => resolve()));
      const deadPid = deadHolder.pid!;

      const lockPath = lockPathFor(sessionDir, canonicalPath);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: deadPid,
          agentName: "stale-holder",
          toolCallId: "stale-call",
          acquiredAt: Date.now(),
        }),
        "utf8",
      );

      // A real, separate .mts worker process (forced ESM regardless of the
      // tmp dir's lack of a package.json) that busy-waits on a shared
      // barrier file before calling the real acquireLock — this is what
      // makes every racer's attempt begin as close together in real time as
      // possible, rather than sequentially.
      const workerPath = path.join(tmpDir, "racer-worker.mts");
      fs.writeFileSync(
        workerPath,
        [
          `import { acquireLock } from ${JSON.stringify(lockStorePath)};`,
          `import * as fs from "node:fs";`,
          ``,
          `const [canonicalPath, sessionDir, agentName, toolCallId, barrierPath] = process.argv.slice(2);`,
          ``,
          `process.stdout.write("READY\\n");`,
          `while (!fs.existsSync(barrierPath)) {`,
          `  // Tight spin, no sleep — sleeping would only widen start skew.`,
          `}`,
          ``,
          `const result = await acquireLock({ canonicalPath, sessionDir, pid: process.pid, agentName, toolCallId });`,
          `process.stdout.write(JSON.stringify({ ...result, racerPid: process.pid }) + "\\n");`,
          ``,
          `// Stay alive briefly so sibling racers checking isProcessAlive against`,
          `// this pid observe a real, live process rather than racing our exit.`,
          `setTimeout(() => process.exit(0), 1000);`,
        ].join("\n"),
        "utf8",
      );

      const barrierPath = path.join(tmpDir, "barrier");
      const racerCount = 6;

      const racers = Array.from({ length: racerCount }, (_, i) => {
        const child = spawn(process.execPath, [
          workerPath,
          canonicalPath,
          sessionDir,
          `racer-${i}`,
          `call-${i}`,
          barrierPath,
        ]);
        let buf = "";
        let resolveReady: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        child.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes("READY\n")) resolveReady();
        });
        return { child, ready, getBuf: () => buf };
      });

      // Wait for every racer to signal readiness before releasing the
      // barrier, so all of them attempt acquireLock as close together in
      // real time as possible.
      await Promise.all(racers.map((r) => r.ready));
      fs.writeFileSync(barrierPath, "go");

      const results = await Promise.all(
        racers.map(
          ({ child, getBuf }) =>
            new Promise<{ acquired: boolean; heldBy?: { pid: number; agentName: string }; racerPid: number }>(
              (resolve, reject) => {
                child.once("exit", () => {
                  const lines = getBuf().trim().split("\n").filter(Boolean);
                  const resultLine = lines.find((l) => l !== "READY");
                  if (!resultLine) {
                    reject(new Error(`racer produced no result line (got: ${JSON.stringify(lines)})`));
                    return;
                  }
                  resolve(JSON.parse(resultLine));
                });
                child.once("error", reject);
              },
            ),
        ),
      );

      for (const { child } of racers) {
        if (!child.killed) child.kill("SIGKILL");
      }

      // At most (exactly) one racer may believe it holds the lock.
      const winners = results.filter((r) => r.acquired);
      expect(winners).toHaveLength(1);

      // Every loser must have observed genuine contention against the real
      // winner — not a false success, and not stale/mismatched contention
      // against some intermediate racer that itself never actually won.
      const winnerPid = winners[0].racerPid;
      const losers = results.filter((r) => !r.acquired);
      expect(losers).toHaveLength(racerCount - 1);
      for (const loser of losers) {
        expect(loser.heldBy?.pid).toBe(winnerPid);
      }
    }, 15000);
  });

  // ── Regression: reaper crashes mid-reap, orphaning the reap-mutex ───────
  // The bug this guards against: the reap-mutex's own dead-pid-holder check
  // used to unconditionally `unlinkSync` the mutex file whenever its
  // recorded holder pid looked dead, with no re-verification at the moment
  // of unlink. Two racers could both read the same dead-pid mutex holder and
  // both race to unlink+recreate the mutex, ending up both believing they
  // hold "the" mutex simultaneously — reproducing the exact double-acquire
  // the mutex exists to prevent, one layer down. The fix: never unlink the
  // reap-mutex based on a liveness check of its content; report ordinary
  // contention instead and defer to the caller's own retry/backoff loop.
  //
  // This simulates a reaper that crashed mid-reap: the main lock is present
  // and stale (recorded holder pid is dead), AND the reap-mutex file is
  // already present, recording a pid that is ALSO dead (the crashed
  // reaper). Per the fail-safe design, this path never becomes acquirable
  // again on its own — only that it never produces a false/double grant is
  // asserted here.
  it("never grants a false/double acquire when a reap-mutex is orphaned by a reaper that crashed mid-reap (dead pid recorded in both the main lock and the mutex)", async () => {
    const canonicalPath = path.join(tmpDir, "orphaned-mutex-file.txt");
    const deadHolderPid = 999991;
    const deadReaperPid = 999992;

    const lockPath = lockPathFor(tmpDir, canonicalPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Stale main lock: recorded holder is dead.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: deadHolderPid,
        agentName: "stale-holder",
        toolCallId: "stale-call",
        acquiredAt: Date.now(),
      }),
      "utf8",
    );
    // Reap-mutex left behind by a reaper that crashed mid-reap, recording
    // its own (now also dead) pid.
    const reapMutexPath = `${lockPath}.reap-mutex`;
    fs.writeFileSync(reapMutexPath, String(deadReaperPid), "utf8");

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === deadHolderPid || pid === deadReaperPid) {
        const err: NodeJS.ErrnoException = new Error("ESRCH");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as never);

    const racerCount = 5;
    const results = await Promise.all(
      Array.from({ length: racerCount }, (_, i) =>
        acquireLock({
          canonicalPath,
          sessionDir: tmpDir,
          pid: 700000 + i,
          agentName: `racer-${i}`,
          toolCallId: `orphan-call-${i}`,
        }),
      ),
    );

    // (a) No double-acquire: with the mutex permanently orphaned, NOBODY
    // acquires — the fail-safe property that matters, not eventual success.
    expect(results.every((r) => !r.acquired)).toBe(true);

    // (b) Every racer observes real contention/denial rather than a silent
    // false grant.
    for (const r of results) {
      expect(r.heldBy).toEqual({ pid: deadHolderPid, agentName: "stale-holder" });
    }

    // The reap-mutex must survive untouched — never unlinked based on a
    // liveness check of its content alone (the exact behavior this
    // regression guards against).
    expect(fs.existsSync(reapMutexPath)).toBe(true);
    // The stale main lock also survives, since no racer was ever allowed to
    // reach the point of actually reaping it.
    expect(fs.existsSync(lockPath)).toBe(true);

    killSpy.mockRestore();
  });

  // ── canonicalizePath (session-dir.ts) basics ──────────────────────────

  describe("canonicalizePath", () => {
    it("resolves an existing file to its realpath", async () => {
      const realFile = path.join(tmpDir, "real-target.txt");
      fs.writeFileSync(realFile, "hello");

      const resolved = await canonicalizePath(realFile);

      expect(resolved).toBe(fs.realpathSync(realFile));
    });

    it("falls back to realpath-the-parent-dir + basename for a not-yet-existing write target", async () => {
      const notYetExisting = path.join(tmpDir, "brand-new-file.txt");

      const resolved = await canonicalizePath(notYetExisting);

      expect(resolved).toBe(path.join(fs.realpathSync(tmpDir), "brand-new-file.txt"));
    });

    it("falls back to plain path.resolve when even the parent directory cannot be resolved", async () => {
      const bogus = path.join(tmpDir, "does-not-exist-dir", "nested", "file.txt");

      const resolved = await canonicalizePath(bogus);

      expect(resolved).toBe(path.resolve(bogus));
    });
  });

  // ── Symlink canonicalization + lock contention ────────────────────────
  // Two different absolute path strings that resolve to the same underlying
  // file via a symlink must map to the same lock key and contend with each
  // other, rather than being treated as two independent files.

  describe("symlink canonicalization and lock contention", () => {
    it("maps a real file and a symlink pointing at it to the same canonical path", async () => {
      const realFile = path.join(tmpDir, "actual-file.txt");
      fs.writeFileSync(realFile, "content");
      const symlinkPath = path.join(tmpDir, "symlink-to-actual-file.txt");
      fs.symlinkSync(realFile, symlinkPath);

      const canonicalReal = await canonicalizePath(realFile);
      const canonicalSymlink = await canonicalizePath(symlinkPath);

      expect(canonicalSymlink).toBe(canonicalReal);
    });

    it("contends on the lock when acquired via two paths that resolve to the same file through a symlink", async () => {
      const realFile = path.join(tmpDir, "shared-actual-file.txt");
      fs.writeFileSync(realFile, "content");
      const symlinkPath = path.join(tmpDir, "shared-symlink.txt");
      fs.symlinkSync(realFile, symlinkPath);

      const canonicalViaReal = await canonicalizePath(realFile);
      const canonicalViaSymlink = await canonicalizePath(symlinkPath);

      const first = await acquireLock({
        canonicalPath: canonicalViaReal,
        sessionDir: tmpDir,
        pid: 777777,
        agentName: "worker-real-path",
        toolCallId: "call-11",
      });
      expect(first.acquired).toBe(true);

      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

      const second = await acquireLock({
        canonicalPath: canonicalViaSymlink,
        sessionDir: tmpDir,
        pid: 888888,
        agentName: "worker-symlink-path",
        toolCallId: "call-12",
      });

      expect(second.acquired).toBe(false);
      expect(second.heldBy).toEqual({ pid: 777777, agentName: "worker-real-path" });

      killSpy.mockRestore();
      releaseLocksForToolCall("call-11");
    });
  });
});
