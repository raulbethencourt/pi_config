import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RULE_BODY_BYTES } from "../extensions/rules-loader/loader.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRules } from "../extensions/rules-loader/loader.ts";
import type { ParsedRule } from "../extensions/rules-loader/types.ts";

// ── Test fixture helpers ────────────────────────────────────────────────
// Mirrors the mkdtempSync/afterEach cleanup pattern used in
// bash-guard-protected-paths.test.ts. Real temp directories with real .md
// files are used throughout — no mocks.

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length) {
    const dir = tmpRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-loader-loading-test-"));
  tmpRoots.push(dir);
  return dir;
}

function frontmatterYaml(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  return lines.join("\n");
}

function writeRuleFile(
  dir: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): void {
  const content = `---\n${frontmatterYaml(frontmatter)}\n---\n${body}\n`;
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

function writeRuleFileRaw(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

// ── loadRules — union of global + project rules with different basenames ──

describe("loadRules — global + project rules with different basenames", () => {
  it("loads both, forming a union, deriving ids from filenames when no id field is present", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFile(globalDir, "global-only.md", { paths: ["global/**"] }, "Global rule body.");
    writeRuleFile(projectDir, "project-only.md", { paths: ["project/**"] }, "Project rule body.");

    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(2);
    const ids = rules.map((r) => r.id).sort();
    expect(ids).toEqual(["global-only", "project-only"]);
  });
});

// ── loadRules — same basename in both dirs: project wins, no double-load ──

describe("loadRules — global + project rules sharing a basename", () => {
  it("uses only the project version's body/paths, not both", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFile(globalDir, "shared.md", { paths: ["global/**"] }, "GLOBAL VERSION BODY");
    writeRuleFile(projectDir, "shared.md", { paths: ["project/**"] }, "PROJECT VERSION BODY");

    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("shared");
    expect(rules[0].body).toContain("PROJECT VERSION BODY");
    expect(rules[0].body).not.toContain("GLOBAL VERSION BODY");
    expect(rules[0].paths).toEqual(["project/**"]);
  });
});

// ── loadRules — uncompilable glob pattern: skipped, non-fatal ─────────────
// A pattern exceeding picomatch's own MAX_LENGTH (65536 chars) throws when
// picomatch tries to compile it — a deterministic, reproducible way to
// trigger the "uncompilable glob pattern" skip path without relying on
// picomatch's otherwise very lenient glob-syntax tolerance.

describe("loadRules — uncompilable glob pattern in paths", () => {
  it("does not throw, logs via console.error, and still loads the rest of the directory", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    const uncompilablePattern = "x".repeat(70_000);
    writeRuleFile(globalDir, "bad-glob.md", { paths: [uncompilablePattern] }, "Bad rule body.");
    writeRuleFile(globalDir, "good-glob.md", { paths: ["ok/**"] }, "Good rule body.");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rules: ParsedRule[] = [];

    expect(() => {
      rules = loadRules({ globalDir, projectDir });
    }).not.toThrow();

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("good-glob");
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

// ── loadRules — no rule files in either directory ──────────────────────

describe("loadRules — no rule files present", () => {
  it("returns an empty array without erroring", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    expect(() => loadRules({ globalDir, projectDir })).not.toThrow();
    expect(loadRules({ globalDir, projectDir })).toEqual([]);
  });
});

// ── loadRules — file with no frontmatter block at all: silently skipped ──
// Regression test for the bundled agent/rules/README.md noise bug: a plain
// markdown file with no `---` frontmatter block isn't attempting to be a
// rule, so it must be skipped without a console.error warning — unlike a
// file that has a frontmatter block but an invalid/missing `paths` field.

describe("loadRules — file with no frontmatter block is silently skipped", () => {
  it("skips a plain markdown file with no frontmatter block, without logging", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFileRaw(globalDir, "README.md", "# Just a README\n\nNo frontmatter here.\n");
    writeRuleFile(globalDir, "valid.md", { id: "valid", paths: ["ok/**"] }, "Valid body.");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("valid");
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("loads the real bundled agent/rules/README.md without triggering console.error", () => {
    const globalDir = path.resolve(__dirname, "../rules");
    const projectDir = makeTmpDir();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = loadRules({ globalDir, projectDir });

    expect(rules.some((r) => r.id === "README")).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

// ── loadRules — syntactically invalid YAML frontmatter: skipped, non-fatal ──
// Regression test: a rule file whose frontmatter block exists but fails to
// parse as YAML must not throw uncaught out of loadRules — that would blow
// away getRulesForCwd's whole-directory cache for one author typo. Skip only
// the bad file, log via console.error, and still load the valid sibling.

describe("loadRules — syntactically invalid YAML frontmatter is skipped, non-fatal", () => {
  it("does not throw, logs via console.error, and still loads the valid sibling rule", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFileRaw(
      projectDir,
      "bad-yaml.md",
      `---\npaths: [unclosed\n---\nBody with broken frontmatter.\n`,
    );
    writeRuleFile(projectDir, "valid.md", { id: "valid", paths: ["ok/**"] }, "Valid body.");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rules: ParsedRule[] = [];

    expect(() => {
      rules = loadRules({ globalDir, projectDir });
    }).not.toThrow();

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("valid");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad-yaml.md"));

    errorSpy.mockRestore();
  });
});

// ── loadRules — unreadable rule file (permission error): skipped, non-fatal ──
// Regression test: `parseRuleFile`'s `fs.readFileSync` call was previously
// unwrapped, unlike the adjacent YAML-parse and glob-compile steps in the
// same function, which already follow a "catch, console.error naming the
// file, skip only that file, keep loading the rest of the directory"
// pattern. A permission error (or a file removed between listing and
// reading) must not throw uncaught — it must be treated the same as those
// other two non-fatal skip conditions. Skipped when running as root, since
// root bypasses file permission checks and the chmod-based repro wouldn't
// force a real read failure in that case.

describe("loadRules — unreadable rule file is skipped, non-fatal", () => {
  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
    "does not throw, logs via console.error, and still loads the valid sibling rule",
    () => {
      const globalDir = makeTmpDir();
      const projectDir = makeTmpDir();

      writeRuleFile(globalDir, "unreadable.md", { paths: ["ok/**"] }, "Body.");
      fs.chmodSync(path.join(globalDir, "unreadable.md"), 0o000);
      writeRuleFile(globalDir, "valid.md", { id: "valid", paths: ["ok/**"] }, "Valid body.");

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let rules: ParsedRule[] = [];

      expect(() => {
        rules = loadRules({ globalDir, projectDir });
      }).not.toThrow();

      expect(rules).toHaveLength(1);
      expect(rules[0].id).toBe("valid");
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unreadable.md"));

      errorSpy.mockRestore();
    },
  );
});

// ── loadRules — oversized rule body is truncated, not injected verbatim ──

describe("loadRules — rule body exceeding the size cap is truncated, non-fatal", () => {
  it("truncates the body to MAX_RULE_BODY_BYTES and logs via console.error", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    const oversizedBody = "x".repeat(MAX_RULE_BODY_BYTES + 1024);
    writeRuleFile(globalDir, "oversized.md", { id: "oversized", paths: ["ok/**"] }, oversizedBody);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(1);
    expect(Buffer.byteLength(rules[0].body, "utf8")).toBeLessThanOrEqual(MAX_RULE_BODY_BYTES);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("oversized.md"));

    errorSpy.mockRestore();
  });

  it("does not truncate or warn for a body under the cap", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFile(globalDir, "small.md", { id: "small", paths: ["ok/**"] }, "Short body.");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = loadRules({ globalDir, projectDir });

    expect(rules[0].body).toContain("Short body.");
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

// ── loadRules — origin is recorded per source directory ─────────────────

describe("loadRules — origin (global vs project) is recorded on each rule", () => {
  it("tags a rule loaded from globalDir with origin \"global\" and one from projectDir with \"project\"", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFile(globalDir, "global-only.md", { paths: ["global/**"] }, "Global rule body.");
    writeRuleFile(projectDir, "project-only.md", { paths: ["project/**"] }, "Project rule body.");

    const rules = loadRules({ globalDir, projectDir });
    const byId = new Map(rules.map((r) => [r.id, r]));

    expect(byId.get("global-only")?.origin).toBe("global");
    expect(byId.get("global-only")?.filePath).toBe(path.join(globalDir, "global-only.md"));
    expect(byId.get("project-only")?.origin).toBe("project");
    expect(byId.get("project-only")?.filePath).toBe(path.join(projectDir, "project-only.md"));
  });

  it("tags a same-basename rule with origin \"project\" when the project version wins", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFile(globalDir, "shared.md", { paths: ["global/**"] }, "GLOBAL VERSION BODY");
    writeRuleFile(projectDir, "shared.md", { paths: ["project/**"] }, "PROJECT VERSION BODY");

    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(1);
    expect(rules[0].origin).toBe("project");
  });
});

// ── loadRules — missing/invalid paths field: skipped, non-fatal ────────

describe("loadRules — invalid paths field is skipped, non-fatal", () => {
  it("skips a rule file with no paths field, an empty paths array, and a non-array paths value", () => {
    const globalDir = makeTmpDir();
    const projectDir = makeTmpDir();

    writeRuleFileRaw(
      projectDir,
      "no-paths.md",
      `---\nid: "no-paths"\n---\nBody without a paths field.\n`,
    );
    writeRuleFile(projectDir, "empty-paths.md", { id: "empty-paths", paths: [] }, "Body with empty paths.");
    writeRuleFileRaw(
      projectDir,
      "non-array-paths.md",
      `---\nid: "non-array-paths"\npaths: "not-an-array"\n---\nBody with non-array paths.\n`,
    );
    writeRuleFile(projectDir, "valid.md", { id: "valid", paths: ["ok/**"] }, "Valid body.");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rules = loadRules({ globalDir, projectDir });

    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("valid");
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
