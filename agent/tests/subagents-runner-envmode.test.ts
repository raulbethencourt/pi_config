import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { spawnPiProcess } from "../extensions/subagents/runner.ts";

function makeResult() {
  return {
    agent: "test-agent",
    task: "test task",
    output: "",
    exitCode: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    progress: undefined as any,
  } as any;
}

function makeProgress() {
  return {
    agent: "test-agent",
    status: "running",
    task: "test task",
    recentTools: [],
    toolCount: 0,
    tokens: 0,
    durationMs: 0,
    lastMessage: "",
  } as any;
}

function baseOpts(overrides: Partial<Parameters<typeof spawnPiProcess>[0]> = {}) {
  const result = makeResult();
  const progress = makeProgress();
  result.progress = progress;
  return {
    command: "pi",
    spawnArgs: ["--mode", "json"],
    cwd: "/tmp",
    signal: undefined,
    result,
    progress,
    startTime: Date.now(),
    fireUpdate: () => {},
    extractToolArgsPreview: () => "",
    extractTextContent: () => "",
    ...overrides,
  };
}

describe("spawnPiProcess — envMode", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("merges process.env with the passed env when envMode is omitted (legacy default)", async () => {
    process.env.__TEST_LEGACY_KEY__ = "from-process-env";
    try {
      let capturedEnv: Record<string, string | undefined> | undefined;
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      spawnMock.mockImplementation((_command, _args, options) => {
        capturedEnv = options.env;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      });

      await spawnPiProcess(baseOpts({ env: { FOO: "bar" } }) as any);

      expect(capturedEnv?.FOO).toBe("bar");
      expect(capturedEnv?.__TEST_LEGACY_KEY__).toBe("from-process-env");
    } finally {
      delete process.env.__TEST_LEGACY_KEY__;
    }
  });

  it("merges process.env with the passed env when envMode is explicitly 'merge'", async () => {
    process.env.__TEST_LEGACY_KEY2__ = "still-here";
    try {
      let capturedEnv: Record<string, string | undefined> | undefined;
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      spawnMock.mockImplementation((_command, _args, options) => {
        capturedEnv = options.env;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      });

      await spawnPiProcess(baseOpts({ env: { FOO: "bar" }, envMode: "merge" }) as any);

      expect(capturedEnv?.FOO).toBe("bar");
      expect(capturedEnv?.__TEST_LEGACY_KEY2__).toBe("still-here");
    } finally {
      delete process.env.__TEST_LEGACY_KEY2__;
    }
  });

  it("restricts the child's env to exactly the passed env when envMode is 'replace', even when process.env has extra keys", async () => {
    process.env.__TEST_SECRET_LOOKING_KEY__ = "should-not-leak";
    try {
      let capturedEnv: Record<string, string | undefined> | undefined;
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      spawnMock.mockImplementation((_command, _args, options) => {
        capturedEnv = options.env;
        queueMicrotask(() => child.emit("close", 0));
        return child;
      });

      await spawnPiProcess(baseOpts({ env: { ONLY_KEY: "only-value" }, envMode: "replace" }) as any);

      expect(capturedEnv).toEqual({ ONLY_KEY: "only-value" });
      expect(capturedEnv?.__TEST_SECRET_LOOKING_KEY__).toBeUndefined();
      expect(Object.keys(capturedEnv ?? {})).toEqual(["ONLY_KEY"]);
    } finally {
      delete process.env.__TEST_SECRET_LOOKING_KEY__;
    }
  });
});

describe("spawnPiProcess — spawn-error capture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    spawnMock.mockReset();
  });

  it("surfaces the actual spawn error message (e.g. ENOENT) instead of a generic failure", async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        const err = Object.assign(new Error("spawn /nonexistent/pi ENOENT"), { code: "ENOENT" });
        child.emit("error", err);
      });
      return child;
    });

    const opts = baseOpts();
    const { exitCode, stderrBuf } = await spawnPiProcess(opts as any);

    expect(exitCode).toBe(1);
    expect(opts.progress.error).toBe("spawn /nonexistent/pi ENOENT");
    expect(stderrBuf).toContain("spawn /nonexistent/pi ENOENT");
  });

  it("does not overwrite an already-set progress.error with a generic message on spawn error", async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("error", new Error("EACCES: permission denied"));
      });
      return child;
    });

    const opts = baseOpts();
    opts.progress.error = "pre-existing error";
    await spawnPiProcess(opts as any);

    // Runner only sets progress.error if not already set; the raw message
    // still needs to be captured in stderrBuf for callers that inspect it.
    expect(opts.progress.error).toBe("pre-existing error");
  });
});
