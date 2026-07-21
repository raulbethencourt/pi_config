/**
 * Per-file lock primitive shared across coordination consumers (the
 * write/edit tool_call guard in index.ts, and tasks.ts's tasks.json guard).
 *
 * On-disk atomic exclusive creation (`fs.promises.open(lockPath, "wx")`) is
 * the actual mutual-exclusion mechanism, since siblings are separate OS
 * processes and no in-memory-only locking is visible across them. An
 * in-process `Map` layers reentrancy on top so repeated acquisitions by the
 * SAME pid (e.g. two tool calls in the same subagent process touching the
 * same file before the first one's lock is released) are free.
 *
 * Reap model: dead-pid-only. A lock is only ever stolen when
 * `process.kill(holderPid, 0)` throws (ESRCH) — never based on file age or
 * elapsed time. See the extension README for the full rationale.
 *
 * The reap-mutex file (`${lockPath}.reap-mutex`) that serializes the actual
 * reap step is intentionally NOT itself reaped by any liveness check: it is
 * only ever cleared by whichever racer created it. If its creator crashes
 * mid-reap, the mutex is permanently orphaned and that one canonical path
 * stays contended forever — an accepted fail-safe tradeoff over the
 * alternative (a liveness-based auto-clear, which reintroduces the very
 * double-acquire race this mutex exists to prevent). See README.md's known
 * limitations.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LockHolder {
	pid: number;
	agentName: string;
}

export interface AcquireLockParams {
	canonicalPath: string;
	sessionDir: string;
	pid: number;
	agentName: string;
	toolCallId: string;
}

export interface AcquireLockResult {
	acquired: boolean;
	heldBy?: LockHolder;
}

interface InProcessHolder extends LockHolder {
	toolCallIds: Set<string>;
}

// canonicalPath -> current in-process holder (only reflects acquisitions made
// through this same process's calls to acquireLock; genuinely cross-process
// contention is always resolved via the on-disk lock file).
const inProcessLocks = new Map<string, InProcessHolder>();

// toolCallId -> canonicalPath -> sessionDir, so releaseLocksForToolCall can
// find every on-disk lock file a given tool call is holding without the
// caller having to remember the set itself.
const toolCallPaths = new Map<string, Map<string, string>>();

function recordToolCallPath(toolCallId: string, canonicalPath: string, sessionDir: string): void {
	let paths = toolCallPaths.get(toolCallId);
	if (!paths) {
		paths = new Map();
		toolCallPaths.set(toolCallId, paths);
	}
	paths.set(canonicalPath, sessionDir);
}

/**
 * Deterministic, filesystem-safe on-disk lock file location for a given
 * canonical path within a session's coordination directory. Deliberately a
 * content hash (not a sanitized literal path) — callers only need presence/
 * absence to be independently checkable, not a human-readable filename.
 */
export function lockPathFor(sessionDir: string, canonicalPath: string): string {
	const hash = crypto.createHash("sha256").update(canonicalPath).digest("hex");
	return path.join(sessionDir, "locks", `${hash}.lock`);
}

/**
 * Only `ESRCH` (no such process) means the pid is actually dead. Any other
 * thrown error — most notably `EPERM`, which means the process exists but
 * this caller lacks permission to signal it — is ambiguous, and the safe
 * default is to assume alive: incorrectly treating a live process as dead is
 * exactly the failure mode reaping guards against.
 */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
		console.error(
			`[coordination] process.kill(${pid}, 0) failed with an ambiguous error; assuming alive:`,
			err,
		);
		return true;
	}
}

/**
 * Reads a lock file's holder content, tolerating a missing/unreadable file
 * (returns undefined rather than throwing).
 */
function readLockFile(lockPath: string): LockHolder | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockHolder>;
		if (typeof parsed.pid !== "number" || typeof parsed.agentName !== "string") return undefined;
		return { pid: parsed.pid, agentName: parsed.agentName };
	} catch {
		return undefined;
	}
}

/** Reads a file's raw content, tolerating a missing file (returns undefined). */
function readOptionalFile(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

/**
 * Single-shot, non-blocking lock acquisition attempt for one file. Grants
 * immediately when nobody holds the lock, when the same pid already holds it
 * (reentrant, zero disk I/O), or when the recorded holder pid is dead
 * (reaped). Otherwise reports contention via `heldBy`. Retry/backoff across
 * multiple attempts is the caller's responsibility (see index.ts's
 * `acquireLocksForPaths`), not this function's.
 */
export async function acquireLock(params: AcquireLockParams): Promise<AcquireLockResult> {
	const { canonicalPath, sessionDir, pid, agentName, toolCallId } = params;

	const existing = inProcessLocks.get(canonicalPath);
	if (existing && existing.pid === pid) {
		existing.toolCallIds.add(toolCallId);
		recordToolCallPath(toolCallId, canonicalPath, sessionDir);
		return { acquired: true };
	}

	const lockPath = lockPathFor(sessionDir, canonicalPath);
	await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });

	// Bounds how many times this single acquireLock call will spin-retry while
	// someone else holds the reap-mutex (see below) before giving up and
	// reporting contention to the caller. A live in-progress reap is expected
	// to finish in a handful of fast, synchronous syscalls, so this resolves
	// almost immediately in the common case; it exists purely so a reap-mutex
	// that's permanently orphaned (its creator crashed mid-reap and nothing
	// ever clears it) can't spin this call forever — it must still return in
	// bounded time and let the CALLER's own retry/backoff loop decide whether
	// to try again later.
	const MAX_REAP_MUTEX_CONTENTION_RETRIES = 1000;
	let reapMutexContentionRetries = 0;

	for (;;) {
		try {
			const handle = await fs.promises.open(lockPath, "wx");
			try {
				await handle.writeFile(JSON.stringify({ pid, agentName, toolCallId, acquiredAt: Date.now() }), "utf8");
			} finally {
				await handle.close();
			}
			inProcessLocks.set(canonicalPath, { pid, agentName, toolCallIds: new Set([toolCallId]) });
			recordToolCallPath(toolCallId, canonicalPath, sessionDir);
			return { acquired: true };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

			const holder = readLockFile(lockPath);
			if (!holder) {
				// Lock file vanished between our EEXIST and reading it (released
				// concurrently) — retry the exclusive create.
				continue;
			}

			if (isProcessAlive(holder.pid)) {
				return { acquired: false, heldBy: holder };
			}

			// Recorded holder pid is dead — the only reap trigger. The actual
			// unlink+recreate is NOT safe to perform optimistically and verify
			// afterward: an unlink() is unconditional (it removes whatever
			// currently occupies the path, stale or not), a naive rename-onto is
			// equally unconditional, and even a rename-FROM-plus-inode-freshness-
			// check is unsound in practice — the moment one racer's rejected
			// attempt unlinks its own temp copy, the filesystem can immediately
			// recycle that exact inode number for a completely different,
			// legitimately-live lock, defeating an inode-equality check (verified
			// empirically: this specific approach was tried and still produced
			// double/triple acquires under six-way concurrent reap contention).
			//
			// Instead, reaping itself is serialized behind a second lock file —
			// `${lockPath}.reap-mutex` — created via the SAME proven atomic
			// primitive as the main lock (`open(path, "wx")`). At most one racer
			// can ever hold this mutex at a time, so at most one racer is ever
			// mid-reap for this path at once; every other racer that loses the
			// mutex race reports ordinary contention and defers to the caller's
			// own retry/backoff loop, rather than attempting its own concurrent
			// unlink/recreate. The actual reap+reclaim while holding the mutex is
			// a plain, fully synchronous unlink-then-retry — safe now because
			// nothing else can be doing the same thing at the same time.
			const reapMutexPath = `${lockPath}.reap-mutex`;
			let mutexFd: number;
			try {
				mutexFd = fs.openSync(reapMutexPath, "wx");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

				// Someone else already holds the reap-mutex for this exact path.
				// Deliberately NOT auto-recovered here, even when the mutex's own
				// recorded holder pid looks dead: an unconditional unlink based on
				// a liveness read of the mutex file's content is exactly the bug
				// this mutex exists to prevent one layer up (the original
				// stale-lock bug), just reapplied to the mutex itself. Two racers
				// can both read the same dead-pid mutex holder, both race to
				// unlink+recreate it, and both end up believing they hold "the"
				// mutex at once — reproducing the exact double-acquire the mutex
				// was built to prevent (see coordination-lock-store.test.ts's
				// "reaper crashes mid-reap" regression test).
				//
				// While under the internal retry budget, just retry the whole
				// loop: if the mutex holder is actively reaping (the common case),
				// it finishes in a handful of fast syscalls, so the very next
				// iteration will either see this call's own exclusive create
				// succeed (the slot was momentarily vacant) or see the mutex
				// holder's freshly-recreated, live lock (accurately reported as
				// contention against ITS holder, not a stale snapshot).
				if (reapMutexContentionRetries < MAX_REAP_MUTEX_CONTENTION_RETRIES) {
					reapMutexContentionRetries++;
					continue;
				}

				// Retry budget exhausted — the mutex is either contended for an
				// unusually long time or, rarer, genuinely orphaned (its creator
				// crashed mid-reap and nothing ever removes it). Report ordinary
				// contention against the freshest available read of the main lock
				// and let the caller's own retry/backoff loop (acquireLocksForPaths
				// in index.ts) try again later, rather than spinning here forever.
				// If the mutex truly never clears, this exact path stays
				// permanently contended/unavailable — a deliberate fail-safe
				// tradeoff (deny forever beats a silent double-grant), documented
				// as a known limitation in README.md.
				const mutexHolderPid = Number(readOptionalFile(reapMutexPath));
				// Explicit `> 0` guard rather than relying on `Number.isInteger`
				// (which accepts 0) or `Number("") === 0` coercion — pid 0 has
				// special, non-per-process semantics to `process.kill`, so an
				// empty/unreadable mutex content must never be treated as a real
				// pid to signal-check.
				if (mutexHolderPid > 0 && !isProcessAlive(mutexHolderPid)) {
					console.error(
						`[coordination] reap-mutex ${reapMutexPath} appears orphaned (recorded holder pid ${mutexHolderPid} is dead) after ${MAX_REAP_MUTEX_CONTENTION_RETRIES} retries; NOT auto-clearing it — this path stays contended until it's cleared some other way`,
					);
				}
				return { acquired: false, heldBy: readLockFile(lockPath) ?? holder };
			}

			try {
				try {
					fs.writeSync(mutexFd, String(process.pid), 0, "utf8");
				} finally {
					fs.closeSync(mutexFd);
				}

				// Re-check under the mutex: only unlink if the holder recorded
				// right now is still dead. Nothing else can be racing this
				// specific unlink while we hold the mutex.
				const current = readLockFile(lockPath);
				if (current && !isProcessAlive(current.pid)) {
					fs.unlinkSync(lockPath);
				}
			} finally {
				try {
					fs.unlinkSync(reapMutexPath);
				} catch {
					// Already gone — nothing left to clean up.
				}
			}
			// Retry the ordinary exclusive create now that the stale entry is
			// gone (or, if it turned out to already be alive again, correctly
			// re-observe that on the next iteration instead).
		}
	}
}

/**
 * Releases every lock the given toolCallId currently holds (decrementing each
 * path's in-process refcount; the on-disk lock file is deleted only once a
 * path's refcount reaches zero). Safe to call even if the toolCallId holds no
 * locks.
 */
export function releaseLocksForToolCall(toolCallId: string): void {
	const paths = toolCallPaths.get(toolCallId);
	if (!paths) return;

	for (const [canonicalPath, sessionDir] of paths) {
		const holder = inProcessLocks.get(canonicalPath);
		if (!holder) continue;

		holder.toolCallIds.delete(toolCallId);
		if (holder.toolCallIds.size === 0) {
			inProcessLocks.delete(canonicalPath);
			try {
				fs.unlinkSync(lockPathFor(sessionDir, canonicalPath));
			} catch {
				// Already gone — nothing left to clean up.
			}
		}
	}

	toolCallPaths.delete(toolCallId);
}
