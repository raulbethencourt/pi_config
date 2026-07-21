import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// tasks.ts guards each read-modify-write cycle against `<sessionDir>/tasks.json`
// by acquiring/releasing a `<sessionDir>/tasks.json.lock` through the SAME
// lock-store primitive used elsewhere in this extension (not a second,
// bespoke locking mechanism). We partially mock lock-store here — keeping
// its real behavior via vi.importActual, just wrapped in vi.fn() so calls
// are observable — to verify that guarding actually happens, following the
// vi.mock + importActual pattern already used in this repo (see
// tests/mobile-bridge.test.ts / tests/telemetry.test.ts for the same style
// applied to other modules).

vi.mock("../extensions/coordination/lock-store.ts", async () => {
  const actual = await vi.importActual<typeof import("../extensions/coordination/lock-store.ts")>(
    "../extensions/coordination/lock-store.ts",
  );
  return {
    ...actual,
    acquireLock: vi.fn(actual.acquireLock),
    releaseLocksForToolCall: vi.fn(actual.releaseLocksForToolCall),
  };
});

import { readTasks, writeTasks, upsertTask } from "../extensions/coordination/tasks.ts";
import * as lockStore from "../extensions/coordination/lock-store.ts";

describe("coordination tasks.json store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-tasks-test-"));
    vi.mocked(lockStore.acquireLock).mockClear();
    vi.mocked(lockStore.releaseLocksForToolCall).mockClear();
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates the entry when tasks.json does not exist yet", async () => {
    expect(fs.existsSync(path.join(tmpDir, "tasks.json"))).toBe(false);

    const tasks = await upsertTask(tmpDir, {
      id: "task-1",
      status: "pending",
      description: "do thing",
    });

    expect(tasks).toEqual([{ id: "task-1", status: "pending", description: "do thing" }]);

    const reread = await readTasks(tmpDir);
    expect(reread).toEqual([{ id: "task-1", status: "pending", description: "do thing" }]);
  });

  it("updates an existing entry by id on a second call, without losing other entries", async () => {
    await upsertTask(tmpDir, { id: "task-1", status: "pending" });
    await upsertTask(tmpDir, { id: "task-2", status: "pending" });

    const updated = await upsertTask(tmpDir, { id: "task-1", status: "done" });

    expect(updated).toHaveLength(2);
    expect(updated.find((t: any) => t.id === "task-1")).toEqual({ id: "task-1", status: "done" });
    expect(updated.find((t: any) => t.id === "task-2")).toEqual({ id: "task-2", status: "pending" });
  });

  it("writeTasks followed by readTasks round-trips the full list", async () => {
    const tasks = [
      { id: "task-1", status: "pending" },
      { id: "task-2", status: "in-progress" },
    ];

    await writeTasks(tmpDir, tasks);
    const reread = await readTasks(tmpDir);

    expect(reread).toEqual(tasks);
  });

  it("readTasks returns an empty list when tasks.json does not exist", async () => {
    const tasks = await readTasks(tmpDir);
    expect(tasks).toEqual([]);
  });

  it("acquires and releases a tasks.json.lock via the lock-store primitive around each mutation", async () => {
    await upsertTask(tmpDir, { id: "task-1", status: "pending" });

    expect(lockStore.acquireLock).toHaveBeenCalled();
    const acquireArgs = vi.mocked(lockStore.acquireLock).mock.calls[0][0];
    expect(acquireArgs.canonicalPath).toBe(path.join(tmpDir, "tasks.json.lock"));

    expect(lockStore.releaseLocksForToolCall).toHaveBeenCalled();
    const releaseArg = vi.mocked(lockStore.releaseLocksForToolCall).mock.calls[0][0];
    // The same toolCallId used to acquire must be the one released.
    expect(releaseArg).toBe(acquireArgs.toolCallId);

    // The lock file itself must not survive past the guarded mutation.
    expect(fs.existsSync(path.join(tmpDir, "tasks.json.lock"))).toBe(false);
  });
});
