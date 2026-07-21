/**
 * Coordination session directory resolution + canonical path helpers.
 *
 * A "coordination session" is one top-level `pi` process invocation. Its
 * session id (`<pid>-<timestamp>`, minted once in `extensions/subagents/index.ts`)
 * is threaded into every spawned subagent child via the `PI_COORDINATION_SESSION_ID`
 * env var, so all siblings share the same on-disk directory under
 * `~/.pi/agent/state/coordination/<sessionId>/`.
 *
 * `os.homedir()` is called at use-time (never cached at module scope) so tests
 * can mock it per-run via `vi.doMock("node:os", ...)` + `vi.resetModules()`.
 */
import * as fs from "node:fs";
import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function coordinationRoot(): string {
	return path.join(os.homedir(), ".pi", "agent", "state", "coordination");
}

export function resolveCoordinationDir(sessionId: string): string {
	return path.join(coordinationRoot(), sessionId);
}

/**
 * Mints a new coordination session id (`<pid>-<timestamp>`), one per
 * top-level process that hosts subagent dispatch (the interactive
 * `subagents/index.ts` entry point, and the standalone `mcp-server`
 * extension's `build-args.ts` reuse path). Each caller mints its own id once
 * at module load and threads it into every spawned subagent child via
 * `PI_COORDINATION_SESSION_ID`, so siblings of the *same* top-level process
 * share one on-disk lock/tasks directory.
 */
export function mintCoordinationSessionId(): string {
	return `${process.pid}-${Date.now()}`;
}

/**
 * Resolves `absolutePath` to a canonical, symlink-resolved form so that two
 * different path strings pointing at the same underlying file map to the same
 * lock key.
 *
 *   1. If the path itself exists, realpath it directly.
 *   2. Otherwise (a not-yet-existing `write` target), realpath its parent
 *      directory and rejoin the original basename.
 *   3. If even the parent directory can't be resolved, fall back to a plain
 *      `path.resolve` — no canonicalization is possible.
 */
export async function canonicalizePath(absolutePath: string): Promise<string> {
	try {
		return await realpath(absolutePath);
	} catch {
		// fall through to the parent-directory fallback below
	}

	const parent = path.dirname(absolutePath);
	const base = path.basename(absolutePath);
	try {
		const realParent = await realpath(parent);
		return path.join(realParent, base);
	} catch {
		return path.resolve(absolutePath);
	}
}

export function listSessionDirs(): string[] {
	try {
		return fs
			.readdirSync(coordinationRoot(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

const SESSION_DIR_PID_RE = /^(\d+)-/;

/**
 * A session dir is named `<pid>-<timestamp>`. It's stale iff the leading pid
 * segment no longer refers to a live process — the only reap trigger, no TTL.
 *
 * Only `ESRCH` means the pid is actually dead. Any other thrown error (e.g.
 * `EPERM`, meaning the process exists but this caller can't signal it) is
 * ambiguous, and the safe default is to assume alive rather than prune a
 * live session's directory out from under it.
 */
export function isSessionStale(dirName: string): boolean {
	const match = SESSION_DIR_PID_RE.exec(dirName);
	if (!match) return false;

	const pid = Number(match[1]);
	if (!Number.isFinite(pid)) return false;

	try {
		process.kill(pid, 0);
		return false; // alive
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return true; // dead

		console.error(
			`[coordination] process.kill(${pid}, 0) failed with an ambiguous error; assuming alive:`,
			err,
		);
		return false;
	}
}
