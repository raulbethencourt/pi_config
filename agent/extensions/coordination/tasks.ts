/**
 * Shared `tasks.json` task list, one per coordination session directory.
 *
 * Every read-modify-write cycle (upsertTask) and every plain write (writeTasks)
 * is guarded by a lock on `<sessionDir>/tasks.json.lock`, acquired/released
 * through lock-store.ts's `acquireLock`/`releaseLocksForToolCall` — the same
 * cross-process primitive used for file-edit coordination, not a second,
 * bespoke locking mechanism. `tasks.json.lock` here is only ever used as an
 * opaque lock key passed to `acquireLock`; no file is ever written at that
 * literal path.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock, releaseLocksForToolCall } from "./lock-store.ts";

export interface Task {
	id: string;
	[key: string]: unknown;
}

const LOCK_MAX_ATTEMPTS = 50;
const LOCK_BACKOFF_MS = 20;

function tasksFilePath(sessionDir: string): string {
	return path.join(sessionDir, "tasks.json");
}

function tasksLockCanonicalPath(sessionDir: string): string {
	return path.join(sessionDir, "tasks.json.lock");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTasksLock<T>(sessionDir: string, fn: () => Promise<T>): Promise<T> {
	const canonicalPath = tasksLockCanonicalPath(sessionDir);
	const toolCallId = `coordination-tasks-${process.pid}-${crypto.randomUUID()}`;

	let heldBy: { pid: number; agentName: string } | undefined;
	let acquired = false;
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		const result = await acquireLock({
			canonicalPath,
			sessionDir,
			pid: process.pid,
			agentName: "coordination-tasks",
			toolCallId,
		});
		if (result.acquired) {
			acquired = true;
			break;
		}
		heldBy = result.heldBy;
		await sleep(LOCK_BACKOFF_MS);
	}

	if (!acquired) {
		throw new Error(
			`tasks.json.lock is held by ${heldBy?.agentName ?? "unknown"} (pid ${heldBy?.pid ?? "?"}) and could not be acquired`,
		);
	}

	try {
		return await fn();
	} finally {
		releaseLocksForToolCall(toolCallId);
	}
}

async function readTasksUnguarded(sessionDir: string): Promise<Task[]> {
	try {
		const raw = await fs.promises.readFile(tasksFilePath(sessionDir), "utf8");
		if (!raw.trim()) return [];
		return JSON.parse(raw) as Task[];
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

/** Missing/empty tasks.json reads as an empty array, never throws. */
export async function readTasks(sessionDir: string): Promise<Task[]> {
	return readTasksUnguarded(sessionDir);
}

export async function writeTasks(sessionDir: string, tasks: Task[]): Promise<void> {
	await withTasksLock(sessionDir, async () => {
		await fs.promises.mkdir(sessionDir, { recursive: true });
		await fs.promises.writeFile(tasksFilePath(sessionDir), JSON.stringify(tasks, null, 2), "utf8");
	});
}

/**
 * Inserts `task` if no existing entry shares its `id`, otherwise updates that
 * entry in place, leaving all others untouched. Returns the full updated list.
 */
export async function upsertTask(sessionDir: string, task: Task): Promise<Task[]> {
	return withTasksLock(sessionDir, async () => {
		const existing = await readTasksUnguarded(sessionDir);
		const index = existing.findIndex((t) => t.id === task.id);
		const updated = index === -1 ? [...existing, task] : existing.map((t, i) => (i === index ? task : t));

		await fs.promises.mkdir(sessionDir, { recursive: true });
		await fs.promises.writeFile(tasksFilePath(sessionDir), JSON.stringify(updated, null, 2), "utf8");
		return updated;
	});
}
