/**
 * Pipeline extension.
 *
 * Packages the scout -> planner -> critic -> worker -> codereviewer sequence
 * (already documented in SKILL_REFERENCE.md and manually re-issued today via
 * repeated `subagent` tool calls) into one scripted command: a single
 * `pipeline` tool that runs the whole sequence, including the
 * PROCEED/REVISE/BLOCK planning gate and the APPROVE/REJECT review-retry
 * loop, and reports back a single terminal status.
 *
 * `runPipeline` itself takes an injected `Dispatcher` so it can be unit
 * tested with a fake dispatcher (see agent/tests/pipeline.test.ts) — the
 * `pipeline` tool registered below is the only place that wires it up to a
 * real dispatcher via `makeRealDispatcher()`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeRealDispatcher, type Dispatcher } from "./dispatch.ts";
import { parseCriticVerdict, parseReviewerVerdict } from "./verdict.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface PipelinePhase {
	name: string;
	output: string;
}

export interface PipelineOptions {
	/** Skip the scout recon phase; planner receives only the original task. */
	skipScout?: boolean;
}

export type PipelineStatus = "success" | "blocked" | "failed" | "aborted" | "review-exhausted";

export interface PipelineResult {
	status: PipelineStatus;
	phases: PipelinePhase[];
	content: string;
}

// ── Tuning constants ───────────────────────────────────────────────────────

/** Total planner/critic attempts allowed: the initial plan plus one revision. */
const MAX_PLANNING_ATTEMPTS = 2;

/** Total worker/codereviewer attempts allowed: the initial attempt plus two retries. */
const MAX_WORKER_ATTEMPTS = 3;

// ── Internal control flow ─────────────────────────────────────────────────

/** Thrown internally to short-circuit runPipeline with a terminal result. */
class PipelineHalt extends Error {
	constructor(public readonly result: PipelineResult) {
		super(`pipeline halted: ${result.status}`);
	}
}

function buildPlannerTask(
	originalTask: string,
	scoutOutput: string,
	previousPlan?: string,
	criticFeedback?: string,
): string {
	const parts = [`Task: ${originalTask}`];
	if (scoutOutput) parts.push(`Scout findings:\n${scoutOutput}`);
	if (previousPlan && criticFeedback) {
		parts.push(`Previous plan (revise it based on the critic feedback below):\n${previousPlan}`);
		parts.push(`Critic feedback to address:\n${criticFeedback}`);
	}
	return parts.join("\n\n");
}

function buildCriticTask(originalTask: string, planOutput: string): string {
	return `Original task: ${originalTask}\n\nReview this plan and end your response with PROCEED, REVISE, or BLOCK:\n\n${planOutput}`;
}

function buildWorkerTask(originalTask: string, planOutput: string, reviewerFeedbacks: string[]): string {
	const parts = [`Original task: ${originalTask}`, `Approved plan:\n${planOutput}`];
	if (reviewerFeedbacks.length > 0) {
		parts.push(`Code review feedback from earlier attempts — address all of it:\n${reviewerFeedbacks.join("\n\n---\n\n")}`);
	}
	return parts.join("\n\n");
}

function buildReviewTask(originalTask: string, workerOutput: string): string {
	return `Original task: ${originalTask}\n\nReview this change and lead your response with APPROVE or REJECT:\n\n${workerOutput}`;
}

/**
 * Runs the full scout/planner/critic/worker/codereviewer pipeline for a
 * single task using an injected Dispatcher (see dispatch.ts for the real
 * implementation). Pure control flow — no subprocess spawning here — so it
 * can be exercised against a fake dispatcher in tests.
 */
export async function runPipeline(
	originalTask: string,
	cwd: string,
	signal: AbortSignal | undefined,
	dispatcher: Dispatcher,
	options?: PipelineOptions,
	onPhase?: (phase: PipelinePhase) => void,
): Promise<PipelineResult> {
	const phases: PipelinePhase[] = [];

	if (signal?.aborted) {
		return { status: "aborted", phases, content: "Pipeline aborted before any phase ran." };
	}

	async function step(agent: string, task: string): Promise<string> {
		const result = await dispatcher(agent, task, cwd, signal, undefined);
		if (result.failed) {
			throw new PipelineHalt({ status: "failed", phases, content: result.error || `${agent} failed` });
		}
		const phase: PipelinePhase = { name: agent, output: result.output };
		phases.push(phase);
		onPhase?.(phase);
		return result.output;
	}

	try {
		// ── Scout (optional) ──
		let scoutOutput = "";
		if (!options?.skipScout) {
			scoutOutput = await step("scout", originalTask);
		}

		// ── Planner / Critic revision loop ──
		let plannerTask = buildPlannerTask(originalTask, scoutOutput);
		let planOutput = "";
		let criticFeedback = "";
		let planApproved = false;

		for (let attempt = 1; attempt <= MAX_PLANNING_ATTEMPTS; attempt++) {
			planOutput = await step("planner", plannerTask);
			if (!planOutput.trim()) {
				return { status: "blocked", phases, content: "Planner produced empty output." };
			}

			const criticOutput = await step("critic", buildCriticTask(originalTask, planOutput));
			const verdict = parseCriticVerdict(criticOutput);

			if (verdict === "PROCEED") {
				planApproved = true;
				break;
			}
			if (verdict === "BLOCK" || verdict === null) {
				return { status: "blocked", phases, content: `${planOutput}\n\n${criticOutput}` };
			}
			// verdict === "REVISE"
			if (attempt === MAX_PLANNING_ATTEMPTS) {
				return { status: "blocked", phases, content: `Revision cap reached without a PROCEED verdict.\n\n${planOutput}\n\n${criticOutput}` };
			}
			criticFeedback = criticOutput;
			plannerTask = buildPlannerTask(originalTask, scoutOutput, planOutput, criticFeedback);
		}

		if (!planApproved) {
			// Unreachable in practice: the loop above always returns before
			// exiting normally without either approving or hitting the cap.
			return { status: "blocked", phases, content: "Planning did not reach an approved state." };
		}

		// ── Worker / Codereviewer retry loop ──
		const reviewerFeedbacks: string[] = [];
		let workerOutput = "";
		let reviewOutput = "";
		let reviewApproved = false;

		for (let attempt = 1; attempt <= MAX_WORKER_ATTEMPTS; attempt++) {
			workerOutput = await step("worker", buildWorkerTask(originalTask, planOutput, reviewerFeedbacks));
			reviewOutput = await step("codereviewer", buildReviewTask(originalTask, workerOutput));

			if (parseReviewerVerdict(reviewOutput) === "APPROVE") {
				reviewApproved = true;
				break;
			}
			reviewerFeedbacks.push(reviewOutput);
		}

		if (!reviewApproved) {
			return { status: "review-exhausted", phases, content: `${workerOutput}\n\n${reviewOutput}` };
		}

		return { status: "success", phases, content: `${workerOutput}\n\n${reviewOutput}` };
	} catch (err) {
		if (err instanceof PipelineHalt) return err.result;
		throw err;
	}
}

// ── Extension registration ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "pipeline",
		label: "Pipeline",
		description:
			"Runs the full scout -> planner -> critic -> worker -> codereviewer sequence for a single task in one call, " +
			"including the PROCEED/REVISE/BLOCK planning gate (one revision retry) and the APPROVE/REJECT review gate " +
			"(up to two worker retries). Use instead of manually re-issuing each phase's subagent call in order.",
		promptSnippet: "Run the full scout/plan/critique/execute/review pipeline for a task in one call",
		promptGuidelines: [
			"Prefer this over manually chaining separate subagent calls for scout -> planner -> critic -> worker -> codereviewer.",
			"Set skipScout when the task doesn't need codebase recon (e.g. the relevant files are already known).",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The task description to run through the pipeline. Include all necessary context — subagents have no context from the current conversation." }),
			skipScout: Type.Optional(Type.Boolean({ description: "Skip the scout recon phase and send the planner the original task directly." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;
			const dispatcher = makeRealDispatcher();
			const result = await runPipeline(
				params.task,
				cwd,
				signal,
				dispatcher,
				{ skipScout: params.skipScout },
				(phase) => {
					onUpdate?.({
						content: [{ type: "text", text: `[${phase.name}] ${phase.output.slice(0, 200)}` }],
						details: { status: "running", phases: [] },
					});
				},
			);

			const isError = result.status !== "success";
			return {
				content: [{ type: "text", text: result.content || "(no output)" }],
				details: { status: result.status, phases: result.phases },
				...(isError ? { isError: true } : {}),
			};
		},
	});
}
