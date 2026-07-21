import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// session-dir.ts resolves coordination directories under
// ~/.pi/agent/state/coordination/<sessionId>/, so os.homedir() is mocked to
// a temp directory for the duration of each test in this file (matching the
// pattern used in tests/telemetry.test.ts for the same kind of homedir-based
// path resolution). Only real process.kill mocking is used here — no real
// subprocess spawning (that's covered separately in
// coordination-lock-store.test.ts's SIGKILL regression test).

let tempHome = "";

async function loadCoordination() {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      homedir: () => tempHome,
    };
  });
  const sessionDir = await import("../extensions/coordination/session-dir.ts");
  const index = await import("../extensions/coordination/index.ts");
  return { sessionDir, index };
}

describe("coordination stale session pruning", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-prune-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:os");
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("resolveCoordinationDir places a session dir under ~/.pi/agent/state/coordination/<sessionId>", async () => {
    const { sessionDir } = await loadCoordination();

    const resolved = sessionDir.resolveCoordinationDir("12345-1700000000000");

    expect(resolved).toBe(
      path.join(tempHome, ".pi", "agent", "state", "coordination", "12345-1700000000000"),
    );
  });

  it("isSessionStale returns true for a dead-pid directory name", async () => {
    const { sessionDir } = await loadCoordination();
    const deadPid = 999999;

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === deadPid) {
        const err: NodeJS.ErrnoException = new Error("ESRCH");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as never);

    expect(sessionDir.isSessionStale(`${deadPid}-1700000000000`)).toBe(true);

    killSpy.mockRestore();
  });

  it("isSessionStale returns false for a live-pid directory name", async () => {
    const { sessionDir } = await loadCoordination();

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    expect(sessionDir.isSessionStale(`${process.pid}-1700000000000`)).toBe(false);

    killSpy.mockRestore();
  });

  it("listSessionDirs enumerates the session id directory names under the coordination root", async () => {
    const { sessionDir } = await loadCoordination();

    fs.mkdirSync(sessionDir.resolveCoordinationDir("11111-1700000000000"), { recursive: true });
    fs.mkdirSync(sessionDir.resolveCoordinationDir("22222-1700000000111"), { recursive: true });

    const dirs = sessionDir.listSessionDirs();

    expect(dirs).toContain("11111-1700000000000");
    expect(dirs).toContain("22222-1700000000111");
  });

  it("identifies a session directory named with a dead pid as stale and removes it via pruneStaleSessions", async () => {
    const { sessionDir, index } = await loadCoordination();
    const deadPid = 888888;
    const staleDirName = `${deadPid}-1700000000000`;
    const staleDirPath = sessionDir.resolveCoordinationDir(staleDirName);
    fs.mkdirSync(staleDirPath, { recursive: true });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === deadPid) {
        const err: NodeJS.ErrnoException = new Error("ESRCH");
        err.code = "ESRCH";
        throw err;
      }
      return true;
    }) as never);

    const result = index.pruneStaleSessions();

    expect(result.removed).toContain(staleDirName);
    expect(fs.existsSync(staleDirPath)).toBe(false);

    killSpy.mockRestore();
  });

  it("leaves a session directory named with a live pid alone", async () => {
    const { sessionDir, index } = await loadCoordination();
    const livePid = process.pid;
    const liveDirName = `${livePid}-1700000000000`;
    const liveDirPath = sessionDir.resolveCoordinationDir(liveDirName);
    fs.mkdirSync(liveDirPath, { recursive: true });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const result = index.pruneStaleSessions();

    expect(result.removed).not.toContain(liveDirName);
    expect(fs.existsSync(liveDirPath)).toBe(true);

    killSpy.mockRestore();
  });
});
