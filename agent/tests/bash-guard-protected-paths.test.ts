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
  extractOutputRedirectTargets,
  findBlockedOutputRedirectTarget,
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

  // ── item #17 gap: -o/--owner and -C/--base-directory are missing from
  // FD_VALUE_TAKING_SHORT_FLAG_CHARS ── unlike -tx/-eXML above (already
  // covered, already correct), these two value-taking short flags are NOT
  // yet in the set, so the bundled-flag scan doesn't know to stop and treat
  // the rest of the token as their attached value. If that attached value
  // happens to contain an x/X, the scan wrongly reaches it as if it were a
  // further bundled boolean flag and misclassifies the whole (harmless)
  // invocation as a bundled -x/--exec flag. That's over-blocking, not a
  // bypass: a harmless fd invocation gets wrongly treated as NOT read-only,
  // which strips its exemption from the ~/.ssh protected-path hard block.
  // These two currently FAIL, proving the gap; they should PASS once "o"
  // and "C" are added to FD_VALUE_TAKING_SHORT_FLAG_CHARS.
  it("[item #17 gap] should treat bundled `fd -Hox` (-o's attached value, not a bundled -x/--exec) as read-only", () => {
    const command = `fd -Hox . ${HOME}/.ssh`;
    expect(isReadOnlyBashCommand(command)).toBe(true);
    expect(findBlockedProtectedFolderReference(command)).toBeNull();
  });

  it("[item #17 gap] should treat bundled `fd -HCx` (-C's attached value, not a bundled -x/--exec) as read-only", () => {
    const command = `fd -HCx . ${HOME}/.ssh`;
    expect(isReadOnlyBashCommand(command)).toBe(true);
    expect(findBlockedProtectedFolderReference(command)).toBeNull();
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

// ── output-redirect-target bypass — item #18 regression ─────────────────
// analyzeBashCommandBase's own comment block (above isReadOnlyBashCommand)
// documents this exact gap: output redirection is only ever surfaced as a
// promptable "medium" risk via analyzeBashCommand, and that prompt is SKIPPED
// entirely in headless/subagent mode (ctx.hasUI is false, or the
// bash-guard-auto-allow flag is set). Neither findBlockedProtectedFolderReference
// nor the PROTECTED_WRITE_ONLY_FILES/PROTECTED_PATH_PATTERNS hard-block logic
// inspects redirect targets at all today, so `cat payload > ~/.ssh/authorized_keys`
// sails through both the interactive prompt (skipped) and the hard block
// (never checked) in headless mode — silently overwriting a protected path.
//
// extractOutputRedirectTargets/findBlockedOutputRedirectTarget close this by
// parsing the command with shell-quote and flat-scanning for >/>> operator
// tokens, taking the following token as the write target (with one extra hop
// for the >| clobber-form, which decomposes into {op:">"} then {op:"|"} then
// the target). Dynamic/substitution-computed targets are deliberately left to
// the pre-existing item #16 mechanism (see the last test in this section).

describe("extractOutputRedirectTargets", () => {
  it("extracts a simple > redirect target", () => {
    expect(extractOutputRedirectTargets("cat payload > ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("extracts a >> append-form redirect target", () => {
    expect(extractOutputRedirectTargets("cat payload >> ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("extracts a fd-numbered stderr redirect target (2>)", () => {
    expect(extractOutputRedirectTargets("cat payload 2> ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("extracts a combined-form redirect target (&>)", () => {
    expect(extractOutputRedirectTargets("cat payload &> ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("extracts a clobber-form redirect target (>|), requiring the one-extra-hop handling", () => {
    expect(extractOutputRedirectTargets("cat payload >| ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("does not treat fd-duplication (2>&1) as a path write target", () => {
    expect(extractOutputRedirectTargets("cat payload 2>&1")).toEqual([]);
  });

  it("extracts multiple independent redirect targets from a single command", () => {
    expect(extractOutputRedirectTargets("cat file > out.txt 2> err.log")).toEqual([
      "out.txt",
      "err.log",
    ]);
  });

  it("strips double quotes from the redirect target (tokenizer-stripped before reaching the function)", () => {
    expect(extractOutputRedirectTargets('cat x > "~/.ssh/authorized_keys"')).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("strips single quotes from the redirect target (tokenizer-stripped before reaching the function)", () => {
    expect(extractOutputRedirectTargets("cat x > '~/.ssh/authorized_keys'")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("fails closed (empty array, no throw) on an unparseable/malformed command string", () => {
    expect(() => extractOutputRedirectTargets("cat $(rm -rf")).not.toThrow();
    expect(extractOutputRedirectTargets("cat $(rm -rf")).toEqual([]);
  });
});

describe("findBlockedOutputRedirectTarget", () => {
  it("blocks a simple > redirect into ~/.ssh/authorized_keys (protected-folder kind)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > ~/.ssh/authorized_keys");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-folder");
  });

  it("blocks a >> append-form redirect into ~/.ssh/authorized_keys", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload >> ~/.ssh/authorized_keys"),
    ).not.toBeNull();
  });

  it("blocks a fd-numbered stderr redirect (2>) into ~/.ssh/authorized_keys", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload 2> ~/.ssh/authorized_keys"),
    ).not.toBeNull();
  });

  it("blocks `echo y >> ~/.ssh/authorized_keys` (regression guard for the exact example from the item text)", () => {
    expect(findBlockedOutputRedirectTarget("echo y >> ~/.ssh/authorized_keys")).not.toBeNull();
  });

  it("blocks a clobber-form redirect (>|) into ~/.ssh/authorized_keys", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload >| ~/.ssh/authorized_keys"),
    ).not.toBeNull();
  });

  it("blocks a combined-form redirect (&>) into ~/.ssh/authorized_keys", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload &> ~/.ssh/authorized_keys"),
    ).not.toBeNull();
  });

  it("blocks a redirect into ~/.bashrc (protected-write-only kind)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > ~/.bashrc");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-write-only");
  });

  it("blocks a redirect into .git/hooks/pre-commit (protected-write-only kind)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > .git/hooks/pre-commit");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-write-only");
  });

  it("blocks a redirect into ~/.gitconfig", () => {
    expect(findBlockedOutputRedirectTarget("cat payload > ~/.gitconfig")).not.toBeNull();
  });

  it("blocks a redirect hidden after a chained command (ls ~/.ssh && cat payload > ~/.ssh/authorized_keys)", () => {
    expect(
      findBlockedOutputRedirectTarget("ls ~/.ssh && cat payload > ~/.ssh/authorized_keys"),
    ).not.toBeNull();
  });

  it("blocks a backgrounded redirect (cat payload > ~/.ssh/authorized_keys &)", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload > ~/.ssh/authorized_keys &"),
    ).not.toBeNull();
  });

  it("blocks a multi-redirect command where the first target is already protected", () => {
    expect(
      findBlockedOutputRedirectTarget("cat file > ~/.ssh/out.txt 2> ~/.bashrc"),
    ).not.toBeNull();
  });

  it("does NOT false-positive on a redirect into an unrelated /tmp path", () => {
    expect(findBlockedOutputRedirectTarget("cat payload > /tmp/output.txt")).toBeNull();
  });

  it("does NOT false-positive on `ls ~/.ssh > /tmp/listing.txt` (preserves the documented 'inspect a protected dir, save elsewhere' workflow)", () => {
    // Key regression guard against a rejected blanket-disqualify design:
    // referencing a protected path as a READ argument elsewhere in the
    // command must not itself trigger this check — only the actual redirect
    // TARGET matters here.
    expect(findBlockedOutputRedirectTarget("ls ~/.ssh > /tmp/listing.txt")).toBeNull();
  });

  it("blocks a dynamic benign substitution-based filename — accepted usability tradeoff of the unconditional suffix-position taint policy (item #22 follow-up): the static analysis here cannot distinguish a benign substitution (`date +%s`) from a malicious one that computes a path separator at runtime (e.g. via a `printf` octal escape) without either ever containing a literal `/` or `~` in its own source text, so ANY substitution in a redirect target is now blocked, not just ones matching a path-like pattern", () => {
    expect(
      findBlockedOutputRedirectTarget("cat file.txt > out-$(date +%s).log"),
    ).not.toBeNull();
  });

  it("does NOT false-positive when there is no redirect at all (confirms no interference with unrelated existing exemption logic)", () => {
    expect(findBlockedOutputRedirectTarget("ls ~/.ssh")).toBeNull();
  });
});

// ── output-redirect-target bypass — unconditional glob-syntax block
// (superseding design, item #18 round 3) ─────────────────────────────────
//
// The previous approach (rounds 1-2, now removed) tried to determine
// whether a redirect target's glob pattern WOULD MATCH a specific protected
// path (globPathSegmentsContainOrEqual / globRedirectTargetMatchesProtected-
// WriteOnlyFile). That chase turned out to be open-ended: round 1 covered a
// glob suffix after a protected folder's own segment; round 2 (code-reviewer
// rejection) found mid-path/mid-pattern glob placement wasn't covered either
// (`~/.s?h/authorized_keys`, `.g?t/hooks/pre-commit`); and a further
// adversarial pass found POSIX bracket-expression syntax (`~/.ss[h]/authorized_keys`)
// bypasses the whole mechanism outright, since shell-quote never tokenizes
// `[`/`]` as a glob op at all (it stays a plain string token indistinguishable
// from a literal filename), so `commandReferencesPath`/`globSegmentMatches`
// (which only recognize `*`/`?`) never even see it as glob syntax to begin
// with — brace expansion (`{`/`}`) would likely be next.
//
// New design (user-confirmed, deliberately conservative): stop trying to
// resolve what a glob WOULD expand to, and instead hard-block ANY
// output-redirect target that contains an unquoted-shell-glob/pattern
// metacharacter at all — `*`, `?`, `[`, `]`, `{`, `}` — regardless of
// whether it happens to match a specific protected path. Rationale: a
// legitimate redirect target is essentially never a glob pattern in
// practice (globs are for read/list contexts, not write destinations), so
// this closes the entire obfuscation class in one fail-closed check instead
// of chasing individual syntax forms. This uses a new `kind: "glob-obfuscated"`
// value, distinct from `"protected-folder"`/`"protected-write-only"`, since
// it blocks on a different basis (presence of glob syntax in the target, not
// a specific protected-path match) — it fires even for a glob target that
// would NOT match any protected path.
//
// findBlockedOutputRedirectTarget recognizes `*`/`?`/`[`/`]`/`{`/`}` as
// blocking signals and reports `kind: "glob-obfuscated"` for any redirect
// target containing one of them, whether or not the target matches a
// specific protected path.
describe("output-redirect-target bypass — unconditional glob-syntax block", () => {
  it("extractOutputRedirectTargets still captures a redirect target containing a glob char (~/.bashr?) — extraction behavior itself is unchanged by the new design", () => {
    expect(extractOutputRedirectTargets(`cat payload > ${HOME}/.bashr?`)).toEqual([
      `${HOME}/.bashr?`,
    ]);
  });

  it("[unconditional] blocks a `?`-glob redirect that DOES match a protected-write-only file (~/.bashr?), reporting the new glob-obfuscated kind rather than protected-write-only", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat payload > ${HOME}/.bashr?`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a `?`-glob redirect that DOES match a protected folder (~/.ssh/authorized_key?), reporting glob-obfuscated rather than protected-folder", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat payload > ${HOME}/.ssh/authorized_key?`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a `*`-glob redirect target that does NOT match any protected path at all (backup-*.txt) — this is the core behavior change: previously this would have been allowed through", () => {
    const blocked = findBlockedOutputRedirectTarget("cat file > backup-*.txt");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a `?`-glob redirect target that does NOT match any protected path at all (report?.txt)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat file > report?.txt");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a bracket-expression redirect target that does NOT match any protected path (~/notes/report[1].txt) — non-matching case for the bracket bypass class", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat file > ${HOME}/notes/report[1].txt`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a mid-segment glob char INSIDE a protected folder's own segment (~/.s?h/authorized_keys) via the unconditional check, no longer requiring path-specific glob-matching logic", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat payload > ${HOME}/.s?h/authorized_keys`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a mid-segment glob char inside .git/hooks (.g?t/hooks/pre-commit)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > .g?t/hooks/pre-commit");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[unconditional] blocks a glob-suffixed redirect into a FILE-type PROTECTED_FOLDER_ENTRIES entry (~/.npmr?)", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat payload > ${HOME}/.npmr?`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[bracket bypass, previously undetected entirely] blocks the reported POSIX bracket-expression repro (~/.ss[h]/authorized_keys) — shell-quote never tokenizes `[`/`]` as glob syntax, so this bypassed BOTH the old glob-matching logic AND commandReferencesPath entirely; the unconditional character-presence check is what finally catches it", () => {
    const blocked = findBlockedOutputRedirectTarget(`cat payload > ${HOME}/.ss[h]/authorized_keys`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[bracket bypass] blocks a `.git`-relative bracket-expression repro (.g[i]t/hooks/pre-commit)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > .g[i]t/hooks/pre-commit");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("[brace bypass, same untested-syntax-form risk as brackets] blocks a brace-expansion redirect target ({.git,foo}/config)", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > {.git,foo}/config");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("glob-obfuscated");
  });

  it("does NOT false-positive on a genuinely benign, non-glob redirect target (no *, ?, [, ], {, } anywhere) — confirms the new check doesn't overreach beyond actual glob syntax", () => {
    expect(findBlockedOutputRedirectTarget("cat payload > /tmp/output.txt")).toBeNull();
  });

  it("does NOT misidentify fd-duplication (2>&1) as a glob-containing target when a genuine later redirect target is present and benign", () => {
    // 2>&1 tokenizes as its own distinct {op:">&"} op (see the
    // extractOutputRedirectTargets comment above) and is never pushed as a
    // target at all — this guards against a naive re-implementation that
    // scans raw command text char-by-char instead of the properly extracted
    // target list, which could otherwise misread the "&1" tail or similar
    // redirect furniture as pattern syntax.
    expect(
      findBlockedOutputRedirectTarget("cat payload 2>&1 > /tmp/output.txt"),
    ).toBeNull();
  });
});

describe("output-redirect bypass — substitution-computed targets already covered by item #16", () => {
  // Documents that extractOutputRedirectTargets/findBlockedOutputRedirectTarget
  // deliberately do NOT need to resolve $(...)/`...`/<(...)/>(...) redirect
  // targets themselves: extractSubstitutionSpans (item #16) already scans the
  // raw command string for substitution spans and, via
  // commandReferencesPath/PROTECTED_PATH_PATTERNS.test inside
  // findBlockedProtectedFolderReference, catches a protected path referenced
  // from inside a substitution regardless of whether it sits in a redirect
  // position. This test proves the new item #18 functions don't need to
  // recurse into substitution spans to cover this case.
  it("findBlockedProtectedFolderReference already blocks a substitution-computed redirect target", () => {
    expect(
      findBlockedProtectedFolderReference("cat a > $(echo ~/.ssh/authorized_keys)"),
    ).not.toBeNull();
  });
});

// ── $HOME resolution bug — shellParse(command) is invoked with no explicit
// `env` argument at any of this file's 3 call sites, so shell-quote's own
// default behavior (see shell-quote's parse.js: `parse(s, env, opts)` — any
// key missing from `env` resolves to `""`) collapses every $VAR/${VAR}
// reference to "" during parsing. `cat payload > $HOME/.ssh/authorized_keys`
// therefore parses TODAY with $HOME collapsing to "", so the extracted
// redirect target becomes "/.ssh/authorized_keys" — which does NOT match the
// protected-path checks' `~`-prefixed or absolute-path forms, silently
// letting a write to a protected path bypass the hard block.
//
// Fix under test (not yet implemented at the time these tests were written):
// thread a SHELL_PARSE_ENV = { HOME } constant, reusing this file's existing
// `HOME` constant, as the second argument to all 3 shellParse(command) call
// sites, so $HOME/${HOME} resolve to the real HOME value while every other
// env var ($USER, $PWD, $OLDPWD, $NOTHOME, ...) deliberately stays unresolved
// (collapsing to "" as before) — a narrow allowlist, not a broad env
// passthrough.

describe("extractOutputRedirectTargets — $HOME resolution (item #18 follow-up)", () => {
  it("resolves a bare $HOME redirect target to the real HOME value, not a collapsed empty string", () => {
    expect(
      extractOutputRedirectTargets("cat payload > $HOME/.ssh/authorized_keys"),
    ).toEqual([`${HOME}/.ssh/authorized_keys`]);
  });

  it("resolves a braced ${HOME} redirect target to the real HOME value", () => {
    expect(
      extractOutputRedirectTargets("cat payload > ${HOME}/.ssh/authorized_keys"),
    ).toEqual([`${HOME}/.ssh/authorized_keys`]);
  });

  it("[control] leaves a non-allowlisted var ($NOTHOME) collapsed to an empty string, same as before the fix — proves this is a narrow HOME-only allowlist, not a broad env passthrough", () => {
    expect(
      extractOutputRedirectTargets("cat payload > $NOTHOME/.ssh/authorized_keys"),
    ).toEqual(["/.ssh/authorized_keys"]);
  });
});

describe("findBlockedOutputRedirectTarget — $HOME resolution hard-block regression (item #18 follow-up)", () => {
  it("blocks a redirect into $HOME/.ssh/authorized_keys (protected-folder kind) once $HOME resolves", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload > $HOME/.ssh/authorized_keys",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-folder");
  });

  it("blocks a redirect into $HOME/.bashrc (protected-write-only kind) once $HOME resolves", () => {
    const blocked = findBlockedOutputRedirectTarget("cat payload > $HOME/.bashrc");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-write-only");
  });

  it("[control] does NOT block via $PWD resolution — $PWD deliberately stays unresolved/collapsed, unlike $HOME", () => {
    expect(
      findBlockedOutputRedirectTarget("cat payload > $PWD/.ssh/authorized_keys"),
    ).toBeNull();
  });
});

describe("isReadOnlyBashCommand — unaffected by threading env into its shellParse call (non-regression)", () => {
  it("still classifies `cat $HOME/.ssh/id_rsa` as read-only", () => {
    expect(isReadOnlyBashCommand("cat $HOME/.ssh/id_rsa")).toBe(true);
  });
});

// ── output-redirect-target bypass — substitution-computed targets (item #22,
// pi-improvement-plan.md) ──────────────────────────────────────────────────
//
// Current design: a `findSubstitutionTaintedRedirectTarget(command: string):
// string | null` helper, wired into `findBlockedOutputRedirectTarget` so a
// match reports `{ target, kind: "substitution-computed" }`. For each
// `>`/`>>` redirect target extracted by `extractOutputRedirectTargets`:
//
//   - If a command/process-substitution marker (`$(`, backtick, `<(`, `>(`,
//     or a bare trailing `$`) appears anywhere in the target — at the START
//     (no literal prefix) or in SUFFIX position (non-empty literal text
//     precedes it) — block unconditionally.
//
// This was originally a position-aware rule that only blocked a SUFFIX-
// position marker when the literal prefix or the substitution's own source
// text contained a `/` or `~` character. That rule was closed to
// unconditional after a verified live bypass: a substitution can compute a
// leading path-traversal sequence at RUNTIME via shell escaping (e.g.
// `printf '\57..\57.ssh\57authorized_keys'`, where `\57` is the octal escape
// for `/`) without that character ever appearing in the substitution's own
// source text, so neither disjunct of the old rule could catch it regardless
// of what literal prefix preceded it. There is no way to statically
// distinguish a benign dynamic substitution (`date +%s`) from a malicious one
// using only the command's source text, so this policy accepts the
// usability cost of blocking both.
//
// This is a NEW, narrower-scoped check than item #16's
// extractSubstitutionSpans/findBlockedProtectedFolderReference path: that
// existing mechanism only catches a substitution whose *inner content*
// textually contains a literal protected path (e.g.
// `$(echo ~/.ssh/authorized_keys)`) via a raw substring/pattern match against
// PROTECTED_FOLDERS/PROTECTED_PATH_PATTERNS. It does NOT catch a
// variable-indirected path built from a substitution (case 2 below), nor
// does it hard-block a substitution-computed target merely for being
// substitution-computed the way this new check does. The two mechanisms are
// complementary, not duplicative — see the existing
// "output-redirect bypass — substitution-computed targets already covered by
// item #16" describe block above for the item #16 side of this boundary.
describe("findBlockedOutputRedirectTarget — substitution-computed redirect targets (item #22)", () => {
  it("[start-of-target, $(...) form] blocks `cat > $(echo ~/.ssh/authorized_keys)`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat > $(echo ~/.ssh/authorized_keys)",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[start-of-target, variable-indirected path — currently un-caught by any existing mechanism, including item #16's extractSubstitutionSpans] blocks `X=.ssh; cat > $(echo ~/$X/authorized_keys)`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "X=.ssh; cat > $(echo ~/$X/authorized_keys)",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[start-of-target, backtick form] blocks `cat > `echo ~/.ssh/authorized_keys``", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat > `echo ~/.ssh/authorized_keys`",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[start-of-target, <(...) process-substitution form] blocks `cat > <(echo hi)`", () => {
    const blocked = findBlockedOutputRedirectTarget("cat > <(echo hi)");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[start-of-target, >(...) process-substitution form — note: extractOutputRedirectTargets alone returns [] for this today, since shell-quote splits >( across two separate tokens with no plain-string/glob target for the existing scan to pick up; this is a currently-open gap the new check must also close] blocks `cat > >(tee /tmp/file.log)`", () => {
    const blocked = findBlockedOutputRedirectTarget("cat > >(tee /tmp/file.log)");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[start-of-target, >(...) wrapping an inner literal protected-path redirect] blocks `cat payload > >(cat > ~/.ssh/authorized_keys)` and reports substitution-computed — the new check fires at the outer >( marker before any flat scan would reach the inner literal target", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload > >(cat > ~/.ssh/authorized_keys)",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  // NOTE: `cat file.txt > out-$(date +%s).log` (a timestamp-suffixed output
  // filename) is the existing, immutable regression test at lines ~1025-1029
  // in this file ("blocks a dynamic benign substitution-based filename") and
  // is deliberately NOT re-added or re-asserted here — this describe block's
  // job is only to confirm the cases below are consistent with it under the
  // now-unconditional policy.

  it("[suffix position, single-quoted, no / or ~ anywhere] blocks `cat payload > 'report_$(2024).txt'` — any suffix-position marker is now unconditionally tainted, regardless of the literal prefix or the substitution's own source text", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload > 'report_$(2024).txt'",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[suffix position, double-quoted — textually identical to the single-quoted case above after shell-quote tokenization, since shell-quote discards quote-type metadata once parsing is done] blocks `cat payload > \"report_$(2024).txt\"`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      'cat payload > "report_$(2024).txt"',
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[bare trailing $ as a separate token, not glued to the target] does NOT block `cat > file $` — the extracted redirect target is `file` only, unaffected by the stray, separately-tokenized `$`, so this is not a substitution marker at all and stays outside the unconditional policy", () => {
    expect(findBlockedOutputRedirectTarget("cat > file $")).toBeNull();
  });

  it("[malformed/unclosed substitution, suffix position] blocks `cat > out_$(date +%s` — a suffix-position marker is now unconditionally tainted even when the substitution is unclosed/malformed", () => {
    const blocked = findBlockedOutputRedirectTarget("cat > out_$(date +%s");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[malformed/unclosed substitution, but marker at START of target] blocks `cat > $(echo ~/.ssh/authorized_keys` — the start-of-target clause fires regardless of well-formedness", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat > $(echo ~/.ssh/authorized_keys",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[suffix position, the substitution's own inner content contains a / or ~] blocks `cat > out_$(echo ~/.ssh/authorized_keys).txt`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat > out_$(echo ~/.ssh/authorized_keys).txt",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[suffix position, opaque call, no / or ~ anywhere in its own text — previously an ACCEPTED LIMITATION of the position-aware design, now closed by the unconditional policy: an opaque function/command name (e.g. compute_secret_path) gives no textual signal to evaluate, but that is no longer relevant since presence of the marker alone is sufficient] blocks `cat > out_$(compute_secret_path).txt`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat > out_$(compute_secret_path).txt",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });
});

// ── output-redirect-target bypass — bare `..` literal prefix glued to a
// suffix-position substitution, where the substitution computes a path
// character (e.g. `/`) at RUNTIME rather than containing one in its own
// source text (reported reproducible bypass on top of item #22) ──────────
//
// HISTORICAL NOTE: evaluateRedirectTargetTaint's SUFFIX position branch used
// to only block when `PATH_CHAR.test(prefix) || PATH_CHAR.test(inner)` — i.e.
// when a literal `/` or `~` character appeared in either the pre-marker
// literal text or the substitution's own source text. A bare `..` prefix (no
// `/` or `~` in its source) followed by a substitution that constructs a `/`
// at runtime (e.g. via `printf '\57...'`, where `\57` is the octal escape for
// `/`) satisfied neither disjunct, so the check misclassified it as
// untainted even though `..` immediately followed by ANY computed suffix can
// traverse upward from cwd the moment the substitution's output contains or
// is preceded by a path separator. That position-aware rule (and the narrower
// `..`-prefix-only patch that followed it) has since been superseded: SUFFIX
// position is now unconditionally tainted regardless of what precedes the
// marker (see the "substitution-computed redirect targets (item #22)"
// describe block above), so every test below remains blocked, just via the
// broader unconditional rule rather than the `..`-specific one originally
// targeted here.
describe("findBlockedOutputRedirectTarget — bare `..` prefix + suffix-position substitution (runtime-computed path character, reported bypass on item #22)", () => {
  it("[reported exploit] blocks `echo KEY >> ..$(printf '\\57.ssh\\57authorized_keys')` — the octal escape `\\57` decodes to `/` only at runtime, so neither the `..` prefix nor the substitution's own source text contains a literal `/` or `~`; caught today by the unconditional suffix-position rule regardless", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "echo KEY >> ..$(printf '\\57.ssh\\57authorized_keys')",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[general form, any substitution content] blocks `cat payload >> ..$(echo whatever)` — a bare `..` prefix in suffix position is inherently unsafe regardless of what the substitution computes, since it can traverse upward from cwd no matter what text `echo whatever` itself contains", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload >> ..$(echo whatever)",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[consistency check, no longer a 'control'] blocks `cat file.txt > out_$(date +%s).log` — a benign, non-`..`, non-path-containing literal prefix (`out_`) is now blocked too under the unconditional suffix-position policy; this is the same accepted usability tradeoff documented on the immutable regression test at ~line 1025", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat file.txt > out_$(date +%s).log",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });
});

// ── output-redirect-target bypass — bare `.` (single dot, NOT `..`) literal
// prefix glued to a suffix-position substitution, where the substitution
// constructs a `/../` traversal sequence at RUNTIME via shell escaping (e.g.
// `printf`'s octal escapes) rather than containing a literal `/` anywhere in
// the substitution's own source text (adjacent bypass found on top of the
// just-applied bare `..`-prefix fix above) ─────────────────────────────────
//
// HISTORICAL NOTE: the old `PURE_TRAVERSAL_PREFIX` regex
// (`/^(?:\.\.?\/)*\.\.?$/`) plus `PATH_CHAR` only recognized specific literal
// prefix shapes (`..`, bare `.`, `/`- or `~`-containing text) as tainted. A
// literal prefix of a single `.` followed by a substitution that constructs
// `/../` at runtime (e.g. `.$(printf '\57..\57.ssh\57authorized_keys')`,
// which resolves to `../.ssh/authorized_keys` relative to cwd) was the
// motivating case for extending that regex, but the whole position-aware
// prefix-shape approach has since been superseded: SUFFIX position is now
// unconditionally tainted regardless of what precedes the marker, so the
// tests below remain blocked via that broader rule rather than any
// prefix-shape-specific logic.
describe("findBlockedOutputRedirectTarget — bare `.` prefix + suffix-position substitution (adjacent bypass on top of the `..`-prefix fix, item #22)", () => {
  it("[reported exploit] blocks `echo KEY >> .$(printf '\\57..\\57.ssh\\57authorized_keys')` — the octal escapes decode to `/../` only at runtime, so neither the bare `.` prefix nor the substitution's own source text contains a literal `/` or `~`; caught today by the unconditional suffix-position rule regardless", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "echo KEY >> .$(printf '\\57..\\57.ssh\\57authorized_keys')",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[quoted-literal form of the same exploit] blocks `echo KEY >> \".$(printf '\\57..\\57.ssh\\57authorized_keys')\"` — the whole target survives as a single flattened quoted-string token", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "echo KEY >> \".$(printf '\\57..\\57.ssh\\57authorized_keys')\"",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[general form, any substitution content, guards the root cause rather than one exact PoC] blocks `cat payload >> .$(echo whatever)` — a bare `.` prefix in suffix position is inherently unsafe regardless of what the substitution computes", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload >> .$(echo whatever)",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  // [control] `cat file.txt > out_$(date +%s).log` (a real, non-dot literal
  // prefix) is already covered by the immutable primary regression test
  // (~line 1025) and by the "[consistency check, no longer a 'control']" test
  // in the `..`-prefix describe block above, with the exact same command
  // string — not re-added here to avoid duplicating it.
});

// ── output-redirect-target bypass — verified live bypass regression tests
// (unconditional suffix-position policy) ────────────────────────────────────
//
// Confirms the two previously-open bypass examples that motivated closing
// the SUFFIX-position rule to unconditional (see the "substitution-computed
// redirect targets (item #22)" describe block's header comment above): a
// substitution can compute a leading `/../` path-traversal sequence at
// RUNTIME via shell escaping (octal escapes in `printf`) without a `/` or `~`
// character ever appearing in the substitution's own source text, so no
// static text-pattern check on the substitution's source — regardless of
// what literal prefix precedes it — could have caught these before this fix.
describe("findBlockedOutputRedirectTarget — verified live bypass regression (unconditional suffix-position policy)", () => {
  it("[verified live bypass] blocks `cat payload >> out_$(printf '\\57..\\57.ssh\\57authorized_keys')` — resolves at runtime to `.ssh/authorized_keys` relative to cwd; the `out_` literal prefix contains no `/` or `~`, and neither does the printf call's own source text", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload >> out_$(printf '\\57..\\57.ssh\\57authorized_keys')",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[verified live bypass, alternate literal prefix] blocks `cat payload >> x$(printf '\\57..\\57.ssh\\57authorized_keys')`", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "cat payload >> x$(printf '\\57..\\57.ssh\\57authorized_keys')",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });
});

// ── output-redirect-target bypass — `>&word` combined redirect-with-fd-
// duplication form (item #27, security-auditor-deep finding on top of item
// #22) ───────────────────────────────────────────────────────────────────
//
// `>&word` is genuinely ambiguous in bash: `>&2`/`2>&1`/`>&-` are
// fd-duplication/fd-close forms that never touch the filesystem, but
// `>&word` for any non-numeric, non-`-` word is a real output-redirect write
// target, identical in effect to `> word`. shell-quote tokenizes ALL of
// these identically as `{op:">&"}` followed by a plain string token — there
// is no token-shape difference between `>&2` and `>&word` (verified
// empirically against the installed shell-quote version: both parse to
// `[..., {op:">&"}, "<word>"]`). Before this fix, extractOutputRedirectTargets
// only matched `{op:">"}`/`{op:">>"}` tokens, so `>&word` targets were never
// extracted at all — invisible to the protected-path/glob checks in
// findBlockedOutputRedirectTarget, to the substitution-taint check in
// findSubstitutionTaintedRedirectTarget (which only matched the same two
// ops), AND to the raw-text commandReferencesPath fallback once the target
// is obfuscated via command substitution with octal-escape encoding (same
// obfuscation class as items #22/#27's `.$(printf '\57...')` bypasses, just
// reached through a redirect operator this pipeline didn't recognize at
// all).
//
// Fix: extractOutputRedirectTargets, findSubstitutionTaintedRedirectTarget,
// and (transitively) findBlockedOutputRedirectTarget now also match
// `{op:">&"}`, extracting/evaluating its target the same way as `>`/`>>`,
// except that a plain-string target which is a bare non-negative integer or
// `-` is recognized as fd-duplication/fd-close and excluded — it is not a
// write target at all.
describe("findBlockedOutputRedirectTarget — `>&word` combined redirect-with-fd-duplication form (item #27)", () => {
  it("[reported exploit] blocks `echo KEY >& $(printf '\\57home\\57rabeta\\57.ssh\\57authorized_keys')` as substitution-computed — the octal-escaped substitution target sits in `>&`'s target position, which the taint check now recognizes", () => {
    const blocked = findBlockedOutputRedirectTarget(
      "echo KEY >& $(printf '\\57home\\57rabeta\\57.ssh\\57authorized_keys')",
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("substitution-computed");
  });

  it("[plain protected-path form, no substitution obfuscation] blocks `echo KEY >& ~/.ssh/authorized_keys`", () => {
    const blocked = findBlockedOutputRedirectTarget("echo KEY >& ~/.ssh/authorized_keys");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-folder");
  });

  it("[plain protected-path form, absolute path] blocks `echo KEY >& ${HOME}/.ssh/authorized_keys`", () => {
    const blocked = findBlockedOutputRedirectTarget(`echo KEY >& ${HOME}/.ssh/authorized_keys`);
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-folder");
  });

  it("[plain protected-write-only form] blocks `echo KEY >& ~/.bashrc`", () => {
    const blocked = findBlockedOutputRedirectTarget("echo KEY >& ~/.bashrc");
    expect(blocked).not.toBeNull();
    expect(blocked?.kind).toBe("protected-write-only");
  });

  it("[non-regression, numeric fd-duplication form] does NOT block `echo test 2>&1` — a bare non-negative integer following `>&` is fd-duplication, never a write target", () => {
    expect(findBlockedOutputRedirectTarget("echo test 2>&1")).toBeNull();
  });

  it("[non-regression, numeric fd-duplication form] does NOT block `echo test >&2`", () => {
    expect(findBlockedOutputRedirectTarget("echo test >&2")).toBeNull();
  });

  it("[non-regression, fd-close form] does NOT block `echo test >&-`", () => {
    expect(findBlockedOutputRedirectTarget("echo test >&-")).toBeNull();
  });

  it("extractOutputRedirectTargets extracts a non-numeric `>&word` target as a real write target", () => {
    expect(extractOutputRedirectTargets("echo KEY >& ~/.ssh/authorized_keys")).toEqual([
      "~/.ssh/authorized_keys",
    ]);
  });

  it("extractOutputRedirectTargets excludes the numeric fd-duplication form (2>&1) — no target extracted", () => {
    expect(extractOutputRedirectTargets("echo test 2>&1")).toEqual([]);
  });

  it("extractOutputRedirectTargets excludes the fd-close form (>&-) — no target extracted", () => {
    expect(extractOutputRedirectTargets("echo test >&-")).toEqual([]);
  });

  it("[non-regression] does NOT false-positive on an unrelated `>&word` writing to a harmless path", () => {
    expect(findBlockedOutputRedirectTarget("echo KEY >& /tmp/output.txt")).toBeNull();
  });
});
