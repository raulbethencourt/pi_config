/**
 * Strict environment allowlist for pi subprocesses spawned by the MCP server.
 *
 * This server may hold its own full environment (API keys/tokens for whatever
 * spawned it). Every child `pi` process must get a fresh, minimal environment
 * built from a closed allowlist — never `{ ...process.env }` with keys deleted
 * after the fact, since that pattern silently leaks any new/unexpected
 * process.env entry added later.
 *
 * Verified against ~/.pi/agent/auth.json and the installed provider code paths:
 * - opencode: configured via a literal, non-templated API key (no env lookup needed)
 * - github-copilot: OAuth-based, zero process.env references in its code path
 * Both only need HOME for credential resolution. PATH is needed so the child can
 * resolve the `pi` binary itself and any shell-outs its tools make.
 */
export function buildMinimalEnv(): Record<string, string | undefined> {
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
	};
}
