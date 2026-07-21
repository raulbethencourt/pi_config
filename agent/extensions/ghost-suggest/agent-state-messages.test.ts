/**
 * Verifies the assumption behind generate.ts's `runSuggestionRequest`:
 *
 *   session.agent.state.messages = seedMessages;
 *
 * This is a workaround for a `replaceMessages` method that does not exist on
 * the installed `Agent` class (see the first `it` below, which pins that
 * down as an executable, CI-enforced assertion rather than a comment that
 * can't be checked from the diff alone — `agent/extensions/btw.ts` at its
 * `session.agent.replaceMessages(...)` call site references the same
 * nonexistent method, a separate pre-existing dormant bug tracked in
 * pi-improvement-plan.md item 19 and intentionally left untouched here, out
 * of scope for this change).
 *
 * The actual workaround relies on `Agent.state`'s `messages` setter copying
 * the provided top-level array — per that setter's own doc comment
 * ("Assigning `state.tools` or `state.messages` copies the provided
 * top-level array") in the real installed `@mariozechner/pi-agent-core`
 * package (aliased in vitest.config.ts to the actual installed
 * @earendil-works/pi-agent-core). This test constructs a real `Agent`
 * instance (no mocking) and asserts that assumption directly, rather than
 * leaving it as an unverified guess.
 */
import { describe, it, expect } from "vitest";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

describe("Agent.state.messages assignment (real Agent, not mocked)", () => {
  it("has no replaceMessages method on the real installed Agent class (the reason generate.ts uses state.messages= instead)", () => {
    const agent = new Agent();
    expect(typeof (agent as unknown as Record<string, unknown>).replaceMessages).toBe("undefined");
  });

  it("replaces the agent's transcript with the assigned array's contents", () => {
    const agent = new Agent();
    const seedMessages = [
      { role: "user", content: "seed message one" },
      { role: "assistant", content: "seed message two" },
    ] as unknown as AgentMessage[];

    agent.state.messages = seedMessages;

    expect(agent.state.messages).toEqual(seedMessages);
  });

  it("copies the provided array rather than aliasing it (mutating the original afterward does not affect agent.state.messages)", () => {
    const agent = new Agent();
    const seedMessages = [{ role: "user", content: "original" }] as unknown as AgentMessage[];

    agent.state.messages = seedMessages;
    seedMessages.push({ role: "user", content: "appended after assignment" } as unknown as AgentMessage);

    expect(agent.state.messages).not.toBe(seedMessages);
    expect(agent.state.messages.length).toBe(1);
  });

  it("fully replaces (not appends to) any pre-existing transcript", () => {
    const agent = new Agent({
      initialState: {
        messages: [{ role: "user", content: "pre-existing message" }] as unknown as AgentMessage[],
      },
    });

    const seedMessages = [{ role: "user", content: "seeded replacement" }] as unknown as AgentMessage[];
    agent.state.messages = seedMessages;

    expect(agent.state.messages.length).toBe(1);
    expect(agent.state.messages).toEqual(seedMessages);
  });
});
