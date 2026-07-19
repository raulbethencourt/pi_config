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
