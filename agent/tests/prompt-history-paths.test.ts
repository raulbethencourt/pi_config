import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// prompt-store.ts resolves the global sessions root and the cache file path
// under os.homedir(), so os.homedir() is mocked to a temp directory for the
// duration of each test in this file (matching the pattern used in
// tests/coordination-stale-session-prune.test.ts for the same kind of
// homedir-based path resolution).

let tempHome = "";

async function loadPromptStore() {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      homedir: () => tempHome,
    };
  });
  return await import("../extensions/prompt-history/prompt-store.ts");
}

describe("prompt-history path resolution", () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-paths-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:os");
    if (tempHome && fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("resolveSessionsRoot resolves to <mockedHome>/.pi/agent/sessions", async () => {
    const store = await loadPromptStore();

    const resolved = store.resolveSessionsRoot();

    expect(resolved).toBe(path.join(tempHome, ".pi", "agent", "sessions"));
  });

  it("resolveCacheFilePath resolves to <mockedHome>/.pi/agent/state/prompt-history/cache.json", async () => {
    const store = await loadPromptStore();

    const resolved = store.resolveCacheFilePath();

    expect(resolved).toBe(
      path.join(tempHome, ".pi", "agent", "state", "prompt-history", "cache.json"),
    );
  });
});
