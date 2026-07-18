/**
 * Bridges the pipeline's generic `Dispatcher` interface onto the real
 * subagents extension, via the `globalThis.__pi_subagents` bridge object
 * that `agent/extensions/subagents/index.ts` sets up at module-eval time.
 *
 * Kept separate from `index.ts` so the pipeline's control flow (in
 * `index.ts`) can be unit-tested against a fake `Dispatcher` without ever
 * touching the real subagent-spawning machinery.
 */
import type { AgentConfig, AgentProgress, AgentResult } from "../subagents/index.ts";

export interface DispatchResult {
	output: string;
	failed: boolean;
	error?: string;
}

export type Dispatcher = (
	agent: string,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: ((progress: AgentProgress) => void) | undefined,
) => Promise<DispatchResult>;

interface SubagentsBridge {
	registerAgent: (config: AgentConfig) => void;
	unregisterAgent: (name: string) => void;
	getAgents: () => AgentConfig[];
	runSubagent?: (
		agent: AgentConfig,
		task: string,
		cwd: string,
		signal: AbortSignal | undefined,
		onUpdate?: (progress: AgentProgress) => void,
	) => Promise<AgentResult>;
}

function getSubagentsBridge(): SubagentsBridge {
	const bridge = (globalThis as any).__pi_subagents as SubagentsBridge | undefined;
	if (!bridge || typeof bridge.runSubagent !== "function") {
		throw new Error(
			"pipeline: globalThis.__pi_subagents is missing runSubagent — the subagents extension " +
				"must be loaded (and loaded before pipeline) so its runSubagent bridge entry is available.",
		);
	}
	return bridge;
}

/**
 * Builds a real Dispatcher backed by the subagents extension's runSubagent.
 * Throws immediately (not lazily, on first dispatch) if the subagents
 * extension's bridge object isn't present or doesn't expose runSubagent, so
 * misconfiguration is caught at pipeline-setup time rather than mid-run.
 */
export function makeRealDispatcher(): Dispatcher {
	const bridge = getSubagentsBridge();

	return async (agent, task, cwd, signal, onProgress) => {
		const agentConfig = bridge.getAgents().find((a) => a.name === agent);
		if (!agentConfig) {
			const available = bridge.getAgents().map((a) => a.name).join(", ") || "none";
			return { output: "", failed: true, error: `pipeline: unknown agent "${agent}". Available agents: ${available}` };
		}

		const result = await bridge.runSubagent!(agentConfig, task, cwd, signal, onProgress);
		const failed = result.exitCode !== 0 || !!result.progress?.error;
		return {
			output: result.output || "",
			failed,
			error: failed ? (result.progress?.error || `${agent} exited with code ${result.exitCode}`) : undefined,
		};
	};
}
