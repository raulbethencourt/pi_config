/**
 * Concurrency control for the MCP server: caps how many pi subprocesses
 * can run at once across all 6 persona tools combined.
 */

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 16;
const DEFAULT_MAX_CONCURRENCY = 4; // matches subagents/index.ts's DEFAULT_MAX_CONCURRENCY

/** Simple counting semaphore for bounding concurrent pi subprocess spawns. */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(max: number) {
		this.available = max;
	}

	async acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
		} else {
			this.available++;
		}
	}
}

/**
 * Resolve the max-concurrency setting from PI_MCP_SERVER_MAX_CONCURRENCY,
 * clamped to [1, 16], defaulting to 4. Logs a startup warning to stderr
 * when the env var is unset, non-numeric, or out of range.
 */
export function resolveMaxConcurrency(): number {
	const raw = process.env.PI_MCP_SERVER_MAX_CONCURRENCY;

	if (raw === undefined) {
		console.error(
			`[mcp-server] PI_MCP_SERVER_MAX_CONCURRENCY is unset; defaulting to ${DEFAULT_MAX_CONCURRENCY}.`,
		);
		return DEFAULT_MAX_CONCURRENCY;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		console.error(
			`[mcp-server] PI_MCP_SERVER_MAX_CONCURRENCY="${raw}" is not a valid integer; defaulting to ${DEFAULT_MAX_CONCURRENCY}.`,
		);
		return DEFAULT_MAX_CONCURRENCY;
	}

	if (parsed < MIN_CONCURRENCY || parsed > MAX_CONCURRENCY) {
		console.error(
			`[mcp-server] PI_MCP_SERVER_MAX_CONCURRENCY=${parsed} is out of range [${MIN_CONCURRENCY}, ${MAX_CONCURRENCY}]; defaulting to ${DEFAULT_MAX_CONCURRENCY}.`,
		);
		return DEFAULT_MAX_CONCURRENCY;
	}

	return parsed;
}
