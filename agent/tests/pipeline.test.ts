import { describe, it, expect, beforeEach, afterEach } from "vitest";

// These modules do not exist yet (RED phase for the new `pipeline` extension).
// Every import below is expected to fail with a module-not-found error until
// a worker implements verdict.ts, dispatch.ts and pipeline/index.ts.
import { parseCriticVerdict, parseReviewerVerdict } from "../extensions/pipeline/verdict.ts";
import { makeRealDispatcher, type Dispatcher } from "../extensions/pipeline/dispatch.ts";
import { runPipeline } from "../extensions/pipeline/index.ts";

// ── Shared fixtures ─────────────────────────────────────────────────────

const ORIGINAL_TASK = "Add rate limiting to the login endpoint";
const CWD = "/tmp/pipeline-test-cwd";

interface DispatchCall {
	agent: string;
	task: string;
	cwd: string;
}

interface CannedResult {
	output: string;
	failed?: boolean;
	error?: string;
}

/**
 * Builds a fake Dispatcher that returns canned results in call order and
 * records everything it was invoked with. Never spawns a real subprocess.
 */
function createFakeDispatcher(script: CannedResult[]): { dispatcher: Dispatcher; calls: DispatchCall[] } {
	const calls: DispatchCall[] = [];
	let i = 0;
	const dispatcher: Dispatcher = async (agent, task, cwd, _signal, _onProgress) => {
		calls.push({ agent, task, cwd });
		if (i >= script.length) {
			throw new Error(
				`Fake dispatcher called more times than scripted: call #${calls.length} was for agent "${agent}", but only ${script.length} results were scripted.`,
			);
		}
		const result = script[i++];
		return { output: result.output, failed: result.failed ?? false, error: result.error };
	};
	return { dispatcher, calls };
}

// ── parseCriticVerdict ───────────────────────────────────────────────────

describe("parseCriticVerdict", () => {
	it("matches a plain PROCEED/REVISE/BLOCK on the last line", () => {
		expect(parseCriticVerdict("Looks solid overall.\nPROCEED")).toBe("PROCEED");
		expect(parseCriticVerdict("This needs work.\nREVISE")).toBe("REVISE");
		expect(parseCriticVerdict("This is not safe to run.\nBLOCK")).toBe("BLOCK");
	});

	it("tolerates the verdict word wrapped in bold markdown emphasis and surrounded by extra whitespace", () => {
		expect(parseCriticVerdict("Some reasoning here.\n\n   **PROCEED**   \n")).toBe("PROCEED");
		expect(parseCriticVerdict("Some reasoning here.\n__REVISE__")).toBe("REVISE");
		expect(parseCriticVerdict("Some reasoning here.\n`BLOCK`")).toBe("BLOCK");
	});

	it("returns null for text matching none of the three verdicts", () => {
		expect(parseCriticVerdict("This plan is confusing and I have no clear verdict.")).toBeNull();
		expect(parseCriticVerdict("I think we should PROCEED with caution, but let's double check first.")).toBeNull();
		expect(parseCriticVerdict("")).toBeNull();
	});

	// Pins down the over-blocking bug described in the security review: the true
	// last non-blank line of the response IS a real, bare verdict word, but it is
	// followed by one or more blank lines and then a trailing line that contains
	// only a stray closing code-fence delimiter ("```") with nothing else on it
	// (e.g. the model closed a fence it opened earlier in its reasoning, and that
	// closing fence ends up as the actual last non-blank line). Today the parser
	// looks only at the exact last non-blank line, sees the bare fence, strips it
	// down to an empty string, and incorrectly returns null even though a valid
	// verdict word is sitting right above it. The fix must scan bottom-up past
	// purely-decorative lines (blank, or fence-delimiter-only) to find the real
	// verdict.
	it("finds the real verdict when it is followed by blank lines and then a stray trailing fence-only line", () => {
		expect(parseCriticVerdict("Looks solid overall.\n\nPROCEED\n\n\n```")).toBe("PROCEED");
		expect(parseCriticVerdict("This needs another pass.\nREVISE\n\n```\n")).toBe("REVISE");
		expect(parseCriticVerdict("This is not safe to run.\n\nBLOCK\n\n```\n\n")).toBe("BLOCK");
	});
});

// ── parseReviewerVerdict ─────────────────────────────────────────────────

describe("parseReviewerVerdict", () => {
	it("matches a plain APPROVE/REJECT on the first line", () => {
		expect(parseReviewerVerdict("APPROVE\nLooks good, ship it.")).toBe("APPROVE");
		expect(parseReviewerVerdict("REJECT\nMissing test coverage.")).toBe("REJECT");
	});

	it("matches when the verdict word shares a line with a code-fence delimiter", () => {
		expect(parseReviewerVerdict("```APPROVE\nSome trailing content")).toBe("APPROVE");
		expect(parseReviewerVerdict("```REJECT")).toBe("REJECT");
	});

	it("matches when a code-fence delimiter sits alone on the line immediately before the verdict word", () => {
		expect(parseReviewerVerdict("```\nAPPROVE\nrest of the review")).toBe("APPROVE");
		expect(parseReviewerVerdict("```\nREJECT\nrest of the review")).toBe("REJECT");
	});

	it("matches when the verdict word has bold emphasis markers around it", () => {
		expect(parseReviewerVerdict("**APPROVE**\nGreat work.")).toBe("APPROVE");
		expect(parseReviewerVerdict("**REJECT**\nNeeds changes.")).toBe("REJECT");
	});

	it("returns null, without hanging or erroring, when given input that is entirely blank lines", () => {
		expect(parseReviewerVerdict("\n\n\n\n\n")).toBeNull();
		expect(parseReviewerVerdict("   \n   \n   ")).toBeNull();
		expect(parseReviewerVerdict("")).toBeNull();
	});

	// Pins down the spoofing concern from the security review: the parser scans
	// top-down and commits to the FIRST line that reduces to a bare APPROVE/REJECT,
	// with no awareness of markdown structure beyond stripping fence/emphasis
	// wrapper characters off the ends of a single line. That means a reviewer
	// response that quotes back a piece of reviewed content — here, an existing
	// status constant from the diff, echoed inside its own fenced block for
	// context — which happens to be the bare word "APPROVE" sitting alone on a
	// line, is indistinguishable to the parser from a genuine leading verdict. The
	// response's real, intended verdict (REJECT) is only stated later, after the
	// reviewer explains the quoted constant is unrelated to their decision.
	//
	// This is a realistic-but-adversarial shape (an unchanged enum/constant value
	// that happens to collide with a verdict word, echoed verbatim in its own code
	// fence) rather than a contrived one-off string; it is intentionally NOT the
	// same shape as the parseCriticVerdict trailing-fence fix (a fence-only line
	// with no word on it), since a fence wrapping an actual word is not "purely
	// decorative" by the same rule. Whether a future fix can reliably tell "quoted
	// content" apart from "the real verdict" is an open heuristic limitation, not
	// a hard guarantee this test can enforce beyond checking the parser did not
	// silently settle on the spoofed word.
	it("does not settle on an earlier spoofed APPROVE quoted from reviewed content when the real verdict differs and appears later", () => {
		const RESPONSE = [
			"Reviewing the diff for the rate limiter changes.",
			"",
			"The reviewed code includes this pre-existing constant, unchanged by this diff:",
			"",
			"```",
			"APPROVE",
			"```",
			"",
			"That value is just an old status enum from the audit-log module, unrelated to my review.",
			"",
			"My actual assessment: the middleware never releases the Redis lock on error, so requests",
			"can get stuck rate-limited forever after a single failure.",
			"",
			"REJECT",
		].join("\n");

		const result = parseReviewerVerdict(RESPONSE);
		expect(result).not.toBe("APPROVE");
		expect(result).toBe("REJECT");
	});
});

// ── makeRealDispatcher ────────────────────────────────────────────────────

describe("makeRealDispatcher", () => {
	const originalBridge = (globalThis as any).__pi_subagents;

	afterEach(() => {
		(globalThis as any).__pi_subagents = originalBridge;
	});

	it("throws a clear error referencing the subagents extension when the bridge lacks runSubagent", () => {
		(globalThis as any).__pi_subagents = {
			registerAgent: () => {},
			unregisterAgent: () => {},
			getAgents: () => [],
			// runSubagent intentionally omitted
		};

		expect(() => makeRealDispatcher()).toThrow(/subagents/i);
	});

	it("throws a clear error referencing the subagents extension when the bridge is entirely missing", () => {
		delete (globalThis as any).__pi_subagents;

		expect(() => makeRealDispatcher()).toThrow(/subagents/i);
	});
});

// ── runPipeline ───────────────────────────────────────────────────────────

describe("runPipeline", () => {
	it("runs the normal success path with no revisions or retries (exactly 5 dispatches)", async () => {
		const SCOUT_OUTPUT = "SCOUT_FINDINGS: login handler lives in auth/login.ts";
		const PLAN_OUTPUT = "PLAN_V1: add token-bucket limiter middleware";
		const CRITIC_OUTPUT = "Looks good.\nPROCEED";
		const WORKER_OUTPUT = "WORKER_DONE: implemented limiter middleware";
		const REVIEWER_OUTPUT = "APPROVE\nShips cleanly.";

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: SCOUT_OUTPUT },
			{ output: PLAN_OUTPUT },
			{ output: CRITIC_OUTPUT },
			{ output: WORKER_OUTPUT },
			{ output: REVIEWER_OUTPUT },
		]);

		const phaseLog: { name: string; output: string }[] = [];
		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher, undefined, (phase) => {
			phaseLog.push(phase);
		});

		expect(calls.length).toBe(5);
		expect(calls.map((c) => c.agent)).toEqual(["scout", "planner", "critic", "worker", "codereviewer"]);

		// Scout's output must reach planner, alongside the original task text.
		expect(calls[1].task).toContain(ORIGINAL_TASK);
		expect(calls[1].task).toContain(SCOUT_OUTPUT);

		// Critic must see the plan.
		expect(calls[2].task).toContain(PLAN_OUTPUT);

		// Worker must see the approved plan.
		expect(calls[3].task).toContain(PLAN_OUTPUT);

		// Codereviewer must see worker's output.
		expect(calls[4].task).toContain(WORKER_OUTPUT);

		expect(result.status).toBe("success");
		expect(result.phases.map((p) => p.name)).toEqual(["scout", "planner", "critic", "worker", "codereviewer"]);

		// Per-phase callback invoked once per actual dispatch.
		expect(phaseLog.length).toBe(5);
	});

	it("handles one revision loop where critic REVISEs once then PROCEEDs on the retried plan (exactly 7 dispatches)", async () => {
		const SCOUT_OUTPUT = "SCOUT_FINDINGS: relevant files located";
		const PLAN_V1 = "PLAN_V1: naive limiter with no persistence";
		const CRITIC_FEEDBACK_1 = "This plan has no persistence layer, reconsider.\nREVISE";
		const PLAN_V2 = "PLAN_V2: limiter backed by redis";
		const CRITIC_OUTPUT_2 = "Much better now.\nPROCEED";
		const WORKER_OUTPUT = "WORKER_DONE: implemented redis-backed limiter";
		const REVIEWER_OUTPUT = "APPROVE\nGood to go.";

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: SCOUT_OUTPUT },
			{ output: PLAN_V1 },
			{ output: CRITIC_FEEDBACK_1 },
			{ output: PLAN_V2 },
			{ output: CRITIC_OUTPUT_2 },
			{ output: WORKER_OUTPUT },
			{ output: REVIEWER_OUTPUT },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		expect(calls.length).toBe(7);
		expect(calls.map((c) => c.agent)).toEqual([
			"scout",
			"planner",
			"critic",
			"planner",
			"critic",
			"worker",
			"codereviewer",
		]);

		// The retried planner call (index 3) must include all three required substrings.
		const retriedPlannerTask = calls[3].task;
		expect(retriedPlannerTask).toContain(ORIGINAL_TASK);
		expect(retriedPlannerTask).toContain(PLAN_V1);
		expect(retriedPlannerTask).toContain(CRITIC_FEEDBACK_1);

		// Worker must be dispatched with the approved (second) plan.
		expect(calls[5].task).toContain(PLAN_V2);

		expect(result.status).toBe("success");
	});

	it("caps the revision retry even when critic always REVISEs (blocked, worker never called)", async () => {
		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: "PLAN_V1" },
			{ output: "Needs work.\nREVISE" },
			{ output: "PLAN_V2" },
			{ output: "Still needs work.\nREVISE" },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		const plannerCalls = calls.filter((c) => c.agent === "planner");
		const criticCalls = calls.filter((c) => c.agent === "critic");
		expect(plannerCalls.length).toBe(2);
		expect(criticCalls.length).toBe(2);
		expect(calls.some((c) => c.agent === "worker")).toBe(false);
		expect(calls.some((c) => c.agent === "codereviewer")).toBe(false);
		expect(result.status).toBe("blocked");
	});

	it("blocks immediately when critic returns BLOCK on the first pass", async () => {
		const PLAN_OUTPUT = "PLAN_V1: risky plan";
		const CRITIC_OUTPUT = "This is unsafe to execute.\nBLOCK";

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: PLAN_OUTPUT },
			{ output: CRITIC_OUTPUT },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		expect(calls.length).toBe(3);
		expect(calls.some((c) => c.agent === "worker")).toBe(false);
		expect(calls.some((c) => c.agent === "codereviewer")).toBe(false);
		expect(result.status).toBe("blocked");
		expect(result.content).toContain(PLAN_OUTPUT);
		expect(result.content).toContain(CRITIC_OUTPUT);
	});

	it("blocks when critic returns genuinely unparseable text (treated identically to BLOCK)", async () => {
		const PLAN_OUTPUT = "PLAN_V1: some plan";
		const CRITIC_OUTPUT = "I have some thoughts about this plan but no clear verdict.";

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: PLAN_OUTPUT },
			{ output: CRITIC_OUTPUT },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		expect(calls.length).toBe(3);
		expect(calls.some((c) => c.agent === "worker")).toBe(false);
		expect(calls.some((c) => c.agent === "codereviewer")).toBe(false);
		expect(result.status).toBe("blocked");
		expect(result.content).toContain(PLAN_OUTPUT);
		expect(result.content).toContain(CRITIC_OUTPUT);
	});

	it("retries worker on reviewer REJECT twice, then succeeds on the third attempt, accumulating feedback", async () => {
		const PLAN_OUTPUT = "PLAN_V1: approved plan";
		const WORKER_1 = "WORKER_ATTEMPT_1";
		const REVIEW_1 = "Missing error handling.\nREJECT";
		const WORKER_2 = "WORKER_ATTEMPT_2";
		const REVIEW_2 = "Still missing tests.\nREJECT";
		const WORKER_3 = "WORKER_ATTEMPT_3";
		const REVIEW_3 = "APPROVE\nAll good now.";

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: PLAN_OUTPUT },
			{ output: "Fine.\nPROCEED" },
			{ output: WORKER_1 },
			{ output: REVIEW_1 },
			{ output: WORKER_2 },
			{ output: REVIEW_2 },
			{ output: WORKER_3 },
			{ output: REVIEW_3 },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		const workerCalls = calls.filter((c) => c.agent === "worker");
		const reviewerCalls = calls.filter((c) => c.agent === "codereviewer");
		expect(workerCalls.length).toBe(3);
		expect(reviewerCalls.length).toBe(3);

		// First worker call carries the approved plan but no reviewer feedback yet.
		expect(workerCalls[0].task).toContain(PLAN_OUTPUT);
		expect(workerCalls[0].task).not.toContain(REVIEW_1);

		// Second worker call must be a strict superset: prior task content plus REVIEW_1.
		expect(workerCalls[1].task).toContain(PLAN_OUTPUT);
		expect(workerCalls[1].task).toContain(REVIEW_1);

		// Third worker call accumulates both prior reviewer feedbacks.
		expect(workerCalls[2].task).toContain(PLAN_OUTPUT);
		expect(workerCalls[2].task).toContain(REVIEW_1);
		expect(workerCalls[2].task).toContain(REVIEW_2);

		expect(result.status).toBe("success");
	});

	it("caps reviewer retries even when reviewer always REJECTs (review-exhausted)", async () => {
		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: "PLAN_V1" },
			{ output: "Fine.\nPROCEED" },
			{ output: "WORKER_ATTEMPT_1" },
			{ output: "Nope.\nREJECT" },
			{ output: "WORKER_ATTEMPT_2" },
			{ output: "Still nope.\nREJECT" },
			{ output: "WORKER_ATTEMPT_3" },
			{ output: "Nope again.\nREJECT" },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		const workerCalls = calls.filter((c) => c.agent === "worker");
		const reviewerCalls = calls.filter((c) => c.agent === "codereviewer");
		expect(workerCalls.length).toBe(3);
		expect(reviewerCalls.length).toBe(3);
		expect(result.status).toBe("review-exhausted");
	});

	it("stops immediately and reports failed when the very first dispatch fails", async () => {
		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "", failed: true, error: "scout subprocess crashed" },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		expect(calls.length).toBe(1);
		expect(calls[0].agent).toBe("scout");
		expect(result.status).toBe("failed");
		expect(result.content).toContain("scout subprocess crashed");
	});

	it("returns aborted immediately with zero dispatches when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const { dispatcher, calls } = createFakeDispatcher([
			{ output: "scout output" },
			{ output: "PLAN_V1" },
			{ output: "PROCEED" },
			{ output: "WORKER_DONE" },
			{ output: "APPROVE" },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, controller.signal, dispatcher);

		expect(calls.length).toBe(0);
		expect(result.status).toBe("aborted");
	});

	it("blocks immediately when planner produces empty output, without calling critic", async () => {
		const { dispatcher, calls } = createFakeDispatcher([{ output: "scout output" }, { output: "   \n  " }]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher);

		expect(calls.length).toBe(2);
		expect(calls.map((c) => c.agent)).toEqual(["scout", "planner"]);
		expect(calls.some((c) => c.agent === "critic")).toBe(false);
		expect(result.status).toBe("blocked");
	});

	it("skips the scout phase when skipScout is true, while planner still receives the original task", async () => {
		const PLAN_OUTPUT = "PLAN_V1: plan without scout recon";
		const { dispatcher, calls } = createFakeDispatcher([
			{ output: PLAN_OUTPUT },
			{ output: "Fine.\nPROCEED" },
			{ output: "WORKER_DONE" },
			{ output: "APPROVE" },
		]);

		const result = await runPipeline(ORIGINAL_TASK, CWD, undefined, dispatcher, { skipScout: true });

		expect(calls.some((c) => c.agent === "scout")).toBe(false);
		expect(calls[0].agent).toBe("planner");
		expect(calls[0].task).toContain(ORIGINAL_TASK);
		expect(result.status).toBe("success");
	});
});
