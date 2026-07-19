import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import rulesLoaderInit from "../extensions/rules-loader/index.ts";
import { formatRuleInjection } from "../extensions/rules-loader/format.ts";
import type { ParsedRule } from "../extensions/rules-loader/types.ts";

// ── Directly-callable handler, following the same mockPi capture pattern
// used by hashline-read-tagging.test.ts and bash-guard's extension exports:
// register a fake `pi` whose `.on()` just stashes the handler so it can be
// invoked directly in tests instead of only through a real ExtensionAPI. ──

let toolResultHandler: ((event: any, ctx: any) => Promise<any> | any) | null = null;

const mockPi = {
  on(event: string, handler: any) {
    if (event === "tool_result") toolResultHandler = handler;
  },
  registerFlag() {
    return undefined;
  },
  registerCommand() {
    return undefined;
  },
};

rulesLoaderInit(mockPi as any);

// ── Fixture helpers ──────────────────────────────────────────────────────
// Project rules live at <projectRoot>/.pi/rules/*.md — pi's own project-local
// config convention (CONFIG_DIR_NAME), not Claude Code's `.claude/rules/*.md`
// (the global equivalent, ~/.pi/agent/rules, does not exist on this test
// machine, so it never contributes fixture rules here).

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length) {
    const dir = tmpRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-loader-injection-test-"));
  tmpRoots.push(dir);
  fs.mkdirSync(path.join(dir, ".pi", "rules"), { recursive: true });
  return dir;
}

function writeProjectRule(
  projectRoot: string,
  filename: string,
  id: string,
  paths: string[],
  body: string,
): void {
  const pathsYaml = paths.map((p) => `  - ${JSON.stringify(p)}`).join("\n");
  const content = `---\nid: ${JSON.stringify(id)}\npaths:\n${pathsYaml}\n---\n${body}\n`;
  fs.writeFileSync(path.join(projectRoot, ".pi", "rules", filename), content, "utf8");
}

let sessionCounter = 0;
function freshSessionId(): string {
  sessionCounter += 1;
  return `rules-loader-injection-session-${sessionCounter}`;
}

function makeCtx(cwd: string, sessionId: string) {
  return { cwd, sessionId };
}

function makeReadEvent(filePath: string, text = "original file body", isError = false) {
  return {
    toolName: "read",
    input: { path: filePath },
    content: [{ type: "text", text }],
    isError,
  };
}

// No emoji anywhere in an injected block — covers the common pictographic /
// symbol / dingbat / arrow ranges used for "banner" style emoji.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const DIRECTIVE_HEADING_RE = /required while working with this file/i;

// ── First read on a matching file: additive, original items unchanged/first ──

describe("rules-loader tool_result handler — first touch on a matching file", () => {
  it("appends one block after the original content items, leaving them unchanged and first", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const event = makeReadEvent(filePath);
    const result = await toolResultHandler?.(event, makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual(event.content[0]);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
    expect(result.content[1].text).toContain("Follow strict conventions.");
  });

  it("discloses the rule's provenance (source: project, plus its file path) in the injected text", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const result = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    const injectedText = result.content[1].text as string;
    expect(injectedText).toContain("Source: project");
    expect(injectedText).toContain(path.join(projectRoot, ".pi", "rules", "my-rule.md"));
  });

  it("does not include emoji banner phrasing in the appended block", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const result = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    const injectedText = result.content[1].text as string;
    expect(EMOJI_RE.test(injectedText)).toBe(false);
  });
});

// ── Dedup: same rule + same file, twice in one session → only first injects ──

describe("rules-loader tool_result handler — dedup per (rule, file) within a session", () => {
  it("injects only on the first of two touches of the same file by the same session", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();
    const ctx = makeCtx(projectRoot, session);

    const first = await toolResultHandler?.(makeReadEvent(filePath), ctx);
    expect(first).toBeDefined();
    expect(first.content).toHaveLength(2);

    const second = await toolResultHandler?.(makeReadEvent(filePath), ctx);
    expect(second).toBeUndefined();
  });

  it("injects on both when the same rule matches two different files in one session", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const fileA = path.join(projectRoot, "target.ts");
    const fileB = path.join(projectRoot, "nested", "target.ts");
    const session = freshSessionId();
    const ctx = makeCtx(projectRoot, session);

    const resultA = await toolResultHandler?.(makeReadEvent(fileA), ctx);
    const resultB = await toolResultHandler?.(makeReadEvent(fileB), ctx);

    expect(resultA).toBeDefined();
    expect(resultA.content).toHaveLength(2);
    expect(resultB).toBeDefined();
    expect(resultB.content).toHaveLength(2);
  });
});

// ── Regression: non-**-prefixed pattern (README's own src/api/**/*.ts
// example) must match an absolute touched-file path once index.ts converts
// it to project-relative before calling matchesAnyPattern. Before the fix,
// picomatch's default anchoring meant this pattern style never matched the
// absolute path the tool_result handler actually receives — a silent
// failure of the feature's primary documented use case that the pre-fix
// suite didn't catch because every fixture rule here used a **-prefixed
// pattern, which happens to still match an absolute path regardless. ──

describe("rules-loader tool_result handler — non-**-prefixed glob (README's src/api/**/*.ts example)", () => {
  it("injects when an absolute path under src/api/ is touched", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(
      projectRoot,
      "api-rule.md",
      "api-rule",
      ["src/api/**/*.ts"],
      "All API route handlers must return errors via the shared ApiError type.",
    );
    fs.mkdirSync(path.join(projectRoot, "src", "api"), { recursive: true });
    const filePath = path.join(projectRoot, "src", "api", "users.ts");
    const session = freshSessionId();

    const result = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
    expect(result.content[1].text).toContain("ApiError");
  });

  it("does not inject when the absolute path is outside src/api/", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "api-rule.md", "api-rule", ["src/api/**/*.ts"], "API-only guidance.");
    fs.mkdirSync(path.join(projectRoot, "src", "web"), { recursive: true });
    const filePath = path.join(projectRoot, "src", "web", "users.ts");
    const session = freshSessionId();

    const result = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, session));

    expect(result).toBeUndefined();
  });
});

// ── write/edit tool_results also trigger injection, not just read ─────────
//
// `edit`'s tool input shape (registered by the sibling `hashline` extension,
// see `extensions/hashline/index.ts`) is `{ input: string }` — a
// hashline-formatted string carrying one or more `¶path#tag` header lines —
// NOT the plain `{ path: string }` shape `read`/`write` use. These fixtures
// use that realistic shape deliberately: an earlier `{ path: filePath }`
// edit fixture here made `extractToolPath` look like it worked for `edit`
// when in production it always returned `undefined`, silently disabling
// injection on every real edit call. See `agent/extensions/hashline/index.ts:227-233`
// and `agent/extensions/hashline/path-utils.ts:36-53` for the format this mirrors.

function makeEditEvent(headerLines: Array<{ filePath: string; tag?: string }>, resultText = "Edited file."): {
  toolName: string;
  input: { input: string };
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  const body = headerLines
    .map(({ filePath, tag = "abcd" }) => `¶${filePath}#${tag}\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE`)
    .join("\n");
  return {
    toolName: "edit",
    input: { input: body },
    content: [{ type: "text", text: resultText }],
    isError: false,
  };
}

describe("rules-loader tool_result handler — write and edit tool names also trigger injection", () => {
  it("injects on a write tool_result for a matching file", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const event = {
      toolName: "write",
      input: { path: filePath },
      content: [{ type: "text", text: "Wrote file." }],
      isError: false,
    };
    const result = await toolResultHandler?.(event, makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
  });

  it("injects on an edit tool_result (realistic hashline-formatted input) for a matching file", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const event = makeEditEvent([{ filePath }]);
    const result = await toolResultHandler?.(event, makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
  });

  it("injects only for the matching file when an edit input touches two different files and a rule matches just one", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const matchingFile = path.join(projectRoot, "target.ts");
    const otherFile = path.join(projectRoot, "unrelated.txt");
    const session = freshSessionId();

    const event = makeEditEvent([{ filePath: matchingFile, tag: "aaaa" }, { filePath: otherFile, tag: "bbbb" }]);
    const result = await toolResultHandler?.(event, makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
    expect(result.content[1].text).toContain("Follow strict conventions.");
  });

  it("injects for both files when an edit input touches two different files that both match the same rule (multi-path dedup)", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const fileA = path.join(projectRoot, "target.ts");
    const fileB = path.join(projectRoot, "nested", "target.ts");
    fs.mkdirSync(path.join(projectRoot, "nested"), { recursive: true });
    const session = freshSessionId();

    const event = makeEditEvent([{ filePath: fileA, tag: "aaaa" }, { filePath: fileB, tag: "bbbb" }]);
    const result = await toolResultHandler?.(event, makeCtx(projectRoot, session));

    expect(result).toBeDefined();
    // One appended block per matched (rule, file) pair on top of the original content item.
    expect(result.content).toHaveLength(3);
    expect(result.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
    expect(result.content[2].text).toMatch(DIRECTIVE_HEADING_RE);

    // Re-touching either file in the same session must not re-inject (dedup still holds per path).
    const repeat = await toolResultHandler?.(makeEditEvent([{ filePath: fileA, tag: "cccc" }]), makeCtx(projectRoot, session));
    expect(repeat).toBeUndefined();
  });
});

// ── isError: true → no injection, even on first touch ─────────────────────

describe("rules-loader tool_result handler — errored tool calls never inject", () => {
  it("returns undefined for a matching file when isError is true", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const result = await toolResultHandler?.(
      makeReadEvent(filePath, "irrelevant", true),
      makeCtx(projectRoot, session),
    );

    expect(result).toBeUndefined();
  });
});

// ── Non-matching file path → no injection ──────────────────────────────

describe("rules-loader tool_result handler — non-matching file path", () => {
  it("returns undefined when no rule's paths match the touched file", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "unrelated.txt");
    const session = freshSessionId();

    const result = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, session));

    expect(result).toBeUndefined();
  });
});

// ── Order-independence: additive-only-mutation safety contract ───────────
// Simulates a second, unrelated tool_result handler that mimics hashline's
// own mutation shape (prepending a tag to the first content block), running
// either before or after rules-loader's handler in a chain. In both
// orderings, rules-loader's appended block must be present AND the stub's
// earlier mutation must be preserved — nothing dropped or reordered.

function stubPrependTag(content: Array<{ type: string; text: string }>) {
  const [first, ...rest] = content;
  return [{ ...first, text: `¶stub-tag\n${first.text}` }, ...rest];
}

describe("rules-loader tool_result handler — order-independence with another content-mutating handler", () => {
  it("preserves an earlier handler's mutation when the stub runs BEFORE rules-loader", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const rawEvent = makeReadEvent(filePath);
    const afterStub = { ...rawEvent, content: stubPrependTag(rawEvent.content) };

    const finalResult = await toolResultHandler?.(afterStub, makeCtx(projectRoot, session));

    expect(finalResult).toBeDefined();
    expect(finalResult.content).toHaveLength(2);
    expect(finalResult.content[0].text).toBe("¶stub-tag\noriginal file body");
    expect(finalResult.content[1].text).toMatch(DIRECTIVE_HEADING_RE);
  });

  it("preserves rules-loader's own appended block when the stub runs AFTER rules-loader", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const session = freshSessionId();

    const rawEvent = makeReadEvent(filePath);
    const rlResult = await toolResultHandler?.(rawEvent, makeCtx(projectRoot, session));

    expect(rlResult).toBeDefined();
    expect(rlResult.content).toHaveLength(2);
    const injectedText = rlResult.content[1].text;

    const afterStub = stubPrependTag(rlResult.content);

    expect(afterStub).toHaveLength(2);
    expect(afterStub[0].text).toBe("¶stub-tag\noriginal file body");
    expect(afterStub[1].text).toBe(injectedText);
    expect(afterStub[1].text).toMatch(DIRECTIVE_HEADING_RE);
  });
});

// ── A fresh session id does not inherit dedup state from a prior session ──

describe("rules-loader tool_result handler — dedup is per-session, not global", () => {
  it("injects again for the same rule+file combo under a brand-new session id", async () => {
    const projectRoot = makeProjectRoot();
    writeProjectRule(projectRoot, "my-rule.md", "my-rule", ["**/target.ts"], "Follow strict conventions.");
    const filePath = path.join(projectRoot, "target.ts");
    const sessionOne = freshSessionId();
    const sessionTwo = freshSessionId();

    const firstSessionResult = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, sessionOne));
    expect(firstSessionResult).toBeDefined();
    expect(firstSessionResult.content).toHaveLength(2);

    const secondSessionResult = await toolResultHandler?.(makeReadEvent(filePath), makeCtx(projectRoot, sessionTwo));
    expect(secondSessionResult).toBeDefined();
    expect(secondSessionResult.content).toHaveLength(2);
  });
});

// ── formatRuleInjection — direct unit tests ────────────────────────────

describe("formatRuleInjection", () => {
  it("builds a directive-framed block with the rule id, a required-while-working heading, and the rule body", () => {
    const rule: ParsedRule = {
      id: "my-rule",
      paths: ["**/target.ts"],
      body: "Follow strict conventions.",
      origin: "project",
      filePath: "/tmp/project/.pi/rules/my-rule.md",
    };

    const text = formatRuleInjection(rule, "/tmp/project/target.ts");

    expect(text).toContain("my-rule");
    expect(text).toMatch(DIRECTIVE_HEADING_RE);
    expect(text).toContain("Follow strict conventions.");
    expect(EMOJI_RE.test(text)).toBe(false);
  });

  it("discloses the rule's origin and source file path — global", () => {
    const rule: ParsedRule = {
      id: "global-rule",
      paths: ["**/*.ts"],
      body: "Global guidance.",
      origin: "global",
      filePath: "/home/user/.pi/agent/rules/global-rule.md",
    };

    const text = formatRuleInjection(rule, "/tmp/project/target.ts");

    expect(text).toContain("Global rule");
    expect(text).toContain("Source: global");
    expect(text).toContain("/home/user/.pi/agent/rules/global-rule.md");
  });

  it("discloses the rule's origin and source file path — project", () => {
    const rule: ParsedRule = {
      id: "project-rule",
      paths: ["**/*.ts"],
      body: "Project guidance.",
      origin: "project",
      filePath: "/tmp/project/.pi/rules/project-rule.md",
    };

    const text = formatRuleInjection(rule, "/tmp/project/target.ts");

    expect(text).toContain("Project rule");
    expect(text).toContain("Source: project");
    expect(text).toContain("/tmp/project/.pi/rules/project-rule.md");
  });
});
