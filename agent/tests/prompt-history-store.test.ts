import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Vitest 3.2.7 + Node 24 cannot vi.spyOn directly on a `node:fs` namespace
// import ("Module namespace is not configurable in ESM"). vi.mock(..., {
// spy: true }) is the supported alternative: it wraps every export of the
// real module in a spy while preserving the real implementation, and (since
// vi.mock calls are hoisted) applies to prompt-store.ts's own `node:fs`
// import too, not just this test file's.
vi.mock("node:fs", { spy: true });
import {
  extractUserPromptText,
  parseSessionFile,
  toPreviewLabel,
  formatRelativeTime,
  workspaceLabelFromDirName,
  dedupeMostRecent,
  loadCache,
  saveCache,
  isFileUnchanged,
  refreshPromptHistory,
  RECENT_WINDOW_MS,
  type PromptHistoryCache,
} from "../extensions/prompt-history/prompt-store.ts";

// Expected contract (prompt-store.ts does not exist yet — this file is RED
// until a worker implements it):
//
//   extractUserPromptText(record: unknown): string | null
//   parseSessionFile(filePath: string): { text: string; timestampMs: number }[]
//   toPreviewLabel(text: string, maxLen: number): string
//   formatRelativeTime(timestampMs: number, now: number): string
//   workspaceLabelFromDirName(dirName: string): string
//   dedupeMostRecent<T extends { text: string; timestampMs: number }>(entries: T[]): T[]
//   loadCache(cachePath: string): PromptHistoryCache
//   saveCache(cachePath: string, cache: PromptHistoryCache): void
//   isFileUnchanged(
//     stat: { mtimeMs: number; size: number },
//     cached: { mtimeMs: number; size: number; contentHash: string },
//     computeHash: () => string,
//     now: number,
//   ): boolean
//   refreshPromptHistory(
//     sessionsRoot: string,
//     cache: PromptHistoryCache,
//     now?: number,
//   ): { entries: { text: string; timestampMs: number; workspace: string; sessionFile: string }[]; cache: PromptHistoryCache }
//   RECENT_WINDOW_MS === 5000
//
// Cache shape: { version: 1, files: Record<string, { mtimeMs: number; size: number; contentHash: string; prompts: {text, timestampMs}[] }> }

function writeJsonlFile(filePath: string, prompts: { text: string; timestampMs: number }[]) {
  const lines = prompts.map((p) =>
    JSON.stringify({
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: p.text }],
        timestamp: p.timestampMs,
      },
    }),
  );
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

describe("extractUserPromptText", () => {
  it("returns joined text for a role:user message with one text block", () => {
    const record = {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hello there" }] },
    };
    expect(extractUserPromptText(record)).toBe("hello there");
  });

  it("joins multiple text blocks with \\n\\n", () => {
    const record = {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "first block" },
          { type: "text", text: "second block" },
        ],
      },
    };
    expect(extractUserPromptText(record)).toBe("first block\n\nsecond block");
  });

  it("returns null for image-only content", () => {
    const record = {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", data: "base64==", mimeType: "image/png" }],
      },
    };
    expect(extractUserPromptText(record)).toBeNull();
  });

  it("returns null for non-message record types", () => {
    const record = {
      type: "toolResult",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    };
    expect(extractUserPromptText(record)).toBeNull();
  });

  it("returns null for non-user roles (assistant)", () => {
    const record = {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    };
    expect(extractUserPromptText(record)).toBeNull();
  });

  it("returns null for non-user roles (toolResult)", () => {
    const record = {
      type: "message",
      message: { role: "toolResult", content: [{ type: "text", text: "hello" }] },
    };
    expect(extractUserPromptText(record)).toBeNull();
  });

  it("handles a plain-string content field defensively (trimmed)", () => {
    const record = {
      type: "message",
      message: { role: "user", content: "  hi there  " },
    };
    expect(extractUserPromptText(record)).toBe("hi there");
  });
});

describe("parseSessionFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-parse-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips a malformed/non-JSON line without throwing and without dropping subsequent valid lines", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    const validLine1 = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "before the bad line" }], timestamp: 1000 },
    });
    const validLine2 = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "after the bad line" }], timestamp: 2000 },
    });
    fs.writeFileSync(filePath, `${validLine1}\nthis is not valid JSON {{{\n${validLine2}\n`);

    expect(() => parseSessionFile(filePath)).not.toThrow();

    const result = parseSessionFile(filePath);
    expect(result.map((r) => r.text)).toEqual(["before the bad line", "after the bad line"]);
  });

  it("derives timestampMs from top-level ISO timestamp", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    const record = {
      type: "message",
      timestamp: "2024-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "iso-timestamped prompt" }], timestamp: 999 },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);

    const result = parseSessionFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].timestampMs).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  it("falls back to message.timestamp (numeric) when top-level timestamp is missing", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    const record = {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "no top-level timestamp" }], timestamp: 123456 },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);

    const result = parseSessionFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].timestampMs).toBe(123456);
  });

  it("falls back to message.timestamp (numeric) when top-level timestamp is invalid", () => {
    const filePath = path.join(tmpDir, "session.jsonl");
    const record = {
      type: "message",
      timestamp: "not-a-real-date",
      message: { role: "user", content: [{ type: "text", text: "invalid top-level timestamp" }], timestamp: 654321 },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`);

    const result = parseSessionFile(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].timestampMs).toBe(654321);
  });
});

describe("toPreviewLabel", () => {
  it("collapses embedded newlines/repeated whitespace to a single space", () => {
    expect(toPreviewLabel("hello\n\nworld   foo\tbar", 200)).toBe("hello world foo bar");
  });

  it("truncates text longer than maxLen and appends an ellipsis", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = toPreviewLabel(text, 10);
    expect(result).toBe("abcdefghij…");
  });

  it("leaves shorter text untouched", () => {
    expect(toPreviewLabel("hi", 10)).toBe("hi");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_700_000_000_000;

  it("returns 'just now' for a timestamp seconds in the past", () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
  });

  it("returns a minute-scale string for a timestamp minutes in the past", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("returns an hour-scale string for a timestamp hours in the past", () => {
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("returns a day-scale string for a timestamp days in the past", () => {
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("workspaceLabelFromDirName", () => {
  it("strips exactly one leading and one trailing '--'", () => {
    expect(workspaceLabelFromDirName("--home-rabeta-.pi--")).toBe("home-rabeta-.pi");
  });

  it("strips only one layer of '--' when more than one is present", () => {
    expect(workspaceLabelFromDirName("----abc----")).toBe("--abc--");
  });
});

describe("dedupeMostRecent", () => {
  it("dedupes entries whose text differs only in leading/trailing whitespace, keeping the newer by timestampMs", () => {
    const entries = [
      { text: "  buy milk  ", timestampMs: 1000 },
      { text: "buy milk", timestampMs: 2000 },
    ];

    const result = dedupeMostRecent(entries);

    expect(result).toHaveLength(1);
    expect(result[0].timestampMs).toBe(2000);
  });

  it("is case-sensitive: entries differing only in case are treated as distinct", () => {
    const entries = [
      { text: "hello world", timestampMs: 1000 },
      { text: "HELLO WORLD", timestampMs: 2000 },
    ];

    const result = dedupeMostRecent(entries);

    expect(result).toHaveLength(2);
  });

  it("treats entries differing in internal whitespace/newlines as distinct (no internal collapsing before the equality check)", () => {
    const entries = [
      { text: "hello\nworld", timestampMs: 1000 },
      { text: "hello world", timestampMs: 2000 },
    ];

    const result = dedupeMostRecent(entries);

    expect(result).toHaveLength(2);
  });

  it("never applies toPreviewLabel-style aggressive whitespace collapsing before the trim-only equality check", () => {
    // Both of these collapse to the identical string "hello world" under
    // toPreviewLabel's /\s+/g collapsing, but they are NOT equal under a
    // trim()-only comparison — both must survive as separate entries.
    const collapsedA = "hello\nworld".replace(/\s+/g, " ");
    const collapsedB = "hello   world".replace(/\s+/g, " ");
    expect(collapsedA).toBe(collapsedB); // sanity check on the premise itself

    const entries = [
      { text: "hello\nworld", timestampMs: 1000 },
      { text: "hello   world", timestampMs: 2000 },
    ];

    const result = dedupeMostRecent(entries);

    expect(result).toHaveLength(2);
  });
});

describe("loadCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-load-cache-test-"));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a fresh empty cache when the file doesn't exist", () => {
    const cachePath = path.join(tmpDir, "does-not-exist.json");

    const cache = loadCache(cachePath);

    expect(cache).toEqual({ version: 1, files: {} });
  });

  it("returns a fresh empty cache when the file has invalid JSON", () => {
    const cachePath = path.join(tmpDir, "invalid.json");
    fs.writeFileSync(cachePath, "{ this is not valid json");

    const cache = loadCache(cachePath);

    expect(cache).toEqual({ version: 1, files: {} });
  });

  it("returns a fresh empty cache when the file has the wrong version", () => {
    const cachePath = path.join(tmpDir, "wrong-version.json");
    fs.writeFileSync(cachePath, JSON.stringify({ version: 2, files: { foo: {} } }));

    const cache = loadCache(cachePath);

    expect(cache).toEqual({ version: 1, files: {} });
  });
});

describe("saveCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-save-cache-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("round-trips with loadCache and creates the parent directory if missing", () => {
    const cachePath = path.join(tmpDir, "nested", "deep", "cache.json");
    const cache: PromptHistoryCache = {
      version: 1,
      files: {
        "/some/file.jsonl": {
          mtimeMs: 12345,
          size: 678,
          contentHash: "abc123",
          prompts: [{ text: "hello", timestampMs: 111 }],
        },
      },
    };

    saveCache(cachePath, cache);

    expect(fs.existsSync(path.dirname(cachePath))).toBe(true);
    expect(loadCache(cachePath)).toEqual(cache);
  });

  it("writes via a temp-file + atomic rename rather than an in-place write", () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const cache: PromptHistoryCache = { version: 1, files: {} };

    // fs is spied module-wide via vi.mock(..., { spy: true }) above; grab the
    // already-installed spies and clear prior call history (e.g. from
    // mkdtempSync/beforeEach) so only this test's calls are asserted on.
    const writeSpy = vi.mocked(fs.writeFileSync);
    const renameSpy = vi.mocked(fs.renameSync);
    writeSpy.mockClear();
    renameSpy.mockClear();

    saveCache(cachePath, cache);

    expect(writeSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();

    const writeTarget = writeSpy.mock.calls[0][0] as string;
    expect(writeTarget).not.toBe(cachePath);

    const renameArgs = renameSpy.mock.calls[0];
    expect(renameArgs[0]).toBe(writeTarget);
    expect(renameArgs[1]).toBe(cachePath);

    expect(writeSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0]);

    // The temp file itself should no longer exist post-rename.
    expect(fs.existsSync(writeTarget)).toBe(false);
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(loadCache(cachePath)).toEqual(cache);
  });

  it("sets file mode 0o600 on the resulting file", () => {
    const cachePath = path.join(tmpDir, "cache.json");
    const cache: PromptHistoryCache = { version: 1, files: {} };

    saveCache(cachePath, cache);

    const stat = fs.statSync(cachePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("isFileUnchanged", () => {
  const now = 1_700_000_000_000;

  it("fast path: returns false immediately when mtime differs, without invoking computeHash", () => {
    const computeHash = vi.fn(() => "hash-a");
    const stat = { mtimeMs: now - 100, size: 100 };
    const cached = { mtimeMs: now - 200, size: 100, contentHash: "hash-a" };

    expect(isFileUnchanged(stat, cached, computeHash, now)).toBe(false);
    expect(computeHash).not.toHaveBeenCalled();
  });

  it("fast path: returns false immediately when size differs, without invoking computeHash", () => {
    const computeHash = vi.fn(() => "hash-a");
    const stat = { mtimeMs: now - 100, size: 101 };
    const cached = { mtimeMs: now - 100, size: 100, contentHash: "hash-a" };

    expect(isFileUnchanged(stat, cached, computeHash, now)).toBe(false);
    expect(computeHash).not.toHaveBeenCalled();
  });

  it("cold path: mtime/size match and file is older than RECENT_WINDOW_MS -> returns true without invoking computeHash", () => {
    expect(RECENT_WINDOW_MS).toBe(5000);

    const computeHash = vi.fn(() => "hash-a");
    const mtimeMs = now - RECENT_WINDOW_MS - 1000;
    const stat = { mtimeMs, size: 100 };
    const cached = { mtimeMs, size: 100, contentHash: "hash-a" };

    expect(isFileUnchanged(stat, cached, computeHash, now)).toBe(true);
    expect(computeHash).not.toHaveBeenCalled();
  });

  it("warm path: recently modified with matching hash -> invokes computeHash and returns true", () => {
    const computeHash = vi.fn(() => "hash-a");
    const mtimeMs = now - (RECENT_WINDOW_MS - 1000);
    const stat = { mtimeMs, size: 100 };
    const cached = { mtimeMs, size: 100, contentHash: "hash-a" };

    expect(isFileUnchanged(stat, cached, computeHash, now)).toBe(true);
    expect(computeHash).toHaveBeenCalledTimes(1);
  });

  it("warm path: recently modified with differing hash -> invokes computeHash and returns false", () => {
    const computeHash = vi.fn(() => "hash-b");
    const mtimeMs = now - (RECENT_WINDOW_MS - 1000);
    const stat = { mtimeMs, size: 100 };
    const cached = { mtimeMs, size: 100, contentHash: "hash-a" };

    expect(isFileUnchanged(stat, cached, computeHash, now)).toBe(false);
    expect(computeHash).toHaveBeenCalledTimes(1);
  });
});

describe("refreshPromptHistory", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-refresh-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("full first-pass extraction returns all extracted prompts sorted descending by timestamp and deduped", () => {
    const workspaceA = path.join(tmpRoot, "--workspace-a--");
    const workspaceB = path.join(tmpRoot, "--workspace-b--");
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    writeJsonlFile(path.join(workspaceA, "session-1.jsonl"), [
      { text: "first prompt", timestampMs: 1000 },
      { text: "second prompt", timestampMs: 3000 },
      { text: "shared prompt", timestampMs: 500 },
    ]);
    writeJsonlFile(path.join(workspaceB, "session-2.jsonl"), [
      { text: "third prompt", timestampMs: 2000 },
      { text: "shared prompt", timestampMs: 4000 },
    ]);

    const emptyCache: PromptHistoryCache = { version: 1, files: {} };
    const { entries } = refreshPromptHistory(tmpRoot, emptyCache);

    // "shared prompt" appears in both files; only the newer (timestampMs 4000)
    // copy should survive, so the total count reflects dedup, not raw count.
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.text)).toEqual([
      "shared prompt",
      "second prompt",
      "third prompt",
      "first prompt",
    ]);
  });

  it("a second call reusing the first call's returned cache does not re-read unchanged file contents", () => {
    const workspaceA = path.join(tmpRoot, "--workspace-a--");
    fs.mkdirSync(workspaceA, { recursive: true });
    writeJsonlFile(path.join(workspaceA, "session-1.jsonl"), [
      { text: "alpha prompt", timestampMs: 1000 },
      { text: "beta prompt", timestampMs: 2000 },
    ]);

    // Inject a `now` far in the future relative to the real mtimes on disk so
    // both calls land on the cold path (mtime older than RECENT_WINDOW_MS),
    // guaranteeing the second call can skip hashing/reading entirely as long
    // as mtime/size are unchanged.
    const injectedNow = Date.now() + 3_600_000;

    // fs is spied module-wide via vi.mock(..., { spy: true }) above; grab the
    // already-installed spy and clear prior call history (e.g. from
    // writeJsonlFile/mkdtempSync above) so only this test's calls are counted.
    const readSpy = vi.mocked(fs.readFileSync);
    readSpy.mockClear();

    const first = refreshPromptHistory(tmpRoot, { version: 1, files: {} }, injectedNow);
    expect(readSpy.mock.calls.length).toBeGreaterThan(0);

    readSpy.mockClear();

    const second = refreshPromptHistory(tmpRoot, first.cache, injectedNow);

    expect(readSpy).not.toHaveBeenCalled();
    expect(second.entries.map((e) => e.text)).toEqual(first.entries.map((e) => e.text));
  });

  it("re-parses a file whose content changed, and its new prompt appears", () => {
    const workspaceA = path.join(tmpRoot, "--workspace-a--");
    fs.mkdirSync(workspaceA, { recursive: true });
    const filePath = path.join(workspaceA, "session-1.jsonl");
    writeJsonlFile(filePath, [{ text: "original prompt", timestampMs: 1000 }]);

    const first = refreshPromptHistory(tmpRoot, { version: 1, files: {} });
    expect(first.entries.map((e) => e.text)).toEqual(["original prompt"]);

    // Appending a line changes the file's size, which alone is enough to
    // trip isFileUnchanged's fast path (mtime/size mismatch) regardless of
    // mtime granularity.
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "appended prompt" }], timestamp: 2000 },
      })}\n`,
    );

    const second = refreshPromptHistory(tmpRoot, first.cache);

    expect(second.entries.map((e) => e.text)).toEqual(["appended prompt", "original prompt"]);
  });

  it("prunes a cache entry for a file deleted from disk since the last refresh", () => {
    const workspaceA = path.join(tmpRoot, "--workspace-a--");
    const workspaceB = path.join(tmpRoot, "--workspace-b--");
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    const keptFile = path.join(workspaceA, "kept.jsonl");
    const deletedFile = path.join(workspaceB, "deleted.jsonl");
    writeJsonlFile(keptFile, [{ text: "kept prompt", timestampMs: 1000 }]);
    writeJsonlFile(deletedFile, [{ text: "doomed prompt", timestampMs: 2000 }]);

    const first = refreshPromptHistory(tmpRoot, { version: 1, files: {} });
    expect(first.entries.map((e) => e.text)).toContain("doomed prompt");

    fs.rmSync(deletedFile);

    const second = refreshPromptHistory(tmpRoot, first.cache);

    expect(second.entries.map((e) => e.text)).not.toContain("doomed prompt");
    expect(second.entries.map((e) => e.text)).toContain("kept prompt");
    expect(Object.keys(second.cache.files).some((key) => key.includes("deleted.jsonl"))).toBe(false);
  });

  it("skips a single file that becomes unreadable mid-scan (readFileSync throws) without aborting the rest of the refresh", async () => {
    const workspaceA = path.join(tmpRoot, "--workspace-a--");
    fs.mkdirSync(workspaceA, { recursive: true });

    const goodFile = path.join(workspaceA, "good.jsonl");
    const badFile = path.join(workspaceA, "bad.jsonl");
    writeJsonlFile(goodFile, [{ text: "good prompt", timestampMs: 1000 }]);
    writeJsonlFile(badFile, [{ text: "bad prompt", timestampMs: 2000 }]);

    // Simulate the file becoming unreadable between statSync and
    // readFileSync (deleted, permission change, EIO, ...) by making the spy
    // throw only for badFile while still forwarding to the real
    // implementation for every other path.
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === badFile) {
        throw new Error("EIO: simulated read failure");
      }
      return actualFs.readFileSync(...args);
    }) as typeof fs.readFileSync);

    expect(() => refreshPromptHistory(tmpRoot, { version: 1, files: {} })).not.toThrow();

    const { entries } = refreshPromptHistory(tmpRoot, { version: 1, files: {} });

    expect(entries.map((e) => e.text)).toContain("good prompt");
    expect(entries.map((e) => e.text)).not.toContain("bad prompt");
  });

  it("caps the display list to the newest 5000 of 5050 deduped/sorted entries, while the per-file manifest retains the excluded ones", () => {
    const FILE_COUNT = 10;
    const PER_FILE = 505;
    const TOTAL = FILE_COUNT * PER_FILE;
    const BASE_TS = 1_700_000_000_000;

    const capWorkspace = path.join(tmpRoot, "--cap-workspace--");
    fs.mkdirSync(capWorkspace, { recursive: true });

    let seq = 1;
    for (let f = 0; f < FILE_COUNT; f++) {
      const prompts: { text: string; timestampMs: number }[] = [];
      for (let i = 0; i < PER_FILE; i++) {
        prompts.push({ text: `prompt-${seq}`, timestampMs: BASE_TS + seq });
        seq++;
      }
      writeJsonlFile(path.join(capWorkspace, `session-${f}.jsonl`), prompts);
    }
    expect(seq - 1).toBe(TOTAL);
    expect(TOTAL).toBe(5050);

    const { entries, cache } = refreshPromptHistory(tmpRoot, { version: 1, files: {} });

    expect(entries).toHaveLength(5000);

    const seqNumbers = entries.map((e) => Number(e.text.replace("prompt-", ""))).sort((a, b) => a - b);
    // Newest 5000 of seq 1..5050 excludes the oldest 50 (seq 1..50).
    expect(seqNumbers[0]).toBe(51);
    expect(seqNumbers[seqNumbers.length - 1]).toBe(5050);

    // The excluded oldest 50 prompts live in session-0.jsonl (seq 1..505).
    // Prove the cap is presentation-only: the manifest entry for that file
    // still retains its full, uncapped prompt list.
    const file0Key = Object.keys(cache.files).find((key) => key.includes("session-0.jsonl"));
    expect(file0Key).toBeDefined();
    expect(cache.files[file0Key as string].prompts).toHaveLength(PER_FILE);
  });
});
