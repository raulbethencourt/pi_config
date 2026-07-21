import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isProtectedPath,
  isProtectedWriteOnlyPath,
  isReadOnlyBashCommand,
  commandReferencesPath,
  findBlockedProtectedFolderReference,
  PROTECTED_PATH_PATTERNS,
  extractSubstitutionSpans,
} from "../extensions/bash-guard/index.ts";

const HOME = process.env.HOME || "/home/rabeta";

// ── isProtectedPath (extended PROTECTED_FOLDERS array) ─────────────────

describe("isProtectedPath — new credential entries", () => {
  it("blocks the pi agent auth.json credential file", () => {
    expect(isProtectedPath(`${HOME}/.pi/agent/auth.json`)).toBe(true);
  });
  it("blocks ~/.npmrc", () => {
    expect(isProtectedPath(`${HOME}/.npmrc`)).toBe(true);
  });
});

describe("isProtectedPath — no regression on existing entries", () => {
  it("still blocks ~/.ssh", () => {
    expect(isProtectedPath(`${HOME}/.ssh`)).toBe(true);
    expect(isProtectedPath(`${HOME}/.ssh/id_rsa`)).toBe(true);
  });
  it("still blocks ~/personal", () => {
    expect(isProtectedPath(`${HOME}/personal`)).toBe(true);
    expect(isProtectedPath(`${HOME}/personal/notes.txt`)).toBe(true);
  });
  it("still blocks ~/secure", () => {
    expect(isProtectedPath(`${HOME}/secure`)).toBe(true);
    expect(isProtectedPath(`${HOME}/secure/vault.gpg`)).toBe(true);
  });
  it("still blocks ~/Documents", () => {
    expect(isProtectedPath(`${HOME}/Documents`)).toBe(true);
    expect(isProtectedPath(`${HOME}/Documents/report.pdf`)).toBe(true);
  });
});

// ── isProtectedPath — symlink resolution (Finding 1 + Finding 2 fix) ───
// isProtectedPath gates the fully-blocked tier (credentials, ~/.ssh, etc.),
// so it must resolve symlinks the same way isProtectedWriteOnlyPath does —
// otherwise a symlink at an arbitrary path pointing at a protected file
// would bypass the literal string comparison entirely.

describe("isProtectedPath — symlink resolution", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length) {
      const dir = tmpRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-guard-symlink-test-"));
    tmpRoots.push(dir);
    return dir;
  }

  it("detects a symlink pointing at agent/auth.json as protected via isProtectedPath itself", () => {
    const root = makeTmpDir();
    const symlinkPath = path.join(root, "link-to-auth-json");
    fs.symlinkSync(`${HOME}/.pi/agent/auth.json`, symlinkPath);

    expect(isProtectedPath(symlinkPath)).toBe(true);
  });

  it("resolves a symlink whose target inside a PROTECTED_FOLDERS directory does not exist yet, and still flags it as protected", () => {
    // This is exactly the realistic "plant a new file through a fresh
    // symlink" case: the symlink's declared target itself doesn't exist,
    // so fs.realpathSync fails on `current` on the very first iteration
    // (not on a later, already-walked-up ancestor) — the function must
    // follow the symlink's own readlink target rather than falling back to
    // the symlink's own location.
    const root = makeTmpDir();
    const symlinkPath = path.join(root, "link-to-not-yet-existing-ssh-file");
    fs.symlinkSync(`${HOME}/.ssh/does-not-exist-guard-test`, symlinkPath);

    expect(() => isProtectedPath(symlinkPath)).not.toThrow();
    expect(isProtectedPath(symlinkPath)).toBe(true);
  });
});

describe("isProtectedPath — pi's own live source tree stays editable", () => {
  it("does not block agent/mcp.json", () => {
    expect(isProtectedPath("agent/mcp.json")).toBe(false);
  });
  it("does not block agent/settings.json", () => {
    expect(isProtectedPath("agent/settings.json")).toBe(false);
  });
  it("does not block paths under agent/extensions/", () => {
    expect(isProtectedPath("agent/extensions/bash-guard/index.ts")).toBe(false);
    expect(isProtectedPath("agent/extensions/powerline.ts")).toBe(false);
  });
});

// ── isProtectedWriteOnlyPath (rc files + repo-relative git patterns) ───

describe("isProtectedWriteOnlyPath — shell rc files at $HOME root", () => {
  it("blocks ~/.bashrc", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.bashrc`)).toBe(true);
  });
  it("blocks ~/.zshrc", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.zshrc`)).toBe(true);
  });
  it("blocks ~/.bash_profile", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.bash_profile`)).toBe(true);
  });
  it("blocks ~/.zprofile", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.zprofile`)).toBe(true);
  });
  it("blocks ~/.profile", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.profile`)).toBe(true);
  });
});

describe("isProtectedWriteOnlyPath — must not over-match similarly named paths", () => {
  it("does not block a same-named rc file nested inside a project directory", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/some-project/.bashrc`)).toBe(false);
  });
  it("does not block ~/.bash_history (similar-looking but distinct filename)", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.bash_history`)).toBe(false);
  });
});

describe("isProtectedWriteOnlyPath — .git/hooks pattern (repo-relative)", () => {
  it("blocks a relative .git/hooks/pre-commit path", () => {
    expect(isProtectedWriteOnlyPath(".git/hooks/pre-commit")).toBe(true);
  });
  it("blocks .git/hooks anchored under an arbitrary absolute repo path", () => {
    expect(isProtectedWriteOnlyPath("/home/rabeta/some/repo/.git/hooks/pre-commit")).toBe(true);
  });
  it("does not block unrelated .github/ paths", () => {
    expect(isProtectedWriteOnlyPath(".github/workflows/ci.yml")).toBe(false);
  });
});

describe("isProtectedWriteOnlyPath — .git/config pattern (repo-relative)", () => {
  it("blocks a bare .git/config", () => {
    expect(isProtectedWriteOnlyPath(".git/config")).toBe(true);
  });
  it("blocks .git/config.lock", () => {
    expect(isProtectedWriteOnlyPath(".git/config.lock")).toBe(true);
  });
  it("does not block .gitconfig", () => {
    expect(isProtectedWriteOnlyPath(".gitconfig")).toBe(false);
  });
  it("does not block .gitignore", () => {
    expect(isProtectedWriteOnlyPath(".gitignore")).toBe(false);
  });
  it("does not block .git/configuration.yml", () => {
    expect(isProtectedWriteOnlyPath(".git/configuration.yml")).toBe(false);
  });
});

// ── isProtectedWriteOnlyPath — symlink resolution ──────────────────────
// A symlink pointing at a protected path must be caught once resolved, since
// only checking the literal argument string would let an agent create a
// symlink at an arbitrary location and write "through" it.

describe("isProtectedWriteOnlyPath — symlink resolution", () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    while (tmpRoots.length) {
      const dir = tmpRoots.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-guard-symlink-test-"));
    tmpRoots.push(dir);
    return dir;
  }

  it("detects a symlink pointing at a protected .git/hooks directory", () => {
    const root = makeTmpDir();
    const realHooksDir = path.join(root, "real-repo", ".git", "hooks");
    fs.mkdirSync(realHooksDir, { recursive: true });
    const symlinkPath = path.join(root, "link-to-hooks");
    fs.symlinkSync(realHooksDir, symlinkPath);

    expect(isProtectedWriteOnlyPath(path.join(symlinkPath, "pre-commit"))).toBe(true);
  });

  it("detects a symlink pointing at a protected .git/config file", () => {
    const root = makeTmpDir();
    const realGitDir = path.join(root, "real-repo", ".git");
    fs.mkdirSync(realGitDir, { recursive: true });
    const realConfigFile = path.join(realGitDir, "config");
    fs.writeFileSync(realConfigFile, "");
    const symlinkPath = path.join(root, "link-to-config");
    fs.symlinkSync(realConfigFile, symlinkPath);

    expect(isProtectedWriteOnlyPath(symlinkPath)).toBe(true);
  });

  it("does not crash on a symlink pointing at a non-existent target, and treats it as unprotected", () => {
    const root = makeTmpDir();
    const symlinkPath = path.join(root, "dangling-link");
    fs.symlinkSync(path.join(root, "does-not-exist"), symlinkPath);

    expect(() => isProtectedWriteOnlyPath(symlinkPath)).not.toThrow();
    expect(isProtectedWriteOnlyPath(symlinkPath)).toBe(false);
  });

  it("does not crash on a plain new-file path that isn't a symlink at all", () => {
    const root = makeTmpDir();
    const newFilePath = path.join(root, "brand-new-file.txt");

    expect(() => isProtectedWriteOnlyPath(newFilePath)).not.toThrow();
    expect(isProtectedWriteOnlyPath(newFilePath)).toBe(false);
  });

  it("still resolves a new (not-yet-created) file inside a symlinked protected hooks dir", () => {
    const root = makeTmpDir();
    const realHooksDir = path.join(root, "real-repo", ".git", "hooks");
    fs.mkdirSync(realHooksDir, { recursive: true });
    const symlinkPath = path.join(root, "link-to-hooks-2");
    fs.symlinkSync(realHooksDir, symlinkPath);
    const notYetCreatedFile = path.join(symlinkPath, "new-hook-that-does-not-exist-yet");

    expect(() => isProtectedWriteOnlyPath(notYetCreatedFile)).not.toThrow();
    expect(isProtectedWriteOnlyPath(notYetCreatedFile)).toBe(true);
  });

  it("resolves a symlink whose declared target (a not-yet-existing .git/hooks file) doesn't exist at all, rather than falling back to the symlink's own path", () => {
    // Core bug-fix case: the symlink itself is the thing pointing directly
    // at a target that has never been created (e.g. a real "post-checkout"
    // hook, as opposed to the "post-checkout.sample" that ships by default).
    // fs.realpathSync throws ENOENT on the very first attempt here — there
    // is no already-resolved ancestor to fall back on — so the fix must
    // read the symlink's own target via fs.readlinkSync and continue
    // resolving from there, not silently return the symlink's own location.
    const root = makeTmpDir();
    const realHooksDir = path.join(root, "real-repo3", ".git", "hooks");
    fs.mkdirSync(realHooksDir, { recursive: true });
    const notYetExistingTarget = path.join(realHooksDir, "post-checkout");
    const symlinkPath = path.join(root, "fresh-link-to-new-hook");
    fs.symlinkSync(notYetExistingTarget, symlinkPath);

    expect(() => isProtectedWriteOnlyPath(symlinkPath)).not.toThrow();
    expect(isProtectedWriteOnlyPath(symlinkPath)).toBe(true);
  });
});

// ── isProtectedWriteOnlyPath — global git config ────────────────────────

describe("isProtectedWriteOnlyPath — ~/.gitconfig (global git config)", () => {
  it("blocks ~/.gitconfig", () => {
    expect(isProtectedWriteOnlyPath(`${HOME}/.gitconfig`)).toBe(true);
  });
});

// ── isProtectedWriteOnlyPath — case-insensitive matching ────────────────
// Case-insensitive filesystems (macOS default, Windows) mean a differently
// cased path must still be recognized as protected.

describe("isProtectedWriteOnlyPath — case-insensitive .git/hooks and .git/config", () => {
  it("blocks a case-varied .git/hooks path (.GIT/hooks)", () => {
    expect(isProtectedWriteOnlyPath(".GIT/hooks/pre-commit")).toBe(true);
  });
  it("blocks a case-varied .git/hooks path (.git/Hooks)", () => {
    expect(isProtectedWriteOnlyPath(".git/Hooks/pre-commit")).toBe(true);
  });
  it("blocks a case-varied .git/config path (.git/Config)", () => {
    expect(isProtectedWriteOnlyPath(".git/Config")).toBe(true);
  });
});

// ── PROTECTED_PATH_PATTERNS — matched directly against raw bash command
// strings, not just resolved file-path arguments ──────────────────────
// index.ts applies these same regex objects two ways: against a resolved
// path (Write/Edit tool calls) AND directly via `pattern.test(command)`
// against the raw bash command string (bash tool calls). The old
// `(^|\/)` leading anchor only worked for the first case — a raw command
// like `echo payload > .git/hooks/pre-commit` has a space (not `/` or
// start-of-string) immediately before `.git`, so the block silently never
// fired for this extremely common relative-path-after-redirect shape.

describe("PROTECTED_PATH_PATTERNS — regression: matches raw bash command strings", () => {
  it("detects .git/hooks preceded by a space after a shell redirect (echo payload > .git/hooks/pre-commit)", () => {
    const command = "echo payload > .git/hooks/pre-commit";
    expect(PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(command))).toBe(true);
  });

  it("detects .git/hooks preceded by a space with no redirect (chmod +x .git/hooks/post-checkout)", () => {
    const command = "chmod +x .git/hooks/post-checkout";
    expect(PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(command))).toBe(true);
  });

  it("detects .git/config preceded by a space after a shell redirect (echo malicious >> .git/config)", () => {
    const command = "echo malicious >> .git/config";
    expect(PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(command))).toBe(true);
  });

  it("still does not match .gitconfig, .gitignore, .github/, or .git/configuration.yml in raw command form", () => {
    expect(PROTECTED_PATH_PATTERNS.some((p) => p.test("echo hi > .gitconfig"))).toBe(false);
    expect(PROTECTED_PATH_PATTERNS.some((p) => p.test("cat .gitignore"))).toBe(false);
    expect(PROTECTED_PATH_PATTERNS.some((p) => p.test("cat .github/workflows/ci.yml"))).toBe(false);
    expect(PROTECTED_PATH_PATTERNS.some((p) => p.test("cat .git/configuration.yml"))).toBe(false);
  });

  it("does not match .git/hooks when .git is a suffix of an unrelated identifier (e.g. a bare repo named myrepo.git)", () => {
    expect(PROTECTED_PATH_PATTERNS.some((p) => p.test("ls myrepo.git/hooks"))).toBe(false);
  });
});

// ── findBlockedProtectedFolderReference — bash-layer read-only exemption
// must NOT apply to the credential-file entries (agent/auth.json, ~/.npmrc),
// but must still apply to the pre-existing directory entries (~/.ssh, etc.).
// Regression coverage for the bug where `!isReadOnlyBashCommand(command)` was
// applied blanket across all of PROTECTED_FOLDERS, letting a plain
// `cat ~/.pi/agent/auth.json` sail through untouched via the bash tool even
// though the Read tool correctly hard-blocks the same file.

describe("findBlockedProtectedFolderReference — credential files never get the read-only exemption", () => {
  it("blocks `cat` of agent/auth.json (absolute path form)", () => {
    const command = `cat ${HOME}/.pi/agent/auth.json`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.pi/agent/auth.json`);
    expect(blocked?.allowReadOnlyBashExemption).toBe(false);
  });

  it("blocks `cat` of agent/auth.json (tilde-shorthand path form)", () => {
    const command = "cat ~/.pi/agent/auth.json";
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.pi/agent/auth.json`);
  });

  it("blocks `ls`/`less`/`head` style read-only commands referencing ~/.npmrc", () => {
    expect(findBlockedProtectedFolderReference(`ls -la ${HOME}/.npmrc`)).not.toBeNull();
    expect(findBlockedProtectedFolderReference(`less ${HOME}/.npmrc`)).not.toBeNull();
    expect(findBlockedProtectedFolderReference(`head ${HOME}/.npmrc`)).not.toBeNull();
  });

  it("still blocks mutating commands referencing the credential files (no regression)", () => {
    expect(findBlockedProtectedFolderReference(`echo x >> ${HOME}/.npmrc`)).not.toBeNull();
    expect(
      findBlockedProtectedFolderReference(`rm ${HOME}/.pi/agent/auth.json`),
    ).not.toBeNull();
  });
});

describe("findBlockedProtectedFolderReference — no regression: directory entries keep their read-only exemption", () => {
  it("still allows `ls ~/.ssh` through unblocked (routine inspection)", () => {
    expect(findBlockedProtectedFolderReference(`ls ${HOME}/.ssh`)).toBeNull();
    expect(findBlockedProtectedFolderReference("ls ~/.ssh")).toBeNull();
  });
  it("still allows `cat ~/.ssh/config` through unblocked (routine inspection)", () => {
    expect(findBlockedProtectedFolderReference(`cat ${HOME}/.ssh/config`)).toBeNull();
  });
  it("still blocks a mutating command referencing ~/.ssh (no regression)", () => {
    const blocked = findBlockedProtectedFolderReference(`rm -rf ${HOME}/.ssh`);
    expect(blocked).not.toBeNull();
    expect(blocked?.allowReadOnlyBashExemption).toBe(true);
  });
});

// ── isReadOnlyBashCommand (extracted helper, wraps READ_ONLY_CMDS) ─────

describe("isReadOnlyBashCommand", () => {
  it("recognizes read-only commands", () => {
    expect(isReadOnlyBashCommand(`ls -la ${HOME}/.ssh`)).toBe(true);
    expect(isReadOnlyBashCommand(`cat ${HOME}/.ssh/id_rsa`)).toBe(true);
  });
  it("does not treat mutating commands as read-only", () => {
    expect(isReadOnlyBashCommand(`rm -rf ${HOME}/.ssh`)).toBe(false);
    expect(isReadOnlyBashCommand(`echo hi >> ${HOME}/.bashrc`)).toBe(false);
  });
});

// ── commandReferencesPath (extracted helper, tilde-or-absolute substring check) ─

describe("commandReferencesPath", () => {
  it("matches the absolute form", () => {
    expect(
      commandReferencesPath(`cat ${HOME}/.ssh/id_rsa`, `${HOME}/.ssh`),
    ).toBe(true);
  });
  it("matches the tilde-shorthand form", () => {
    expect(commandReferencesPath("cat ~/.ssh/id_rsa", `${HOME}/.ssh`)).toBe(true);
  });
  it("returns false when the command does not reference the path", () => {
    expect(commandReferencesPath("echo hello", `${HOME}/.ssh`)).toBe(false);
  });
});

// ── find/fd bare-name read-only classification — protected-path bypass
// (FIXED, documented at index.ts lines 734-741 above READ_ONLY_CMDS) ──────
//
// READ_ONLY_CMDS classifies any command starting with `find` or `fd` as
// unconditionally read-only via a bare command-name regex, with zero
// inspection of the command's own arguments by itself. Since this
// classification feeds directly into findBlockedProtectedFolderReference's
// read-only exemption (and, in index.ts's default export, the analogous
// PROTECTED_WRITE_ONLY_FILES / PROTECTED_PATH_PATTERNS bash-guard check
// gated by the same `!isReadOnlyBashCommand(command)` condition), a
// destructive `find`/`fd` invocation against a protected path — using
// -delete, -exec, -execdir, -fprintf, -fprint, -fprint0, -fls, -ok, or
// -okdir — would sail straight through the hard block instead of being
// caught by it, if READ_ONLY_CMDS were the only gate.
//
// These tests assert the CORRECT behavior. isReadOnlySegment/
// hasFindMutatingPrimary (and their fd equivalents) close this gap by
// parsing find/fd's own arguments and withholding the exemption when a
// mutating primary/flag is present, so the assertions below now PASS
// (GREEN) against the current implementation.

describe("find/fd bare-name read-only classification — protected-path bypass (fixed)", () => {
  it("does NOT treat `find <protected-dir> -delete` as read-only", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -delete`)).toBe(false);
  });

  it("does NOT treat `find <protected-file> -exec rm {} \\;` as read-only", () => {
    expect(
      isReadOnlyBashCommand(`find ${HOME}/.pi/agent/auth.json -exec rm {} \\;`),
    ).toBe(false);
  });

  it("hard-blocks `find ~/.ssh -delete` via findBlockedProtectedFolderReference", () => {
    const command = `find ${HOME}/.ssh -delete`;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("hard-blocks `find ~/.pi/agent/auth.json -exec rm {} \\;` (credential file, never exempt)", () => {
    const command = `find ${HOME}/.pi/agent/auth.json -exec rm {} \\;`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.allowReadOnlyBashExemption).toBe(false);
  });

  it("hard-blocks `find ~/.ssh -execdir chmod 777 {} \\;`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/.ssh -execdir chmod 777 {} \\;`),
    ).not.toBeNull();
  });

  it("hard-blocks `find ~/personal -ok rm {} \\;`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/personal -ok rm {} \\;`),
    ).not.toBeNull();
  });

  it("hard-blocks `find ~/secure -okdir rm {} \\;`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/secure -okdir rm {} \\;`),
    ).not.toBeNull();
  });

  it("hard-blocks `find ~/Documents -fprintf out.txt %p`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/Documents -fprintf out.txt %p`),
    ).not.toBeNull();
  });

  // -fprint/-fprint0/-fls are the same "write matched output to a file"
  // family as -fprintf above, and were initially missed from
  // FIND_MUTATING_PRIMARIES when -fprintf was added — closing that gap here.
  it("does NOT treat `find <protected-dir> -fprint <file>` as read-only", () => {
    expect(
      isReadOnlyBashCommand(`find ${HOME}/.ssh -fprint ${HOME}/.ssh/authorized_keys`),
    ).toBe(false);
  });

  it("hard-blocks `find ~/.ssh -fprint ~/.ssh/authorized_keys`", () => {
    expect(
      findBlockedProtectedFolderReference(
        `find ${HOME}/.ssh -fprint ${HOME}/.ssh/authorized_keys`,
      ),
    ).not.toBeNull();
  });

  it("hard-blocks `find ~/.ssh -fprint0 out.txt`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/.ssh -fprint0 out.txt`),
    ).not.toBeNull();
  });

  it("hard-blocks `find ~/Documents -fls out.txt`", () => {
    expect(
      findBlockedProtectedFolderReference(`find ${HOME}/Documents -fls out.txt`),
    ).not.toBeNull();
  });

  it("hard-blocks an `fd --exec` invocation targeting a protected folder", () => {
    expect(
      findBlockedProtectedFolderReference(`fd --exec rm {} \\; -- . ${HOME}/.ssh`),
    ).not.toBeNull();
  });

  it("does NOT treat a bundled `fd -Hx` short flag as read-only and hard-blocks it", () => {
    const command = `fd -Hx rm -rf ${HOME}/.ssh \\;`;
    expect(isReadOnlyBashCommand(command)).toBe(false);
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("still treats `fd -tx .` (fd's own shorthand for --type executable) as read-only", () => {
    // Regression: a naive scan for x/X anywhere in the token wrongly matched
    // this, since -t is fd's value-taking --type flag and "x" here is its
    // attached value (executable), not a bundled -x/--exec flag.
    expect(isReadOnlyBashCommand("fd -tx .")).toBe(true);
  });

  it("still treats `fd -eXML .` (attached-value form of -e XML) as read-only", () => {
    // Regression: -e/--extension is value-taking; "XML" is its attached
    // value and happens to contain an X, which a naive scan would wrongly
    // flag as -X/--exec-batch.
    expect(isReadOnlyBashCommand("fd -eXML .")).toBe(true);
  });
});

// ── isReadOnlyBashCommand — chaining bypass (code-reviewer REJECT finding) ──
// The previous implementation flattened all tokens across &&/;/| into one
// array and only inspected args[0] (the first token of the WHOLE compound
// command). `ls ~/.ssh && find ~/.ssh -delete` had args[0] === "ls", so the
// find-mutating-primary check on the trailing segment never ran and the
// entire compound command was wrongly classified read-only. Fixed by
// splitting on &&/;/|/|| first and requiring every segment to independently
// qualify as read-only.

describe("isReadOnlyBashCommand — chaining bypass (regression)", () => {
  it("does NOT treat an innocuous leading segment hiding a mutating find as read-only (&&)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh && find ${HOME}/.ssh -delete`)).toBe(false);
  });

  it("does NOT treat an innocuous leading segment hiding a mutating find as read-only (;)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh; find ${HOME}/.ssh -delete`)).toBe(false);
  });

  it("hard-blocks the chained command via findBlockedProtectedFolderReference", () => {
    const command = `ls ${HOME}/.ssh && find ${HOME}/.ssh -delete`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.ssh`);
  });

  it("still treats an all-read-only chain as read-only (no over-blocking)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh && cat ${HOME}/.ssh/config`)).toBe(true);
  });
});

// ── isReadOnlyBashCommand — piping bypass (code-reviewer REJECT finding) ──
// Even when cmd === "find", the previous implementation only checked find's
// OWN primaries (-delete, -exec, etc.). Piping a clean-looking find into an
// external mutating command (e.g. `find ~/.ssh -type f | xargs rm`) has none
// of those primaries, so it was wrongly classified read-only despite deleting
// every matched file downstream. Fixed by splitting on "|" as well, and
// requiring the downstream segment to independently qualify as read-only —
// there is no exemption for "the find segment itself looked clean".

describe("isReadOnlyBashCommand — piping bypass (regression)", () => {
  it("does NOT treat find piped into an external mutating command as read-only", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -type f | xargs rm`)).toBe(false);
  });

  it("hard-blocks `find ~/.ssh -type f | xargs rm` via findBlockedProtectedFolderReference", () => {
    const command = `find ${HOME}/.ssh -type f | xargs rm`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.ssh`);
  });

  it("does NOT treat find piped into a shell as read-only", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -type f | sh`)).toBe(false);
  });

  it("still treats find piped into a genuinely read-only command as read-only (no over-blocking)", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -type f | wc -l`)).toBe(true);
  });
});

// ── isReadOnlyBashCommand — false-positive reduction for literal filename
// arguments that happen to equal a mutating primary's spelling (minor,
// non-blocking finding from the code-reviewer) ──────────────────────────

describe("isReadOnlyBashCommand — reduced false positive on literal -exec-like filename patterns", () => {
  it("treats `find . -iname -exec` as read-only (literal pattern argument to -iname, not a primary)", () => {
    expect(isReadOnlyBashCommand("find . -iname -exec")).toBe(true);
  });
});

// ── isReadOnlyBashCommand — glob-adjacent mutating primary bypass
// (code-reviewer-deep BLOCKER finding, pre-commit review of the
// FIND_VALUE_FLAGS lookback fix) ─────────────────────────────────────────
// hasFindMutatingPrimary's lookback used to run against tokensToStrings'
// output, which DROPS non-string tokens (shell-quote parses an unquoted glob
// like `*` into an {op:"glob",...} token, not a plain string) before the
// lookback ever sees the array. That silently closed the positional gap
// between a value-taking flag (-name/-iname/-path/...) and a REAL mutating
// primary that happens to follow an unquoted glob, e.g.
// `find ~/.ssh -name * -delete` parses to
// ["find","~/.ssh","-name",{op:"glob",pattern:"*"},"-delete"]; stripping the
// glob token collapsed that to ["find","~/.ssh","-name","-delete"], making
// "-delete" look like -name's own literal argument (correctly excused by
// FIND_VALUE_FLAGS) instead of the real mutating primary it is — letting the
// command sail straight through the protected-path hard block. Fixed by
// scanning a positional array that keeps a placeholder in the glob's slot
// instead of dropping it, so real adjacency is preserved.

describe("isReadOnlyBashCommand — glob-adjacent mutating primary bypass (regression)", () => {
  it("does NOT treat `find ~/.ssh -name * -delete` as read-only (glob masking -name/-delete adjacency)", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -name * -delete`)).toBe(false);
  });

  it("hard-blocks `find ~/.ssh -name * -delete` via findBlockedProtectedFolderReference", () => {
    const command = `find ${HOME}/.ssh -name * -delete`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.ssh`);
  });

  it("does NOT treat `find ~/.ssh -iname * -exec rm {} \\;` as read-only (glob masking -iname/-exec adjacency)", () => {
    expect(
      isReadOnlyBashCommand(`find ${HOME}/.ssh -iname * -exec rm {} \\;`),
    ).toBe(false);
  });

  it("does NOT treat `find ~/.ssh -path * -exec rm {} \\;` as read-only (glob masking -path/-exec adjacency)", () => {
    expect(
      isReadOnlyBashCommand(`find ${HOME}/.ssh -path * -exec rm {} \\;`),
    ).toBe(false);
  });

  it("still treats `find . -iname -exec` as read-only with no glob present (no regression from the positional fix)", () => {
    expect(isReadOnlyBashCommand("find . -iname -exec")).toBe(true);
  });
});

// ── isReadOnlyBashCommand — backgrounding bypass (code-reviewer REJECT
// finding, 2nd retry cycle) ──────────────────────────────────────────────
// Same args[0]-flattening bug as the &&/; chaining bypass above, just via
// "&" (background operator) instead of "&&"/";". shell-quote DOES parse "&"
// into its own {op:"&"} token, but the previous splitOnOps call list
// (["&&", ";", "|", "||"]) omitted plain "&", so both sides of the "&" stayed
// in one flattened segment and cmd === args[0] === "ls" hid the trailing
// mutating find/rm entirely. Fixed by adding "&" to the split list.

describe("isReadOnlyBashCommand — backgrounding bypass (regression)", () => {
  it("does NOT treat an innocuous leading segment hiding a mutating find as read-only (&)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh & find ${HOME}/.ssh -delete`)).toBe(false);
  });

  it("does NOT treat an innocuous leading segment hiding rm -rf as read-only (&)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh & rm -rf ${HOME}/.ssh`)).toBe(false);
  });

  it("hard-blocks the backgrounded command via findBlockedProtectedFolderReference", () => {
    const command = `ls ${HOME}/.ssh & find ${HOME}/.ssh -delete`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.ssh`);
  });

  it("still treats an all-read-only backgrounded pair as read-only (no over-blocking)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh & cat ${HOME}/.ssh/config`)).toBe(true);
  });
});

// ── isReadOnlyBashCommand — newline-separated commands bypass (code-reviewer
// REJECT finding, 2nd retry cycle) ───────────────────────────────────────
// shell-quote's parse() does not emit ANY op token for a bare newline between
// two commands — it flattens straight into one continuous token array with
// no operator marker whatsoever, so splitOnOps has nothing to split on for
// this case regardless of which ops are in its list. This is not an obscure
// edge case: multi-line bash tool calls are a common, ordinary shape. Fixed
// by failing closed (treating the command as non-read-only) whenever the raw
// command string contains an unquoted newline followed by further
// non-whitespace content.

describe("isReadOnlyBashCommand — newline-separated commands bypass (regression)", () => {
  it("does NOT treat a newline-separated mutating find as read-only (\\n)", () => {
    expect(isReadOnlyBashCommand(`find ${HOME}/.ssh -type f\nrm -rf ${HOME}/.ssh`)).toBe(false);
  });

  it("does NOT treat a CRLF-separated mutating command as read-only (\\r\\n)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh\r\nrm -rf ${HOME}/.ssh`)).toBe(false);
  });

  it("hard-blocks the newline-separated command via findBlockedProtectedFolderReference", () => {
    const command = `find ${HOME}/.ssh -type f\nrm -rf ${HOME}/.ssh`;
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.path).toBe(`${HOME}/.ssh`);
  });

  it("fails closed even on an all-read-only newline-separated pair (accepted over-blocking trade-off — there is no per-line splitting to verify each side independently, unlike &&/;/&)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh\ncat ${HOME}/.ssh/config`)).toBe(false);
  });

  it("does not over-block on a harmless trailing blank line with no further content", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh\n`)).toBe(true);
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh\n  \n`)).toBe(true);
  });
});

// ── isReadOnlyBashCommand — additional chain-separator operators shell-quote
// surfaces as op tokens (self-check for the same bug class as "&" above) ──
// shell-quote's own CONTROL regex (parse.js) recognizes ";;" (case-statement
// terminator) and "|&" (bash's pipe-stdout-and-stderr shorthand) as distinct
// op tokens, same as "&". Neither was in the previous splitOnOps list either,
// so both were vulnerable to the identical args[0]-flattening bug.

describe("isReadOnlyBashCommand — other chain-separator operators (;; and |&) (regression)", () => {
  it("does NOT treat a ;;-separated mutating find as read-only", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh ;; find ${HOME}/.ssh -delete`)).toBe(false);
  });

  it("does NOT treat a |&-separated mutating command as read-only", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh |& rm -rf ${HOME}/.ssh`)).toBe(false);
  });

  it("still treats an all-read-only ;;-separated pair as read-only (no over-blocking)", () => {
    expect(isReadOnlyBashCommand(`ls ${HOME}/.ssh ;; cat ${HOME}/.ssh/config`)).toBe(true);
  });
});

// ── command/process substitution bypass — item #16 regression ──────────
// isReadOnlyBashCommand only ever inspects args[0] of the (possibly split)
// segment. shell-quote flattens a $(...)/`...`/<(...)/>(...) substitution's
// inner tokens into the SAME token array as the outer command with no
// boundary marker distinguishing "nested inside a substitution" from "a
// sibling top-level word" — so e.g. `cat $(rm -rf ~/.ssh)` still has
// tokensToStrings(seg)[0] === "cat", and the buried "rm -rf ~/.ssh" never
// surfaces as its own segment. That wrongly grants the read-only exemption,
// so findBlockedProtectedFolderReference never hard-blocks these commands
// even when they reference a protected path.
//
// Fix implemented and under test (GREEN — all tests below pass):
//   - extractSubstitutionSpans(command): string[] — a raw-string (not
//     shell-quote-token-based) scanner for $(...), `...`, <(...), >(...)
//     spans, fail-closed (non-empty, no throw) on malformed/unterminated
//     input.
//   - isReadOnlyBashCommand gets a new early check: ANY substitution syntax
//     anywhere disqualifies the whole command from the read-only exemption
//     unconditionally — fail-closed, no narrower carve-out (user-confirmed
//     intended design).
//
// NOTE on command choice: the fix's own design notes illustrate the bug with
// `diff <(...)`/`tee >(...)`, but neither "diff" nor "tee" is a member of
// READ_ONLY_CMDS/READ_ONLY_CMD_NAMES in the first place — a command built
// around them is ALREADY classified non-read-only today for an unrelated
// reason (the outer command name itself never matches), which would make
// "isReadOnlyBashCommand(...) === false" assertions pass whether or not this
// fix exists. To keep these tests a genuine regression check tied to the
// actual bug, "cat" (which IS in READ_ONLY_CMD_NAMES) is used as the outer
// command for every substitution form below instead.

describe("command/process substitution bypass — item #16 regression", () => {
  it("extractSubstitutionSpans finds the inner content of a $(...) command substitution", () => {
    const spans = extractSubstitutionSpans(`cat $(rm -rf ${HOME}/.ssh)`);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.includes(`rm -rf ${HOME}/.ssh`))).toBe(true);
  });

  it("$(...)  form: isReadOnlyBashCommand no longer grants the read-only exemption", () => {
    expect(isReadOnlyBashCommand(`cat $(rm -rf ${HOME}/.ssh)`)).toBe(false);
  });

  it("$(...) form: findBlockedProtectedFolderReference hard-blocks it", () => {
    const command = `cat $(rm -rf ${HOME}/.ssh)`;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("backtick form: isReadOnlyBashCommand no longer grants the read-only exemption", () => {
    const command = `cat \`rm -rf ${HOME}/.ssh\``;
    expect(isReadOnlyBashCommand(command)).toBe(false);
  });

  it("backtick form: findBlockedProtectedFolderReference hard-blocks it", () => {
    const command = `cat \`rm -rf ${HOME}/.ssh\``;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("<(...) process-substitution form: isReadOnlyBashCommand no longer grants the read-only exemption", () => {
    expect(isReadOnlyBashCommand(`cat <(rm -rf ${HOME}/.ssh) /etc/hosts`)).toBe(false);
  });

  it("<(...) process-substitution form: findBlockedProtectedFolderReference hard-blocks it", () => {
    const command = `cat <(rm -rf ${HOME}/.ssh) /etc/hosts`;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it(">(...) process-substitution form: isReadOnlyBashCommand no longer grants the read-only exemption", () => {
    expect(isReadOnlyBashCommand(`cat >(rm -rf ${HOME}/.ssh) /etc/hosts`)).toBe(false);
  });

  it(">(...) process-substitution form: findBlockedProtectedFolderReference hard-blocks it", () => {
    const command = `cat >(rm -rf ${HOME}/.ssh) /etc/hosts`;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("blocks a credential-file (agent/auth.json, never-exempt entry) reference hidden inside a substitution", () => {
    const inner = `cp ${HOME}/.pi/agent/auth.json /tmp/exfil`;
    const command = `echo $(${inner})`;
    const spans = extractSubstitutionSpans(command);
    expect(spans.some((s) => s.includes(`${HOME}/.pi/agent/auth.json`))).toBe(true);
    const blocked = findBlockedProtectedFolderReference(command);
    expect(blocked).not.toBeNull();
    expect(blocked?.allowReadOnlyBashExemption).toBe(false);
  });

  it("loses the read-only label due to substitution syntax but is NOT blocked absent any protected-path reference (not a contradiction)", () => {
    // This is NOT a contradiction: losing the read-only LABEL only matters
    // when a protected path is ALSO referenced by the command. Neither
    // file1.txt nor file2.txt is a protected path, so
    // findBlockedProtectedFolderReference has nothing to block regardless of
    // how isReadOnlyBashCommand classifies the command.
    expect(isReadOnlyBashCommand("cat <(sort file1.txt) <(sort file2.txt)")).toBe(false);
    expect(
      findBlockedProtectedFolderReference("cat <(sort file1.txt) <(sort file2.txt)"),
    ).toBeNull();
  });

  it("confirmed fail-closed case: blocks even when the substitution's own inner content is itself a harmless read (user-confirmed intentional trade-off, not a bug)", () => {
    const command = `cat <(cat ${HOME}/.ssh/config) /tmp/backup`;
    expect(findBlockedProtectedFolderReference(command)).not.toBeNull();
  });

  it("extractSubstitutionSpans fails closed (non-empty, does not throw) on an unterminated $(... with no closing paren", () => {
    expect(() => extractSubstitutionSpans("cat $(rm -rf")).not.toThrow();
    const spans = extractSubstitutionSpans("cat $(rm -rf");
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.includes("rm -rf"))).toBe(true);
  });
});
