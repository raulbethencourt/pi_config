/**
 * Coordination extension: per-file locking + a shared task list for
 * concurrently-dispatched pi subagents.
 *
 * Loaded only into subagent child processes (never the interactive main
 * session) — see README.md for why. The default export wires `write`/`edit`
 * tool calls to the lock primitives below; `acquireLocksForPaths` and
 * `pruneStaleSessions` are also exported standalone so they're independently
 * unit-testable without spinning up a full extension host.
 */
import * as fs from "node:fs";
import type { EditToolCallEvent, ExtensionAPI, ToolCallEvent, WriteToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { extractPathsFromEditInput, resolveAbsolutePath } from "../shared/hashline-paths.ts";
import { acquireLock, releaseLocksForToolCall, type LockHolder } from "./lock-store.ts";
import { canonicalizePath, isSessionStale, listSessionDirs, resolveCoordinationDir } from "./session-dir.ts";

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_BACKOFF_MS = 100;

export interface AcquireLocksForPathsParams {
	canonicalPaths: string[];
	sessionDir: string;
	pid: number;
	agentName: string;
	toolCallId: string;
	maxAttempts?: number;
	backoffMs?: number;
}

export interface AcquireLocksForPathsResult {
	acquired: boolean;
	conflictPath?: string;
	heldBy?: LockHolder;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquires locks for several canonical paths from one tool call atomically:
 * sorts them lexicographically (a fixed order across all callers prevents
 * cross-call deadlocks when two multi-file edits share some of the same
 * files), then acquires each in that order with a bounded retry/backoff. If
 * any acquisition in the sequence fails after exhausting retries, every lock
 * already acquired earlier in this same call is rolled back before returning
 * failure — no partial lock state survives a failed multi-file acquisition.
 */
export async function acquireLocksForPaths(
	params: AcquireLocksForPathsParams,
): Promise<AcquireLocksForPathsResult> {
	const {
		canonicalPaths,
		sessionDir,
		pid,
		agentName,
		toolCallId,
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		backoffMs = DEFAULT_BACKOFF_MS,
	} = params;

	const sortedPaths = [...canonicalPaths].sort();

	for (const canonicalPath of sortedPaths) {
		let heldBy: LockHolder | undefined;
		let granted = false;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const result = await acquireLock({ canonicalPath, sessionDir, pid, agentName, toolCallId });
			if (result.acquired) {
				granted = true;
				break;
			}
			heldBy = result.heldBy;
			if (attempt < maxAttempts - 1) {
				await sleep(backoffMs);
			}
		}

		if (!granted) {
			// Every lock this toolCallId acquired earlier in THIS call belongs to
			// it and only it (a fresh toolCallId per atomic acquisition), so
			// releasing by toolCallId rolls back exactly that partial state.
			releaseLocksForToolCall(toolCallId);
			return { acquired: false, conflictPath: canonicalPath, heldBy };
		}
	}

	return { acquired: true };
}

/**
 * Removes every session directory whose leading pid segment is dead. Dead-pid
 * detection only — no TTL/file-age trigger, ever (see README.md).
 */
export function pruneStaleSessions(): { removed: string[] } {
	const removed: string[] = [];

	for (const dirName of listSessionDirs()) {
		if (!isSessionStale(dirName)) continue;
		try {
			fs.rmSync(resolveCoordinationDir(dirName), { recursive: true, force: true });
			removed.push(dirName);
		} catch {
			// Best-effort — leave it for a future prune attempt.
		}
	}

	return { removed };
}

function lockConflictReason(path: string, heldBy: LockHolder | undefined): string {
	const holderDesc = heldBy ? `${heldBy.agentName} (pid ${heldBy.pid})` : "another agent";
	return `${path} is locked by ${holderDesc} — wait for it to finish or narrow scope so only one agent edits this file.`;
}

function resolveWriteTargetPaths(event: WriteToolCallEvent, cwd: string): string[] {
	const rawPath = typeof event.input?.path === "string" ? event.input.path : "";
	const absolutePath = resolveAbsolutePath(rawPath, cwd);
	return absolutePath ? [absolutePath] : [];
}

function resolveEditTargetPaths(event: EditToolCallEvent, cwd: string): string[] {
	const input = event.input as unknown;
	const editInput = typeof input === "string"
		? input
		: typeof (input as { input?: unknown })?.input === "string"
			? (input as { input: string }).input
			: "";
	return extractPathsFromEditInput(editInput, cwd);
}

export default function coordination(pi: ExtensionAPI): void {
	const sessionId = process.env.PI_COORDINATION_SESSION_ID;
	const agentName = process.env.PI_SUBAGENT_NAME || "subagent";
	if (!sessionId) return; // no coordination session to guard against — no-op

	const sessionDir = resolveCoordinationDir(sessionId);

	pi.on("tool_call", async (event: ToolCallEvent) => {
		const cwd = process.cwd();
		let rawPaths: string[];
		if (isToolCallEventType("write", event)) {
			rawPaths = resolveWriteTargetPaths(event, cwd);
		} else if (isToolCallEventType("edit", event)) {
			rawPaths = resolveEditTargetPaths(event, cwd);
		} else {
			return;
		}
		if (rawPaths.length === 0) return;

		const canonicalPaths = await Promise.all(rawPaths.map((p) => canonicalizePath(p)));

		const result = await acquireLocksForPaths({
			canonicalPaths,
			sessionDir,
			pid: process.pid,
			agentName,
			toolCallId: event.toolCallId,
		});

		if (!result.acquired) {
			return {
				block: true,
				reason: lockConflictReason(result.conflictPath ?? rawPaths[0], result.heldBy),
			};
		}
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		releaseLocksForToolCall(event.toolCallId);
	});
}
