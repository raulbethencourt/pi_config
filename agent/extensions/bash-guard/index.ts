import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
    DynamicBorder,
    isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@mariozechner/pi-tui";
import { Container, SelectList, Text } from "@mariozechner/pi-tui";
import { parse as shellParse } from "shell-quote";
import * as fs from "node:fs";
import * as path from "node:path";

export type Severity = "high" | "medium";

export type Risk = {
    severity: Severity;
    reasons: string[];
};

export type OpToken = { op: string;[k: string]: unknown };

export type Token = string | OpToken;

export function isOpToken(t: Token): t is OpToken {
    return typeof t === "object" && t !== null && "op" in t;
}

export function tokensToStrings(tokens: Token[]): string[] {
    return tokens.filter((t) => typeof t === "string") as string[];
}

export function splitOnOps(tokens: Token[], splitOps: string[]): Token[][] {
    const out: Token[][] = [];
    let current: Token[] = [];
    for (const t of tokens) {
        if (isOpToken(t) && splitOps.includes(t.op)) {
            if (current.length) out.push(current);
            current = [];
            continue;
        }
        current.push(t);
    }
    if (current.length) out.push(current);
    return out;
}

export function hasFlag(args: string[], flag: string): boolean {
    if (args.includes(flag)) return true;
    // For short flags like "-i", check if it appears inside a bundle like "-ni"
    if (flag.length === 2 && flag.startsWith("-")) {
        return args.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes(flag[1]));
    }
    return false;
}

export function anyArgStartsWith(args: string[], prefix: string): boolean {
    return args.some((a) => a.startsWith(prefix));
}

export function analyzeSegment(seg: Token[]): Risk | null {
    const reasons: string[] = [];
    let severity: Severity = "medium";

    const ops = seg.filter(isOpToken).map((o) => o.op);
    const args = tokensToStrings(seg);
    if (args.length === 0) return null;

    const cmd = args[0];
    const rest = args.slice(1);

    // Shell redirection / pipes are handled on the whole command, but keep some segment checks too.
    if (
        ops.includes("|") &&
        (args.includes("sh") ||
            args.includes("bash") ||
            args.includes("zsh") ||
            args.includes("fish"))
    ) {
        reasons.push("pipe to a shell (possible remote code execution)");
        severity = "high";
    }

    // sudo
    if (cmd === "sudo") {
        reasons.push("sudo (elevated privileges)");
        severity = "high";
    }

    // rm/rmdir/unlink
    if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
        severity = "high";
        reasons.push(`${cmd} (file deletion)`);
        if (rest.some((a) => a.includes("-r") || a.includes("-R")))
            reasons.push("recursive delete (-r/-R)");
        if (rest.some((a) => a.includes("-f")))
            reasons.push("forced delete (-f)");
        if (ops.includes("glob"))
            reasons.push("glob pattern expansion (may delete many files)");
    }

    // find -delete
    if (cmd === "find" && rest.includes("-delete")) {
        severity = "high";
        reasons.push("find -delete (bulk deletion)");
    }

    // git operations — skip read-only subcommands entirely
    const GIT_READONLY = new Set([
        "status", "log", "diff", "show", "branch", "tag",
        "remote", "ls-files", "ls-tree", "describe", "shortlog",
        "blame", "grep", "rev-parse", "rev-list", "cat-file",
        "fsck", "stash", "fetch", "config",
    ]);
    if (cmd === "git") {
        const sub = rest[0];
        const subArgs = rest.slice(1);

        if (GIT_READONLY.has(sub)) {
            // purely informational — do not flag
        } else {
        reasons.push(sub ? `git ${sub} (git command)` : "git (git command)");

        if (sub === "rm") {
            severity = "high";
            reasons.push(
                "git rm (deletes files from working tree and stages deletions)",
            );
        }
        if (
            sub === "clean" &&
            (subArgs.some((a) => a.includes("-f")) ||
                subArgs.includes("-d") ||
                subArgs.includes("-x"))
        ) {
            severity = "high";
            reasons.push("git clean (can delete untracked files)");
        }
        if (sub === "reset" && subArgs.includes("--hard")) {
            severity = "high";
            reasons.push("git reset --hard (discard changes)");
        }
        if (
            (sub === "checkout" || sub === "restore") &&
            (subArgs.includes(".") ||
                subArgs.includes("--") ||
                subArgs.includes("--source"))
        ) {
            severity = severity === "high" ? "high" : "medium";
            reasons.push("git checkout/restore (can overwrite working tree)");
        }
        if (
            sub === "push" &&
            (subArgs.includes("--force") ||
                subArgs.includes("--force-with-lease") ||
                subArgs.includes("-f"))
        ) {
            severity = "high";
            reasons.push("git push --force (rewrite remote history)");
        }
        if (sub === "reflog" && subArgs.includes("expire")) {
            severity = "high";
            reasons.push("git reflog expire (can remove recovery history)");
        }
        if (sub === "gc" && subArgs.some((a) => a.startsWith("--prune"))) {
            severity = "high";
            reasons.push("git gc --prune (can permanently delete objects)");
        }
        } // end else (non-readonly git)
    }

    // Database CLI tools — destructive operations
    if (cmd === "mysql" || cmd === "mariadb") {
        const joined = rest.join(" ");
        if (/\b(DROP|TRUNCATE)\b/i.test(joined)) {
            severity = "high";
            reasons.push("destructive SQL via mysql/mariadb CLI (DROP/TRUNCATE)");
        }
        if (/\bDELETE\s+FROM\s+\w+\s*(?:;|$|"|')/i.test(joined)) {
            severity = "high";
            reasons.push("DELETE FROM without WHERE clause via mysql CLI");
        }
    }
    if (cmd === "psql") {
        const joined = rest.join(" ");
        if (/\b(DROP|TRUNCATE)\b/i.test(joined)) {
            severity = "high";
            reasons.push("destructive SQL via psql CLI (DROP/TRUNCATE)");
        }
        if (/\bDELETE\s+FROM\s+\w+\s*(?:;|$|"|')/i.test(joined)) {
            severity = "high";
            reasons.push("DELETE FROM without WHERE clause via psql CLI");
        }
    }
    if (cmd === "sqlite3" || cmd === "sqlite") {
        const joined = rest.join(" ");
        if (/\b(DROP|TRUNCATE)\b/i.test(joined)) {
            severity = "high";
            reasons.push("destructive SQL via sqlite3 CLI (DROP/TRUNCATE)");
        }
        if (/\bDELETE\s+FROM\s+\w+\s*(?:;|$|"|')/i.test(joined)) {
            severity = "high";
            reasons.push("DELETE FROM without WHERE clause via sqlite3 CLI");
        }
    }
    if (cmd === "redis-cli") {
        const joined = rest.join(" ");
        if (/\b(FLUSHALL|FLUSHDB)\b/i.test(joined)) {
            severity = "high";
            reasons.push("Redis FLUSHALL/FLUSHDB (wipes all data)");
        }
    }
    if (cmd === "mongosh" || cmd === "mongo") {
        const joined = rest.join(" ");
        if (/\b(dropDatabase|dropCollection|drop\(\))/.test(joined)) {
            severity = "high";
            reasons.push("MongoDB drop database/collection");
        }
    }
    // Elasticsearch — curl DELETE to ES port
    if (cmd === "curl" && rest.some(a => a === "DELETE" || a === "-XDELETE")) {
        const joined = rest.join(" ");
        if (/:9200\//.test(joined) || /localhost:9200/.test(joined) || /\b_all\b/.test(joined)) {
            severity = "high";
            reasons.push("Elasticsearch index deletion (curl DELETE to :9200)");
        }
    }

    // truncate
    if (cmd === "truncate") {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("truncate (in-place size change, can erase contents)");
    }

    // dd of=
    if (
        cmd === "dd" &&
        (anyArgStartsWith(rest, "of=") || rest.includes("of"))
    ) {
        severity = "high";
        reasons.push("dd with output file/device (can overwrite data)");
    }

    // Disk / volume management (prompt aggressively; high risk)
    // Linux: mkfs.*, wipefs, parted, fdisk, gdisk/sgdisk, lsblk, cryptsetup, LVM tools, zpool
    // macOS: diskutil, hdiutil, gpt, newfs_*, asr
    if (cmd.startsWith("mkfs")) {
        severity = "high";
        reasons.push("mkfs (filesystem formatting)");
    }
    if (cmd.startsWith("newfs_")) {
        severity = "high";
        reasons.push("newfs_* (filesystem formatting)");
    }
    if (cmd === "wipefs") {
        severity = "high";
        reasons.push("wipefs (disk signature wipe)");
    }
    if (cmd === "diskutil") {
        severity = "high";
        reasons.push("diskutil (disk management command)");
        if (rest.includes("eraseDisk") || rest.includes("eraseVolume")) {
            reasons.push("diskutil erase (destructive disk operation)");
        }
    }
    if (cmd === "hdiutil") {
        severity = "high";
        reasons.push("hdiutil (disk image management command)");
    }
    if (cmd === "gpt") {
        severity = "high";
        reasons.push("gpt (partition table manipulation)");
    }
    if (cmd === "asr") {
        severity = "high";
        reasons.push("asr (Apple Software Restore; can overwrite volumes)");
    }
    if (
        cmd === "parted" ||
        cmd === "fdisk" ||
        cmd === "gdisk" ||
        cmd === "sgdisk"
    ) {
        severity = "high";
        reasons.push(`${cmd} (disk/partition management)`);
    }
    if (cmd === "lsblk") {
        // Usually read-only, but still disk-related; prompt as requested.
        severity = severity === "high" ? "high" : "medium";
        reasons.push("lsblk (disk listing)");
    }
    if (cmd === "cryptsetup") {
        severity = "high";
        reasons.push("cryptsetup (disk encryption management)");
    }
    if (cmd === "pvcreate" || cmd === "vgcreate" || cmd === "lvcreate") {
        severity = "high";
        reasons.push(`${cmd} (LVM volume management)`);
    }
    if (cmd === "zpool") {
        severity = "high";
        reasons.push("zpool (ZFS pool management)");
    }

    // chmod/chown recursive
    if (
        cmd === "chmod" &&
        (rest.includes("-R") || rest.includes("--recursive"))
    ) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("chmod -R (recursive permission changes)");
    }
    if (
        cmd === "chown" &&
        (rest.includes("-R") || rest.includes("--recursive"))
    ) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("chown -R (recursive ownership changes)");
    }

    // mv/cp overwriting
    if (cmd === "mv" && (rest.includes("-f") || rest.includes("--force"))) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("mv --force/-f (can overwrite files)");
    }
    if (cmd === "cp" && (rest.includes("-f") || rest.includes("--force"))) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("cp --force/-f (can overwrite files)");
    }

    // sed/perl in-place
    if (cmd === "sed" && (hasFlag(rest, "-i") || rest.includes("--in-place"))) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("sed -i (in-place file modification)");
    }
    if (
        cmd === "perl" &&
        (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))
    ) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("perl -pi/-i (in-place file modification)");
    }

    // kill/shutdown/systemctl
    if (cmd === "kill" || cmd === "pkill" || cmd === "killall") {
        severity = severity === "high" ? "high" : "medium";
        reasons.push(`${cmd} (process termination)`);
        if (rest.includes("-9")) {
            severity = "high";
            reasons.push("SIGKILL (-9)");
        }
    }
    if (cmd === "shutdown" || cmd === "reboot") {
        severity = "high";
        reasons.push(`${cmd} (system power operation)`);
    }
    if (
        cmd === "systemctl" &&
        (rest.includes("stop") || rest.includes("disable"))
    ) {
        severity = severity === "high" ? "high" : "medium";
        reasons.push("systemctl stop/disable (service disruption)");
    }

    // Remote execution patterns
    if ((cmd === "curl" || cmd === "wget") && ops.includes("|")) {
        severity = "high";
        reasons.push("curl/wget piped (possible remote code execution)");
    }

    // Infra deletes
    if (cmd === "kubectl" && rest[0] === "delete") {
        severity = "high";
        reasons.push("kubectl delete (resource deletion)");
    }
    if (cmd === "terraform" && rest[0] === "destroy") {
        severity = "high";
        reasons.push("terraform destroy (infrastructure teardown)");
    }
    if (
        cmd === "aws" &&
        rest[0] === "s3" &&
        rest[1] === "rm" &&
        rest.includes("--recursive")
    ) {
        severity = "high";
        reasons.push("aws s3 rm --recursive (bulk deletion)");
    }
    if (cmd === "gcloud" && rest.includes("delete")) {
        severity = "high";
        reasons.push("gcloud delete (resource deletion)");
    }

    if (reasons.length === 0) return null;
    return { severity, reasons };
}

// Maximum recursion depth for descending into nested command/process
// substitutions (see extractSubstitutionSpans below). Caps pathological
// inputs like `$($($($(...))))` at a fixed, small amount of work rather than
// recursing once per nesting level indefinitely — item #16 only requires
// catching realistic hidden-command bypasses, not arbitrarily deep nesting.
const MAX_SUBSTITUTION_RECURSION_DEPTH = 5;

// Whole-command analysis for a single command string, with no awareness of
// substitutions — this is exactly what analyzeBashCommand did before item
// #16. Split out so analyzeBashCommand can run it unconditionally at every
// depth and layer the recursive substitution pass on top, rather than the
// recursion needing to duplicate or skip this logic.
function analyzeBashCommandBase(command: string): Risk | null {
    let tokens: Token[];
    try {
        tokens = shellParse(command) as Token[];
    } catch {
        // Fallback: shell-quote failed (e.g. heredocs, process substitutions).
        // Run a quick regex scan for known-dangerous patterns rather than
        // blindly prompting on every complex-but-harmless command.
        const DANGER = [
            /\bsudo\b/,
            /\brm\b[^#\n]*-[a-zA-Z]*[rRfF]/,
            /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|sh)\b/,
            /\bmkfs\b/, /\bwipefs\b/, /\bdd\b[^#\n]*\bof=/,
            /\b(shutdown|reboot|halt|poweroff)\b/,
            /\bterraform\s+destroy\b/, /\bkubectl\s+delete\b/,
            /\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*f)\b/,
            /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
            /\bTRUNCATE\s+TABLE\b/i,
            /\b(FLUSHALL|FLUSHDB)\b/i,
            /\b(dropDatabase|dropCollection)\b/,
            /\bcurl\b[^#\n]*-X\s*DELETE[^#\n]*:9200/,
        ];
        for (const p of DANGER) {
            if (p.test(command)) {
                return { severity: "high", reasons: ["unparsed shell command with dangerous pattern"] };
            }
        }
        return null; // can't parse, no obvious danger — allow through
    }

    const reasons: string[] = [];
    let severity: Severity = "medium";

    // Whole-command operator checks
    const ops = tokens.filter(isOpToken).map((t) => t.op);
    // Only flag output redirection — it can overwrite files.
    // Input redirection (<, <<) and bare pipes (|) are not flagged here;
    // dangerous pipe patterns (curl|bash, pipe-to-shell) are caught at
    // segment level with high severity.
    // Redirections to /dev/null, /dev/stdout, /dev/stderr are always harmless — skip them.
    const REDIRECT_OPS = new Set([">", ">>", "2>", "2>>"]);
    const NULL_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
    const hasHarmfulRedirect = tokens.some((t, i) => {
        if (!isOpToken(t) || !REDIRECT_OPS.has(t.op)) return false;
        const next = tokens[i + 1];
        const target = typeof next === "string" ? next : null;
        return target === null || !NULL_TARGETS.has(target);
    });
    if (hasHarmfulRedirect) {
        reasons.push("shell output redirection (can overwrite files)");
        severity = severity === "high" ? "high" : "medium";
    }

    // Segment analysis (split on &&, ||, ;)
    const segments = splitOnOps(tokens, ["&&", "||", ";"]);
    for (const seg of segments) {
        const segRisk = analyzeSegment(seg);
        if (!segRisk) continue;
        if (segRisk.severity === "high") severity = "high";
        for (const r of segRisk.reasons) reasons.push(r);
    }

    // De-duplicate reasons
    const uniq = [...new Set(reasons)];
    if (uniq.length === 0) return null;
    return { severity, reasons: uniq };
}

// Item #16: a dangerous command hidden inside a $(...)/`...`/<(...)/>(...)
// substitution (e.g. `cat $(rm -rf ~/.ssh)`) is invisible to
// analyzeBashCommandBase — shell-quote flattens the substitution's inner
// tokens into the SAME segment as the outer command, so the buried `rm -rf`
// never becomes its own segment's args[0]. This wrapper closes that gap by
// recursively analyzing each substitution span as its own command string.
//
// The base (whole-command) analysis always runs regardless of depth — the
// depth cap only ever gates whether we ALSO recurse into substitution spans,
// it never suppresses or replaces the normal analysis of the current command
// string. Depth is capped at MAX_SUBSTITUTION_RECURSION_DEPTH to bound work
// on pathological/adversarial nesting (e.g. `$($($($(...))))`) rather than
// recursing once per nesting level indefinitely.
export function analyzeBashCommand(command: string, depth = 0): Risk | null {
    const baseRisk = analyzeBashCommandBase(command);

    if (depth >= MAX_SUBSTITUTION_RECURSION_DEPTH) return baseRisk;

    const spans = extractSubstitutionSpans(command);
    if (spans.length === 0) return baseRisk;

    let severity: Severity = baseRisk?.severity ?? "medium";
    const reasons: string[] = baseRisk ? [...baseRisk.reasons] : [];
    let foundInnerRisk = false;

    for (const span of spans) {
        const innerRisk = analyzeBashCommand(span, depth + 1);
        if (!innerRisk) continue;
        foundInnerRisk = true;
        if (innerRisk.severity === "high") severity = "high";
        for (const r of innerRisk.reasons) {
            reasons.push(`inside command/process substitution: ${r}`);
        }
    }

    if (!foundInnerRisk) return baseRisk;
    return { severity, reasons: [...new Set(reasons)] };
}

async function promptRunOrAbort(
    ctx: ExtensionContext,
    command: string,
    risk: Risk,
): Promise<"run" | "abort"> {
    if (!ctx.hasUI) return "abort";

    const reasonsText = risk.reasons.map((r) => `• ${r}`).join("\n");
    const header = `Command flagged as ${risk.severity.toUpperCase()} risk:`;
    const body = `${header}\n\n${reasonsText}\n\nCommand:\n${command}`;

    const items: SelectItem[] = [
        { value: "run", label: "Run", description: "Execute the command" },
        { value: "abort", label: "Abort", description: "Block this command" },
    ];

    const choice = await ctx.ui.custom<"run" | "abort">(
        (tui, theme, _kb, done) => {
            const container = new Container();
            container.addChild(
                new DynamicBorder((s: string) => theme.fg("warning", s)),
            );
            container.addChild(
                new Text(
                    theme.fg(
                        "warning",
                        theme.bold("Potentially destructive bash command"),
                    ),
                    1,
                    0,
                ),
            );
            container.addChild(new Text(body, 1, 0));

            const list = new SelectList(items, items.length, {
                selectedPrefix: (t) => theme.fg("accent", t),
                selectedText: (t) => theme.fg("accent", t),
                description: (t) => theme.fg("muted", t),
                scrollInfo: (t) => theme.fg("dim", t),
                noMatch: (t) => theme.fg("warning", t),
            });

            list.onSelect = (item) => done(item.value as "run" | "abort");
            list.onCancel = () => done("abort");
            container.addChild(list);

            container.addChild(
                new DynamicBorder((s: string) => theme.fg("warning", s)),
            );

            return {
                render: (w) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data) => {
                    list.handleInput(data);
                    tui.requestRender();
                },
            };
        },
        { overlay: true },
    );

    return choice ?? "abort";
}

// PI_SUBAGENT_DEPTH is 0 (or unset) in the main session and >= 1 in spawned subagent processes.
// Behaviour branches on this: interactive prompting in the main session, headless hard-block
// for catastrophic operations in subagents (where stdin is /dev/null and no UI is available).
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

// Hard-block patterns for subagent (headless) mode. Criteria: unrecoverable by default AND
// unlikely to be intentional in an automated context. Fewer false positives over broad coverage —
// the interactive prompt handles the rest for main sessions.
const HEADLESS_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
    // Recursive deletion
    {
        pattern:
            /(?<!\bgit\s+)\brm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-\brecursive\b)/,
        reason: "recursive delete (rm -r / -rf / -Rf)",
    },
    // Privilege escalation
    { pattern: /\bsudo\b/, reason: "elevated privileges (sudo)" },
    // Remote code execution via pipe-to-shell
    {
        pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/,
        reason: "pipe to shell (remote code execution)",
    },
    // Disk / filesystem destruction
    { pattern: /\bmkfs/, reason: "filesystem formatting (mkfs)" },
    { pattern: /\bnewfs_\w+/, reason: "filesystem formatting (newfs_*)" },
    { pattern: /\bwipefs\b/, reason: "disk signature wipe" },
    {
        pattern: /\bdiskutil\s+(erase|zeroDisk|secureErase|reformat)/i,
        reason: "destructive disk operation (diskutil)",
    },
    {
        pattern: /\bdd\b[^#\n]*\bof=\/dev\//,
        reason: "raw disk write (dd of=/dev/...)",
    },
    {
        pattern: /\b(parted|fdisk|gdisk|sgdisk)\b/,
        reason: "partition table management",
    },
    { pattern: /\bcryptsetup\b/, reason: "disk encryption management" },
    { pattern: /\bzpool\b/, reason: "ZFS pool management" },
    // System power
    {
        pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
        reason: "system power operation",
    },
    // Infrastructure teardown
    {
        pattern: /\bterraform\s+destroy\b/,
        reason: "infrastructure teardown (terraform destroy)",
    },
    { pattern: /\bkubectl\s+delete\b/, reason: "Kubernetes resource deletion" },
    {
        pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive/,
        reason: "bulk S3 deletion (aws s3 rm --recursive)",
    },
    // Destructive git operations
    {
        pattern: /\bgit\s+commit\b/,
        reason: "git commit (commits are main-session operations)",
    },
    {
        pattern: /\bgit\s+pull\b/,
        reason: "git pull (pulls are main-session operations)",
    },
    {
        pattern: /\bgit\s+push\b/,
        reason: "git push (pushes are main-session operations)",
    },
    {
        pattern: /\bgit\s+reset\b[^#\n]*--hard\b/,
        reason: "discard all uncommitted changes (git reset --hard)",
    },
    {
        pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/,
        reason: "delete untracked files (git clean -f)",
    },
    {
        pattern: /\bgit\s+reflog\s+expire\b/,
        reason: "expire reflog (removes recovery history)",
    },
    {
        pattern: /\bgit\s+gc\b[^#\n]*--prune\b/,
        reason: "prune unreachable objects (git gc --prune)",
    },
    // Database destruction
    {
        pattern: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i,
        reason: "DROP DATABASE/TABLE/SCHEMA (irreversible data loss)",
    },
    {
        pattern: /\bTRUNCATE\s+(TABLE\s+)?\w/i,
        reason: "TRUNCATE TABLE (deletes all rows, irreversible)",
    },
    {
        pattern: /\bDELETE\s+FROM\s+\w+\s*(?:;|$|"|')/i,
        reason: "DELETE FROM without WHERE clause (mass deletion)",
    },
    // MySQL/MariaDB
    {
        pattern: /\bmysql\b[^#\n]*\b(DROP|TRUNCATE)\b/i,
        reason: "destructive SQL via mysql CLI",
    },
    // PostgreSQL
    {
        pattern: /\bpsql\b[^#\n]*\b(DROP|TRUNCATE)\b/i,
        reason: "destructive SQL via psql CLI",
    },
    // SQLite
    {
        pattern: /\bsqlite3?\b[^#\n]*\b(DROP|TRUNCATE)\b/i,
        reason: "destructive SQL via sqlite3 CLI",
    },
    {
        pattern: /\bsqlite3?\b[^#\n]*\bDELETE\s+FROM\s+\w+\s*(?:;|$|"|')/i,
        reason: "mass DELETE via sqlite3 CLI (no WHERE clause)",
    },
    // Redis
    {
        pattern: /\bredis-cli\b[^#\n]*\b(FLUSHALL|FLUSHDB)\b/i,
        reason: "Redis FLUSHALL/FLUSHDB (wipes all data)",
    },
    // MongoDB
    {
        pattern: /\b(mongosh|mongo)\b[^#\n]*\b(dropDatabase|dropCollection|drop\(\))/,
        reason: "MongoDB drop database/collection",
    },
    // Elasticsearch
    {
        pattern: /\bcurl\b[^#\n]*-X\s*DELETE[^#\n]*localhost:9200/,
        reason: "Elasticsearch index deletion via curl DELETE",
    },
    {
        pattern: /\bcurl\b[^#\n]*-X\s*DELETE[^#\n]*:9200\//,
        reason: "Elasticsearch index deletion via curl DELETE",
    },
    {
        pattern: /\bcurl\b[^#\n]*DELETE[^#\n]*_all\b/,
        reason: "Elasticsearch delete _all indices",
    },
];

// ── Protected Folders (non-bypassable, ALL contexts) ─────────────────
// These directories are completely off-limits for write operations.
// No agent, no bypass, no escape hatch. Hard-block always.
const HOME = process.env.HOME || "/home/rabeta";

// Per-entry bash-layer policy: whether a command that *looks* read-only
// (see READ_ONLY_CMDS/isReadOnlyBashCommand below) is still allowed to
// merely reference this path without a hard block.
//
// - Directories (~/.ssh, ~/personal, ~/secure, ~/Documents) predate the two
//   credential-file entries below and keep the original, deliberate
//   usability trade-off: they can hold a mix of sensitive and merely
//   incidental files (e.g. ~/.ssh/config, ~/.ssh/known_hosts), so routine
//   inspection (`ls ~/.ssh`, `cat ~/.ssh/config`) is allowed through at the
//   bash layer while mutation is still hard-blocked. Changing this now would
//   be an unrelated behavior change outside this fix's scope.
// - The two credential files (agent/auth.json, ~/.npmrc) are single files
//   whose *entire content* is a secret — there is no partial "reading this
//   file is fine, only writing it isn't" case, unlike a mixed-content
//   directory. Their whole stated purpose (see the Read-tool block reason
//   text below: "no read, no write") is to be fully blocked including reads,
//   so they must NEVER receive the read-only-command exemption; doing so
//   would let a plain `cat ~/.pi/agent/auth.json` sail through untouched via
//   the bash tool even though the Read tool correctly blocks the same file.
type ProtectedFolderEntry = {
    path: string;
    allowReadOnlyBashExemption: boolean;
};

const PROTECTED_FOLDER_ENTRIES: ProtectedFolderEntry[] = [
    { path: `${HOME}/.ssh`, allowReadOnlyBashExemption: true },
    { path: `${HOME}/personal`, allowReadOnlyBashExemption: true },
    { path: `${HOME}/secure`, allowReadOnlyBashExemption: true },
    { path: `${HOME}/Documents`, allowReadOnlyBashExemption: true },
    { path: `${HOME}/.pi/agent/auth.json`, allowReadOnlyBashExemption: false },
    { path: `${HOME}/.npmrc`, allowReadOnlyBashExemption: false },
];

const PROTECTED_FOLDERS = PROTECTED_FOLDER_ENTRIES.map((e) => e.path);

export function isProtectedPath(filePath: string): boolean {
    // Resolve ~ to HOME
    const expanded = filePath.startsWith("~")
        ? filePath.replace(/^~/, HOME)
        : filePath;
    // Also resolve symlinks: a symlink placed at an arbitrary, non-matching
    // path can point at a protected file/folder, so the literal-string check
    // alone can be bypassed. Check both the literal (expanded) path and its
    // resolved real form.
    const resolved = resolveRealPathBestEffort(expanded);
    const matchesFolder = (candidate: string) =>
        PROTECTED_FOLDERS.some(
            (folder) => candidate === folder || candidate.startsWith(folder + "/"),
        );
    return matchesFolder(expanded) || matchesFolder(resolved);
}

// Purely read-only commands are allowed to merely reference a protected path
// (e.g. `ls ~/.ssh`) without triggering a hard block — only mutation is
// blocked. This exemption is applied selectively per PROTECTED_FOLDER_ENTRIES
// entry (see allowReadOnlyBashExemption above), not blanket across all of
// PROTECTED_FOLDERS.
//
// find/fd are matched here as read-only via a bare command-name prefix, but
// unlike the other commands in this list they accept primaries/flags that
// mutate the filesystem (`find -delete`, `find -exec rm {} \;`, `fd -x ...`).
// A bare command-name match alone would wrongly classify those as read-only.
// isReadOnlyBashCommand (below) closes that gap by parsing find/fd arguments
// and withholding the exemption when a mutating primary/flag is present.
const READ_ONLY_CMDS = /^\s*(ls|cat|file|stat|wc|head|tail|less|more|tree|find|grep|rg|fd|bat)\b/;

// Exact command-name membership check used per-segment (see isReadOnlySegment
// below), derived from the same command list as READ_ONLY_CMDS. Kept as an
// explicit Set (rather than re-running the regex per segment) since a
// segment's leading token is already a single parsed word, not a string that
// needs anchoring/`\b` handling.
const READ_ONLY_CMD_NAMES = new Set([
    "ls", "cat", "file", "stat", "wc", "head", "tail", "less", "more",
    "tree", "find", "grep", "rg", "fd", "bat",
]);

// find primaries that mutate the filesystem or execute arbitrary commands.
const FIND_MUTATING_PRIMARIES = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprintf",
    "-fprint",
    "-fprint0",
    "-fls",
]);

// find flags that take a literal pattern/value as their next argument.
// Without accounting for this, a filename pattern that happens to be
// spelled like a mutating primary (e.g. `find . -iname -exec`, matching
// files literally named "-exec") would false-positive as a mutating find:
// the "-exec" there is -iname's argument, not a primary in its own right.
// This is a cheap positional heuristic, not full find-grammar parsing (it
// doesn't know every value-taking flag), but it removes the common case.
const FIND_VALUE_FLAGS = new Set([
    "-name", "-iname", "-path", "-ipath", "-regex", "-iregex",
    "-wholename", "-iwholename", "-newer", "-perm", "-user", "-group",
    "-size", "-type", "-maxdepth", "-mindepth", "-printf",
]);

// Maps each raw token to a positional string for the adjacency-sensitive
// lookback scan in hasFindMutatingPrimary below: plain string tokens keep
// their literal value, while non-string tokens (glob patterns, shell
// operators — anything shell-quote represents as an OpToken) are mapped to a
// placeholder that can never equal a real find flag/primary name. This
// differs from tokensToStrings, which DROPS non-string tokens entirely —
// fine for most callers, but for a positional lookback that drop silently
// closes the gap between the tokens on either side, e.g.
// `find ~/.ssh -name * -delete` parses to
// ["find", "~/.ssh", "-name", {op:"glob",pattern:"*"}, "-delete"], and
// stripping the glob token via tokensToStrings collapses that to
// ["find", "~/.ssh", "-name", "-delete"] — making "-delete" look like
// "-name"'s literal argument (which FIND_VALUE_FLAGS below correctly
// excuses) rather than a real mutating primary. Keeping a placeholder in the
// glob's position preserves the true adjacency so the lookback still sees
// "-delete" as following the glob, not "-name" directly.
const NON_STRING_TOKEN_PLACEHOLDER = "\0";

function tokensToPositionalStrings(tokens: Token[]): string[] {
    return tokens.map((t) => (typeof t === "string" ? t : NON_STRING_TOKEN_PLACEHOLDER));
}

function hasFindMutatingPrimary(seg: Token[]): boolean {
    const positional = tokensToPositionalStrings(seg);
    for (let i = 0; i < positional.length; i++) {
        if (!FIND_MUTATING_PRIMARIES.has(positional[i])) continue;
        const prev = positional[i - 1];
        if (prev && FIND_VALUE_FLAGS.has(prev)) continue; // literal argument, not a primary
        return true;
    }
    return false;
}

// fd flags that execute arbitrary commands against matched files.
const FD_MUTATING_FLAGS = new Set(["-x", "--exec", "-X", "--exec-batch"]);

// fd is a clap-based CLI, and clap supports bundling boolean short flags
// into a single token (e.g. `-Hx` is equivalent to `-H -x`). FD_MUTATING_FLAGS
// above is an exact-string membership test, so a bundled token like `-Hx`
// never equals the string "-x" and silently evades detection — letting a
// destructive `fd -Hx rm -rf ~/.ssh \;` slip past as "read-only".
//
// A naive "does this dash-prefixed token contain x/X anywhere" scan is NOT
// safe: fd also has value-taking short flags (-d, -E, -t, -e, -S, -c, -j)
// whose attached value can legitimately contain x/X without the token being
// an exec flag. `fd -tx .` is fd's own documented shorthand for
// `--type executable`, and `-eXML`/`-Exyz` are attached-value forms of
// -e/-E — none of these execute anything. The invariant relied on below:
// walk the token's characters after the leading dash and stop as soon as a
// value-taking short flag's letter is hit — everything after that point is
// that flag's attached value, not a further bundled flag, so it's not
// inspected. A bare x/X reached strictly before any value-taking flag
// letter means a boolean bundle like `-Hx` or `-uHx`, which IS exec/
// exec-batch usage.
const FD_VALUE_TAKING_SHORT_FLAG_CHARS = new Set(["d", "E", "t", "e", "S", "c", "j"]);

function isFdBundledExecFlag(token: string): boolean {
    if (!/^-[A-Za-z]+$/.test(token)) return false; // single-dash, letters-only bundle
    for (let i = 1; i < token.length; i++) {
        const ch = token[i];
        if (ch === "x" || ch === "X") return true;
        if (FD_VALUE_TAKING_SHORT_FLAG_CHARS.has(ch)) return false; // rest is this flag's value
    }
    return false;
}

// Classifies a single segment (already split on &&/;/|/||) as read-only on
// its own: its own leading command must be in READ_ONLY_CMD_NAMES, and if
// that leading command is find/fd, the segment must also lack mutating
// primaries/flags. Each segment is judged purely on its own tokens — no
// segment inherits read-only status from a sibling segment.
function isReadOnlySegment(seg: Token[]): boolean {
    const args = tokensToStrings(seg);
    if (args.length === 0) return false;
    const cmd = args[0];

    if (!READ_ONLY_CMD_NAMES.has(cmd)) return false;

    if (cmd === "find" && hasFindMutatingPrimary(seg)) return false;
    if (
        cmd === "fd" &&
        args.some((a) => FD_MUTATING_FLAGS.has(a) || isFdBundledExecFlag(a))
    )
        return false;

    return true;
}

// Detects a command/statement separator that shell-quote's parse() will NOT
// surface as an {op:...} token for splitOnOps to split on: a bare newline
// (or CRLF) between two commands. Unlike ";"/"&&"/"||"/"&"/etc., which parse
// into a distinguishable op token, shell-quote silently flattens a
// newline-separated command pair into one continuous token array with no
// operator marker at all (verified empirically — see the regression tests
// below). That means `find ~/.ssh -type f\nrm -rf ~/.ssh` reaches
// isReadOnlySegment as a SINGLE unsplit segment whose args[0] is "find" with
// no mutating primary of its own, reopening the exact args[0]-flattening bug
// the &&/;/|/|| fix above closed — just via an operator that never becomes a
// token in the first place, so there is nothing for splitOnOps to catch.
//
// Since there is no token-level fix available for this case, fail closed
// instead: withhold the read-only exemption whenever the raw command string
// contains a newline that is NOT inside a quoted string, followed by further
// non-whitespace content (a trailing/leading blank line alone is harmless).
// The quote-tracking here is a cheap best-effort scan (single/double quotes,
// backslash-escapes outside single quotes), not a full shell grammar parse —
// consistent with the other "cheap positional heuristic" trade-offs already
// documented in this file (e.g. FIND_VALUE_FLAGS) — but it correctly leaves
// an intentionally-quoted multi-line argument alone while still catching the
// unquoted-separator case that actually chains two commands together.
function hasUnquotedNewlineWithContent(command: string): boolean {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (ch === "\\" && !inSingle) {
            i++; // skip the escaped character (backslash has no special meaning inside '...')
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if ((ch === "\n" || ch === "\r") && !inSingle && !inDouble) {
            if (/\S/.test(command.slice(i + 1))) return true;
        }
    }
    return false;
}

// Extracts the inner content of every command-substitution (`$(...)`,
// backtick) and process-substitution (`<(...)`, `>(...)`) span in a raw bash
// command string — item #16 (command/process substitution bypass of the
// protected-path hard block).
//
// This is a cheap best-effort RAW-STRING scan, not a shell-quote-token-based
// one, for the same reason hasUnquotedNewlineWithContent above isn't
// token-based: shell-quote's tokenization of these constructs is empirically
// unreliable for this purpose. `$(` and a bare `(` (subshell grouping)
// produce indistinguishable op tokens; `>(` is split across two separate
// tokens while `<(` parses as a single token, an inconsistency that makes a
// uniform token-level rule for both forms impractical; and backticks aren't
// tokenized as structure at all — they glue onto whichever adjacent string
// token they're next to. Scanning the raw string directly sidesteps all of
// that.
//
// Deliberately does NOT track quoting state. A quoted literal that merely
// contains the text `$(...)` (e.g. inside a single-quoted string that is
// never actually expanded by the shell) still counts as "contains a
// substitution" here. This is accepted over-detection, not an oversight: the
// alternative — trying to determine whether a given `$(`/backtick/`<(`/`>(`
// occurrence is "real" vs. quoted-and-inert — is exactly the kind of
// under-detection risk that reopens the bypass this function exists to
// close. Over-flagging a command that turns out to be harmless costs a
// prompt/hard-block; under-flagging a real substitution reopens item #16.
//
// Also deliberately does NOT special-case arithmetic expansion `$((...))`:
// it will register as containing a (nested) substitution span, same as
// command substitution. This is an intentional, accepted trade-off — not a
// bug to later "narrow down" — for the same reason as the quoting choice
// above: distinguishing arithmetic from command substitution reliably from
// raw text alone is not worth the risk of a narrower check missing a real
// case.
export function extractSubstitutionSpans(command: string): string[] {
    const spans: string[] = [];
    let i = 0;
    while (i < command.length) {
        const two = command.slice(i, i + 2);
        if (two === "$(" || two === "<(" || two === ">(") {
            let depth = 1;
            let j = i + 2;
            while (j < command.length && depth > 0) {
                if (command[j] === "(") depth++;
                else if (command[j] === ")") depth--;
                if (depth === 0) break;
                j++;
            }
            spans.push(command.slice(i + 2, j));
            i = depth === 0 ? j + 1 : j;
            continue;
        }
        if (command[i] === "`") {
            const close = command.indexOf("`", i + 1);
            if (close === -1) {
                spans.push(command.slice(i + 1));
                break;
            }
            spans.push(command.slice(i + 1, close));
            i = close + 1;
            continue;
        }
        i++;
    }
    return spans;
}

export function isReadOnlyBashCommand(command: string): boolean {
    if (!READ_ONLY_CMDS.test(command)) return false;

    // Item #16: ANY command/process substitution syntax ($(...), backtick,
    // <(...), >(...)) anywhere in the command unconditionally disqualifies it
    // from the read-only exemption — fail-closed, whole-command level, no
    // narrower carve-out based on what the substitution's inner content turns
    // out to be. This is deliberate: a substitution can hide an arbitrary
    // command (`cat $(rm -rf ~/.ssh)`) behind an outer command that is itself
    // in READ_ONLY_CMD_NAMES, and shell-quote's tokenization gives no reliable
    // boundary to inspect the inner content at a finer grain here (see
    // extractSubstitutionSpans above for why). The accepted trade-off — e.g.
    // `diff <(cat ~/.ssh/config) /tmp/backup` now hard-blocks even though the
    // substitution's own content is a harmless read — was explicitly
    // confirmed by the user as intentional, not a bug to later loosen.
    if (extractSubstitutionSpans(command).length > 0) return false;

    // Fail closed on unquoted newline-separated commands — see
    // hasUnquotedNewlineWithContent above for why this can't be handled via
    // splitOnOps like the other separators.
    if (hasUnquotedNewlineWithContent(command)) return false;

    let tokens: Token[];
    try {
        tokens = shellParse(command) as Token[];
    } catch {
        // Unparseable command (heredocs, process substitutions, etc.) — can't
        // safely inspect find/fd arguments for mutating primaries/flags, so
        // don't grant the read-only exemption on unverified trust.
        return false;
    }

    // A compound command (chained with &&/;/;;/||/&/|/|&) is only read-only
    // if EVERY segment independently qualifies as read-only. Splitting first
    // and classifying each segment by its OWN leading command closes several
    // bypasses that classifying the whole flattened token stream by a single
    // args[0] was vulnerable to:
    //
    //   - Chaining: `ls ~/.ssh && find ~/.ssh -delete` — an innocuous
    //     leading segment (`ls`) made args[0] === "ls" for the *entire*
    //     command, so the find-mutating-primary check on the trailing
    //     `find ... -delete` segment never ran.
    //   - Piping: `find ~/.ssh -type f | xargs rm` — piping a clean-looking
    //     find into an external mutating command has none of find's own
    //     mutating primaries, so a whole-command check would miss it.
    //   - Backgrounding: `ls ~/.ssh & find ~/.ssh -delete` — same
    //     args[0]-flattening bug as chaining, just via "&" instead of "&&"/
    //     ";" (code-reviewer REJECT finding — "&" was parsed into its own op
    //     token by shell-quote but was missing from this split list).
    //
    // The split list below is the full set of shell-quote CONTROL operators
    // that can chain/separate distinct commands (verified against
    // shell-quote's own parse.js CONTROL regex: ||, &&, ;;, |&, &, ;, |).
    // Redirection operators (>, >>, <, <<<, <&, >&, <() ) are deliberately
    // excluded — they don't start a new command, they redirect the CURRENT
    // one. NOTE: this does NOT mean redirects are hard-blocked elsewhere.
    // analyzeBashCommand flags output redirection (>, >>, 2>) as a
    // promptable "medium" risk, but that is a UI confirmation prompt only —
    // it is skipped entirely in headless/non-interactive execution when the
    // `bash-guard-auto-allow` flag is set (the common subagent execution
    // path; see the tool_call handler below), and tokensToStrings here
    // strips redirect operators without them ever disqualifying a command
    // from the read-only exemption. So `cat payload > ~/.ssh/authorized_keys`
    // style commands are NOT hard-blocked by this protected-path check in
    // that mode. This is a pre-existing gap (predates this fix, and existed
    // identically in the old bare-regex classifier) — tracked as a separate
    // backlog item, not addressed here.
    //
    // "(" and ")" (subshell grouping) are also excluded from this list on
    // purpose: they're already stripped out of `args` by
    // tokensToStrings regardless of where a segment boundary falls, so a
    // segment like `(ls ~/.ssh)` still yields args === ["ls", "~/.ssh"] and
    // cmd === "ls" correctly — there is no args[0]-flattening bug for parens
    // themselves to close, once the real separators around them are split.
    //
    // NOT covered by this list — and not fixable by adding more operators to
    // it: command substitution (`$(...)`/backtick) and process substitution
    // (`<(...)`/`>(...)`). shell-quote flattens a substitution's inner tokens
    // into the SAME segment as the outer command without any boundary marker
    // distinguishing "nested inside a substitution" from "a sibling
    // top-level word" — e.g. `cat $(rm -rf ~/.ssh; echo /etc/hosts)` parses
    // to a token stream where the nested ";" looks identical to a top-level
    // one, splitting it produces a leading segment whose args[0] is still
    // "cat" (the OUTER command), and the embedded `rm -rf` never surfaces as
    // its own segment at all. This is a structurally different bug
    // (indistinguishable nesting depth, not a missing split token) that
    // splitOnOps genuinely cannot fix by adding more operators to its list.
    //
    // This is item #16, and it IS fixed now — just not here, and not via
    // splitOnOps. The fix lives one level up: the early
    // `extractSubstitutionSpans(command).length > 0` check at the top of
    // this function disqualifies the whole command from the read-only
    // exemption the moment ANY substitution syntax is present, before
    // shell-quote's flattening can ever hide a buried command inside it. That
    // whole-command-disqualification approach is deliberately coarser than a
    // token/segment-level fix would be — see the comment above that check for
    // the accepted trade-off this implies.
    const segments = splitOnOps(tokens, ["&&", ";", "|", "||", "&", ";;", "|&"]);
    if (segments.length === 0) return false;

    return segments.every(isReadOnlySegment);
}

// Checks whether a bash command textually references a given absolute path,
// in either its absolute or `~`-shorthand form.
export function commandReferencesPath(command: string, absolutePath: string): boolean {
    const tildeForm = absolutePath.replace(HOME, "~");
    return command.includes(absolutePath) || command.includes(tildeForm);
}

// Decides whether a bash command should be hard-blocked for referencing a
// PROTECTED_FOLDER_ENTRIES path, honoring each entry's own
// allowReadOnlyBashExemption flag (directories keep the original read-only
// exemption; the two single-file credential entries never get it — see the
// rationale comment above PROTECTED_FOLDER_ENTRIES). Returns the matching
// entry so the caller can build an accurate block reason, or null if the
// command isn't blocked by this check.
export function findBlockedProtectedFolderReference(
    command: string,
): ProtectedFolderEntry | null {
    for (const entry of PROTECTED_FOLDER_ENTRIES) {
        const isExempt =
            entry.allowReadOnlyBashExemption && isReadOnlyBashCommand(command);
        if (commandReferencesPath(command, entry.path) && !isExempt) {
            return entry;
        }
    }
    return null;
}

// ── Write-only protected files (block write/edit + mutating bash; reads allowed) ──
// Shell rc files and the user's global git config: blocking reads would break
// normal shell/git usage and introspection, but agents should never be able
// to silently rewrite a user's shell startup files or global git config
// (which applies across every repo on the machine, unlike a repo-local
// .git/config).
const PROTECTED_WRITE_ONLY_FILES = [
    `${HOME}/.bashrc`,
    `${HOME}/.zshrc`,
    `${HOME}/.bash_profile`,
    `${HOME}/.zprofile`,
    `${HOME}/.profile`,
    `${HOME}/.gitconfig`,
];

// Repo-relative git internals that must never be rewritten by an agent:
// hooks (arbitrary code execution on git operations) and config (git config
// can smuggle in dangerous settings like core.hooksPath, core.sshCommand,
// url.*.insteadOf, or alias.* — writes to the file are blocked outright
// rather than trying to parse individual mutations out of a command string).
// Case-insensitive: case-insensitive filesystems (macOS default, Windows)
// would otherwise let a differently-cased path (".GIT/hooks/...") slip through.
//
// Leading boundary: these patterns are applied both to resolved file-path
// arguments (Write/Edit tool calls, where `.git` only ever appears after a
// path separator or at the very start of the string) AND directly against
// raw bash command strings (`pattern.test(command)`, below). In a raw
// command, `.git/hooks` can just as easily be preceded by whitespace or a
// shell operator/redirect/quote — e.g. `echo x > .git/hooks/pre-commit` or
// `chmod +x .git/hooks/post-checkout` — where the character right before
// `.git` is a space or `>`, not `/` or start-of-string. Anchoring on
// `(^|\/)` alone silently never matches that (extremely common) shape.
// What the leading boundary actually needs to rule out is `.git` being a
// *suffix* of some other, unrelated identifier (e.g. a bare-repo directory
// literally named `myrepo.git`, where `.git` is part of that directory's
// own name rather than its own path segment) — not "must be exactly `/` or
// nothing". A negative lookbehind for a word/path character (letters,
// digits, underscore, dot, hyphen) captures that: it still excludes
// `myrepo.git/hooks`, but now also matches after whitespace, shell
// operators (`>`, `>>`, `|`, `;`, `&&`, `||`), and quotes, since none of
// those characters are in the excluded set.
export const PROTECTED_PATH_PATTERNS = [
    /(?<![\w.-])\.git\/hooks(\/|$)/i,
    /(?<![\w.-])\.git\/config(\.lock)?$/i,
];

// Resolves a filesystem path to its canonical real form, following symlinks,
// so a symlink pointing at a protected path can't be used to bypass literal
// path-string matching. Handles two distinct "doesn't fully exist" cases:
//
//   1. A path (or trailing segments of it) that simply doesn't exist yet —
//      e.g. a new file about to be created inside an existing directory.
//      `fs.realpathSync` throws ENOENT for this; we resolve the deepest
//      existing ancestor and rebuild the missing trailing segments on top
//      of it.
//   2. A symlink whose declared target doesn't (fully) exist yet — e.g. a
//      freshly created symlink at /tmp/x pointing at .git/hooks/newfile,
//      where newfile has never been created. `fs.realpathSync` ALSO throws
//      ENOENT here (it fails if any component of the final resolved path is
//      missing, even if the symlink itself exists), so it's not enough to
//      just walk up dirname() of the *original* input path — that never
//      follows the symlink and silently falls back to the symlink's own
//      location. Instead, when realpathSync fails we check via
//      `fs.lstatSync` whether the current path is itself a symlink, and if
//      so follow its declared target (via `fs.readlinkSync`, resolving
//      relative targets against the symlink's own containing directory)
//      before falling back to the "missing ancestor" walk. This is done
//      recursively (a symlink can point at another symlink), capped to
//      avoid spinning forever on a symlink cycle.
const MAX_SYMLINK_HOPS = 40;

function resolveRealPathBestEffort(filePath: string): string {
    let current = path.resolve(filePath);
    const missingSuffix: string[] = [];
    let hops = 0;
    while (true) {
        try {
            const real = fs.realpathSync(current);
            return missingSuffix.length
                ? path.join(real, ...missingSuffix.reverse())
                : real;
        } catch {
            let lst: fs.Stats | undefined;
            try {
                lst = fs.lstatSync(current);
            } catch {
                lst = undefined;
            }

            if (lst?.isSymbolicLink() && hops < MAX_SYMLINK_HOPS) {
                // `current` exists as a symlink but realpathSync couldn't
                // fully resolve it (its target doesn't exist yet, possibly
                // several hops down). Follow the link ourselves instead of
                // giving up and walking up the *symlink's own* location.
                hops++;
                const target = fs.readlinkSync(current);
                current = path.isAbsolute(target)
                    ? target
                    : path.join(path.dirname(current), target);
                continue;
            }

            // `current` doesn't exist at all (or isn't a symlink we can
            // follow further) — climb to the parent and retry, tracking the
            // missing trailing segment so it can be rebuilt on the deepest
            // existing (and now fully symlink-resolved) ancestor.
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(filePath); // reached root; nothing exists
            missingSuffix.push(path.basename(current));
            current = parent;
        }
    }
}

// Lower-cased once so the exact-string check below can be case-insensitive,
// matching the `i` flag already used on PROTECTED_PATH_PATTERNS. Rationale:
// on a case-insensitive filesystem (macOS default, Windows), `~/.BASHRC` and
// `~/.bashrc` are the SAME on-disk file — `resolveRealPathBestEffort` only
// normalizes case for path segments that already exist, so a *not-yet-created*
// rc file (e.g. an agent writing `~/.BASHRC` for the first time) would keep
// its caller-supplied case and slip past a case-sensitive `.includes()` check,
// even though the shell would still pick it up via case-insensitive lookup.
// On Linux (case-sensitive), this could in principle over-block a genuinely
// distinct, differently-cased file the user created on purpose — but for a
// "cannot be bypassed" guard on files whose entire purpose is arbitrary code
// execution on shell/git startup, an occasional over-cautious block is a far
// smaller cost than silently missing the real bypass on macOS/Windows.
const PROTECTED_WRITE_ONLY_FILES_LOWER = PROTECTED_WRITE_ONLY_FILES.map((f) => f.toLowerCase());

export function isProtectedWriteOnlyPath(filePath: string): boolean {
    const expanded = filePath.startsWith("~")
        ? filePath.replace(/^~/, HOME)
        : filePath;
    const resolved = resolveRealPathBestEffort(expanded);
    if (
        PROTECTED_WRITE_ONLY_FILES_LOWER.includes(expanded.toLowerCase()) ||
        PROTECTED_WRITE_ONLY_FILES_LOWER.includes(resolved.toLowerCase())
    ) {
        return true;
    }
    return PROTECTED_PATH_PATTERNS.some(
        (pattern) => pattern.test(expanded) || pattern.test(resolved),
    );
}

// ── Test File Protection ──────────────────────────────────────────────
// CRITICAL: Existing test files are immutable. If a test fails, fix the
// source code — never modify the test. New test files may be created.

let testGuardBypassed = false;

export const TEST_FILE_PATTERNS = [
	/\.test\.[tj]sx?$/,
	/\.spec\.[tj]sx?$/,
	/_test\.go$/,
	/test_[^/]*\.py$/,
	/\.test\.py$/,
	/__tests__\//,
];

export function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

export function testFileExists(filePath: string): boolean {
	try {
		return require("fs").existsSync(filePath);
	} catch {
		return false;
	}
}

export default function(pi: ExtensionAPI) {
    // ── Protected folders guard (applies to ALL contexts, non-bypassable) ──
    pi.on("tool_call", async (event) => {
        // Block write tool to protected folders
        if (isToolCallEventType("write", event)) {
            const path = event.input.path as string;
            if (path && isProtectedPath(path)) {
                return {
                    block: true,
                    reason:
                        `HARD BLOCKED: "${path}" is inside a protected folder. ` +
                        "These directories are completely off-limits: " +
                        PROTECTED_FOLDERS.join(", ") +
                        ". This cannot be bypassed.",
                };
            }
            if (path && isProtectedWriteOnlyPath(path)) {
                return {
                    block: true,
                    reason:
                        `HARD BLOCKED: "${path}" is a protected write-only file (shell rc file or git hooks/config). ` +
                        "Writes to this file are not permitted. This cannot be bypassed.",
                };
            }
        }

        // Block edit tool to protected folders
        if (isToolCallEventType("edit", event)) {
            const path = event.input.path as string;
            if (path && isProtectedPath(path)) {
                return {
                    block: true,
                    reason:
                        `HARD BLOCKED: "${path}" is inside a protected folder. ` +
                        "These directories are completely off-limits: " +
                        PROTECTED_FOLDERS.join(", ") +
                        ". This cannot be bypassed.",
                };
            }
            if (path && isProtectedWriteOnlyPath(path)) {
                return {
                    block: true,
                    reason:
                        `HARD BLOCKED: "${path}" is a protected write-only file (shell rc file or git hooks/config). ` +
                        "Edits to this file are not permitted. This cannot be bypassed.",
                };
            }
        }

        // Block read tool to protected folders
        if (isToolCallEventType("read", event)) {
            const path = event.input.path as string;
            if (path && isProtectedPath(path)) {
                return {
                    block: true,
                    reason:
                        `HARD BLOCKED: "${path}" is inside a protected folder. ` +
                        "These directories are completely off-limits (no read, no write): " +
                        PROTECTED_FOLDERS.join(", ") +
                        ". This cannot be bypassed.",
                };
            }
        }

        // Block bash commands that target protected folders
        //
        // KNOWN LIMITATION (accepted, documented residual risk — applies to both loops
        // below: the PROTECTED_FOLDERS loop here and the PROTECTED_WRITE_ONLY_FILES /
        // PROTECTED_PATH_PATTERNS loop further down):
        //
        // `commandReferencesPath` is a best-effort TEXTUAL heuristic — a plain substring
        // check of the raw bash command string against each protected path. It is NOT a
        // hard guarantee like the Write/Edit tool-call checks above, which receive an
        // already-resolved path argument and run it through `resolveRealPathBestEffort`
        // (symlink-aware, including symlinks whose target doesn't exist yet). This bash
        // leg does none of that: it does not resolve symlinks, shell variable/tilde
        // expansion ($HOME, ~ beyond the one literal substitution below), or path
        // indirection via `cd`. Concretely, `cd <dir> && ln -s auth.json /tmp/x` (splits
        // the literal path across a `cd`) or `ln -s "$HOME/.pi/agent/auth.json" /tmp/x2`
        // (uses the $HOME variable rather than the literal expanded string) defeat this
        // check entirely, with no adversarial cleverness required.
        //
        // Genuinely closing this class of gap would require either full shell-semantics
        // simulation (tried and abandoned for a related git-config-mutation detector
        // earlier in this same effort, after repeated review rounds kept finding new
        // bypasses) or OS-level filesystem sandboxing (a separate, larger, explicitly
        // deferred effort) — both out of scope here. The Write/Edit tool-call path
        // remains the primary, reliable enforcement mechanism for file-level protection
        // and is not affected by this limitation; this bash-side check is a secondary,
        // best-effort layer, consistent with the existing READ_ONLY_CMDS /
        // compound-command-bypass trade-off already documented for this same mechanism.
        if (isToolCallEventType("bash", event)) {
            const command = event.input.command as string;
            const blockedEntry = findBlockedProtectedFolderReference(command);
            if (blockedEntry) {
                return {
                    block: true,
                    reason: blockedEntry.allowReadOnlyBashExemption
                        ? `HARD BLOCKED: command references protected folder "${blockedEntry.path}". ` +
                          "These directories are completely off-limits for write operations. " +
                          "This cannot be bypassed."
                        : `HARD BLOCKED: command references protected file "${blockedEntry.path}". ` +
                          "This file is completely off-limits, including reads. " +
                          "This cannot be bypassed.",
                };
            }

            // Block bash commands that mutate protected write-only files
            // (shell rc files, .git/hooks, .git/config).
            // Same best-effort textual-heuristic limitation applies here as documented
            // above the PROTECTED_FOLDERS loop (no symlink/`$HOME`/`~`/`cd`-indirection
            // resolution) — see that comment for the full rationale and scope.
            if (!isReadOnlyBashCommand(command)) {
                for (const file of PROTECTED_WRITE_ONLY_FILES) {
                    if (commandReferencesPath(command, file)) {
                        return {
                            block: true,
                            reason:
                                `HARD BLOCKED: command references protected write-only file "${file}". ` +
                                "This cannot be bypassed.",
                        };
                    }
                }
                for (const pattern of PROTECTED_PATH_PATTERNS) {
                    if (pattern.test(command)) {
                        return {
                            block: true,
                            reason:
                                "HARD BLOCKED: command references a protected git internal path " +
                                "(.git/hooks or .git/config). This cannot be bypassed.",
                        };
                    }
                }
            }
        }
    });

    // ── Test file immutability guard (applies to ALL contexts) ──────────
    pi.on("tool_call", async (event) => {
        if (testGuardBypassed) return;

        // Guard write tool — block overwriting existing test files
        if (isToolCallEventType("write", event)) {
            const path = event.input.path as string;
            if (path && isTestFile(path) && testFileExists(path)) {
                return {
                    block: true,
                    reason:
                        `Blocked by bash-guard: "${path}" is an existing test file. ` +
                        "Test files are IMMUTABLE — if a test fails, fix the source code, not the test. " +
                        "Only the user can authorize changes to existing tests.",
                };
            }
        }

        // Guard edit tool — block editing existing test files
        if (isToolCallEventType("edit", event)) {
            const path = event.input.path as string;
            if (path && isTestFile(path)) {
                return {
                    block: true,
                    reason:
                        `Blocked by bash-guard: "${path}" is an existing test file. ` +
                        "Test files are IMMUTABLE — if a test fails, fix the source code, not the test. " +
                        "Only the user can authorize changes to existing tests.",
                };
            }
        }
    });

    if (_isSubagent) {
        // Subagent mode: hard-block catastrophic operations, no prompting.
        pi.on("tool_call", async (event) => {
            if (!isToolCallEventType("bash", event)) return;
            const command = event.input.command;
            for (const { pattern, reason } of HEADLESS_BLOCKED) {
                if (pattern.test(command)) {
                    return {
                        block: true,
                        reason:
                            `Blocked by bash-guard: ${reason}. ` +
                            "This is a non-interactive subagent session — catastrophic operations are not permitted. " +
                            "Propose a safer alternative or ask the parent agent to confirm with the user.",
                    };
                }
            }
        });
        return;
    }

    // Main session mode: interactive prompting.
    pi.registerFlag("bash-guard-auto-allow", {
        description:
            "If set, bash-guard will not block when no UI is available (non-interactive modes).",
        type: "boolean",
        default: false,
    });

    // Avoid annoying retry loops: if the exact command was aborted recently, auto-block it.
    const recentlyAborted = new Map<string, number>();
    const ABORT_REMEMBER_MS = 60_000;

    // Toggle test-file guard bypass
    pi.registerCommand("test-guard", {
        description: "Toggle test file immutability guard (allows editing existing tests when bypassed)",
        handler: async (_args, ctx) => {
            testGuardBypassed = !testGuardBypassed;
            if (testGuardBypassed) {
                ctx.ui.notify(
                    "⚠️  Test guard BYPASSED — agents can now modify existing test files. Run /test-guard again to re-enable.",
                    "warning",
                );
            } else {
                ctx.ui.notify(
                    "✅ Test guard ACTIVE — existing test files are immutable.",
                    "success",
                );
            }
        },
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!isToolCallEventType("bash", event)) return;

        const command = event.input.command;
        const risk = analyzeBashCommand(command);
        if (!risk) return;

        const now = Date.now();
        // Prune expired entries to prevent unbounded map growth
        for (const [k, t] of recentlyAborted) {
            if (now - t >= ABORT_REMEMBER_MS) recentlyAborted.delete(k);
        }
        const lastAbort = recentlyAborted.get(command);
        if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
            return {
                block: true,
                reason: "Blocked by bash-guard: command was already aborted recently. Ask the user for a safer alternative; do not retry the same command.",
            };
        }

        if (!ctx.hasUI && pi.getFlag("bash-guard-auto-allow")) {
            // Non-interactive mode: allow when explicitly requested.
            return;
        }

        const choice = await promptRunOrAbort(ctx, command, risk);
        if (choice === "run") return;

        recentlyAborted.set(command, now);
        return {
            block: true,
            reason: "Blocked by user via bash-guard (potentially destructive command). Ask the user for confirmation or propose a non-destructive alternative.",
        };
    });
}
