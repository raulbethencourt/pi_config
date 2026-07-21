import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shouldOfferSuggestion, isFirstTurn } from "./guards.ts";
import type { GhostSuggestContext, AgentEndEvent, TimelineEntry } from "./guards.ts";

function makeCtx(overrides: Partial<GhostSuggestContext> = {}): GhostSuggestContext {
  return {
    mode: "tui",
    ...overrides,
  } as GhostSuggestContext;
}

function makeEvent(messages: AgentEndEvent["messages"]): AgentEndEvent {
  return { messages } as AgentEndEvent;
}

const ORIGINAL_PI_SUBAGENT_DEPTH = process.env.PI_SUBAGENT_DEPTH;

describe("shouldOfferSuggestion", () => {
  afterEach(() => {
    if (ORIGINAL_PI_SUBAGENT_DEPTH === undefined) {
      delete process.env.PI_SUBAGENT_DEPTH;
    } else {
      process.env.PI_SUBAGENT_DEPTH = ORIGINAL_PI_SUBAGENT_DEPTH;
    }
  });

  describe("mode gating", () => {
    beforeEach(() => {
      delete process.env.PI_SUBAGENT_DEPTH;
    });

    it("skips when ctx.mode is 'rpc'", () => {
      const ctx = makeCtx({ mode: "rpc" });
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("skips when ctx.mode is 'json'", () => {
      const ctx = makeCtx({ mode: "json" });
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("skips when ctx.mode is 'print'", () => {
      const ctx = makeCtx({ mode: "print" });
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("does NOT skip on mode grounds when ctx.mode is 'tui'", () => {
      const ctx = makeCtx({ mode: "tui" });
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });
  });

  describe("PI_SUBAGENT_DEPTH gating", () => {
    it("regression: unset PI_SUBAGENT_DEPTH (normal main session) must NOT be treated as a subagent — proceeds", () => {
      delete process.env.PI_SUBAGENT_DEPTH;
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("PI_SUBAGENT_DEPTH='0' proceeds (explicit zero is still main session)", () => {
      process.env.PI_SUBAGENT_DEPTH = "0";
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("PI_SUBAGENT_DEPTH='1' skips (inside a subagent)", () => {
      process.env.PI_SUBAGENT_DEPTH = "1";
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("PI_SUBAGENT_DEPTH='2' skips (nested subagent)", () => {
      process.env.PI_SUBAGENT_DEPTH = "2";
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("PI_SUBAGENT_DEPTH being a non-finite/garbage string ('abc') fails the Number.isFinite check and proceeds (gating does not apply, not because it's treated as 0)", () => {
      process.env.PI_SUBAGENT_DEPTH = "abc";
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });
  });

  describe("last assistant message stopReason gating", () => {
    beforeEach(() => {
      delete process.env.PI_SUBAGENT_DEPTH;
    });

    it("proceeds when there is no assistant message at all in the array", () => {
      const ctx = makeCtx();
      const event = makeEvent([{ role: "user", content: "hi" } as any]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("proceeds when messages array is empty", () => {
      const ctx = makeCtx();
      const event = makeEvent([]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("proceeds when last assistant message has stopReason 'stop'", () => {
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "stop" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("proceeds when last assistant message has stopReason 'length'", () => {
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "length" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("proceeds when last assistant message has stopReason 'toolUse'", () => {
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "toolUse" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });

    it("skips when last assistant message has stopReason 'error'", () => {
      const ctx = makeCtx();
      const event = makeEvent([{ role: "assistant", stopReason: "error" }]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("uses the LAST assistant message, not an earlier one — skips when the latest is 'error' despite an earlier 'stop'", () => {
      const ctx = makeCtx();
      const event = makeEvent([
        { role: "assistant", stopReason: "stop" },
        { role: "user", content: "continue" } as any,
        { role: "assistant", stopReason: "error" },
      ]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(false);
    });

    it("uses the LAST assistant message — proceeds when the latest is 'stop' despite an earlier 'error'", () => {
      const ctx = makeCtx();
      const event = makeEvent([
        { role: "assistant", stopReason: "error" },
        { role: "user", content: "continue" } as any,
        { role: "assistant", stopReason: "stop" },
      ]);
      expect(shouldOfferSuggestion(ctx, event)).toBe(true);
    });
  });
});

describe("isFirstTurn", () => {
  it("returns true for an empty entries array", () => {
    expect(isFirstTurn([])).toBe(true);
  });

  it("returns true when there's exactly one user message", () => {
    const entries: TimelineEntry[] = [
      { type: "message", message: { role: "user" } } as any,
    ];
    expect(isFirstTurn(entries)).toBe(true);
  });

  it("returns false when there are two or more user messages", () => {
    const entries: TimelineEntry[] = [
      { type: "message", message: { role: "user" } } as any,
      { type: "message", message: { role: "assistant" } } as any,
      { type: "message", message: { role: "user" } } as any,
    ];
    expect(isFirstTurn(entries)).toBe(false);
  });

  it("returns false when a compaction entry is present, even with only one user message", () => {
    const entries: TimelineEntry[] = [
      { type: "message", message: { role: "user" } } as any,
      { type: "compaction" } as any,
    ];
    expect(isFirstTurn(entries)).toBe(false);
  });

  it("returns false when a branch_summary entry is present, even with only one user message", () => {
    const entries: TimelineEntry[] = [
      { type: "message", message: { role: "user" } } as any,
      { type: "branch_summary" } as any,
    ];
    expect(isFirstTurn(entries)).toBe(false);
  });

  it("ignores entries of other types (label, model_change, session_info) when counting user messages", () => {
    const entries: TimelineEntry[] = [
      { type: "label" } as any,
      { type: "message", message: { role: "user" } } as any,
      { type: "model_change" } as any,
      { type: "session_info" } as any,
    ];
    expect(isFirstTurn(entries)).toBe(true);
  });

  it("does not count assistant messages toward the user-message tally", () => {
    const entries: TimelineEntry[] = [
      { type: "message", message: { role: "assistant" } } as any,
      { type: "message", message: { role: "assistant" } } as any,
    ];
    expect(isFirstTurn(entries)).toBe(true);
  });
});
