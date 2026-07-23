import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptHistoryEntry } from "../extensions/prompt-history/prompt-store.ts";

/**
 * Characterization tests for prompt-history/index.ts's ctrl+f picker
 * SCAFFOLDING (pi-improvement-plan item #26, Phase B prep): the same
 * Container/DynamicBorder/Input/SelectList setup registered via
 * `ctx.ui.custom`, its fuzzy-filtering, and its keyboard navigation as
 * zsh-history.ts's ctrl+r picker (see zsh-history-picker.test.ts). These pin
 * down CURRENT behavior so a later extraction into a shared module can be
 * verified against a concrete contract instead of trusted by inspection.
 *
 * All parsing/caching logic (prompt-store.ts) is unit tested directly in
 * prompt-history-store.ts's own tests; this file mocks that module entirely
 * and only drives the `registerShortcut("ctrl+f", ...)` handler end to end
 * through a stubbed `ExtensionAPI`/`ctx`.
 */

const { refreshPromptHistoryMock, loadCacheMock, saveCacheMock, resolveSessionsRootMock, resolveCacheFilePathMock } = vi.hoisted(() => ({
  refreshPromptHistoryMock: vi.fn(),
  loadCacheMock: vi.fn(),
  saveCacheMock: vi.fn(),
  resolveSessionsRootMock: vi.fn(() => "/fake/sessions-root"),
  resolveCacheFilePathMock: vi.fn(() => "/fake/cache.json"),
}));

vi.mock("../extensions/prompt-history/prompt-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/prompt-history/prompt-store.ts")>();
  return {
    ...actual,
    // Keep the real pure formatters (formatRelativeTime, toPreviewLabel);
    // only stub the I/O-touching functions so these tests never touch the
    // real filesystem or real session logs.
    refreshPromptHistory: refreshPromptHistoryMock,
    loadCache: loadCacheMock,
    saveCache: saveCacheMock,
    resolveSessionsRoot: resolveSessionsRootMock,
    resolveCacheFilePath: resolveCacheFilePathMock,
  };
});

import registerPromptHistoryPicker from "../extensions/prompt-history/index.ts";

// Raw terminal byte sequences that pi-tui's matchesKey() (legacy/no-Kitty-
// protocol forms — verified against the installed @mariozechner/pi-tui
// package's dist/keys.js) resolves to each key identifier the picker checks.
const KEY = {
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
};

interface PickerComponent {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
}

interface FakeCtx {
  hasUI: true;
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setEditorText: ReturnType<typeof vi.fn>;
    custom: ReturnType<typeof vi.fn>;
  };
}

// Builds a fake ExtensionContext whose `ui.custom` mimics the real
// ctx.ui.custom<T>(factory): it invokes `factory(tui, theme, keybindings,
// done)` synchronously (capturing the returned {render, invalidate,
// handleInput} object) and resolves the returned promise only once the
// picker calls `done(...)`.
function makeCtx(): { ctx: FakeCtx; getComponent: () => PickerComponent | null } {
  let component: PickerComponent | null = null;
  const custom = vi.fn((factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: unknown) => void) => PickerComponent) => {
    return new Promise((resolve) => {
      const tui = { requestRender: vi.fn() };
      // Identity fg/bold so rendered header text is asserted on directly,
      // without needing to strip ANSI codes.
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const keybindings = {};
      component = factory(tui, theme, keybindings, (result: unknown) => resolve(result));
    });
  });
  const ctx: FakeCtx = {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setEditorText: vi.fn(),
      custom,
    },
  };
  return { ctx, getComponent: () => component };
}

// entries[0..3], in the exact order refreshPromptHistory returns them — the
// picker maps them 1:1 into SelectItems without reordering.
const ENTRIES: PromptHistoryEntry[] = [
  { text: "fix the login bug", timestampMs: 1_700_000_000_000, workspace: "project-a", sessionFile: "/x/a.jsonl" },
  { text: "add unit tests for parser", timestampMs: 1_700_000_000_000, workspace: "project-b", sessionFile: "/x/b.jsonl" },
  { text: "refactor the auth module", timestampMs: 1_700_000_000_000, workspace: "project-a", sessionFile: "/x/c.jsonl" },
  { text: "update the README", timestampMs: 1_700_000_000_000, workspace: "project-c", sessionFile: "/x/d.jsonl" },
];

describe("prompt-history ctrl+f picker", () => {
  let handler: (ctx: FakeCtx) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSessionsRootMock.mockReturnValue("/fake/sessions-root");
    resolveCacheFilePathMock.mockReturnValue("/fake/cache.json");
    loadCacheMock.mockReturnValue({ version: 1, files: {} });
    saveCacheMock.mockImplementation(() => {});
    refreshPromptHistoryMock.mockReturnValue({ entries: ENTRIES, cache: { version: 1, files: {} } });

    const pi = {
      registerShortcut: vi.fn((_key: string, options: { handler: (ctx: FakeCtx) => Promise<void> }) => {
        handler = options.handler;
      }),
    };
    registerPromptHistoryPicker(pi as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens with the correct header label and prompt count", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent();
    expect(component).toBeTruthy();
    const rendered = component!.render(80).join("\n");
    expect(rendered).toContain("prompt history");
    expect(rendered).toContain("4 prompts");

    component!.handleInput(KEY.escape);
    await done;
  });

  it("narrows the visible list via fuzzy filtering against each item's raw value", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput("the");
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("fix the login bug");
    expect(rendered).toContain("refactor the auth module");
    expect(rendered).toContain("update the README");
    expect(rendered).not.toContain("add unit tests for parser");

    component.handleInput(KEY.escape);
    await done;
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("Tab and Down move the selection forward, wrapping at the end", async () => {
    // 0 tabs -> first entry.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      getComponent()!.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("fix the login bug");
    }
    // 1 Tab -> second entry.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.tab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("add unit tests for parser");
    }
    // 1 Down -> second entry (Down behaves identically to Tab: moves forward).
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.down);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("add unit tests for parser");
    }
    // 4 Tabs on a 4-item list wraps all the way back to the first entry.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      for (let i = 0; i < 4; i++) component.handleInput(KEY.tab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("fix the login bug");
    }
  });

  it("Shift+Tab and Up move the selection backward, wrapping at the start", async () => {
    // 1 Shift+Tab from the first entry wraps to the last entry.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.shiftTab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("update the README");
    }
    // 1 Up behaves identically to Shift+Tab: moves backward, wraps to the last entry.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.up);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("update the README");
    }
  });

  it("with exactly one item in the filtered list, navigation keys are a no-op", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput("auth"); // narrows to exactly ["refactor the auth module"]
    expect(() => {
      component.handleInput(KEY.tab);
      component.handleInput(KEY.down);
      component.handleInput(KEY.shiftTab);
      component.handleInput(KEY.up);
    }).not.toThrow();

    component.handleInput(KEY.enter);
    await done;
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("refactor the auth module");
  });

  it("Enter resolves with the selected item's raw value, unprefixed, pasted into the editor", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput(KEY.tab); // select "add unit tests for parser" (index 1)
    component.handleInput(KEY.enter);
    await done;

    expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1);
    // Unprefixed (unlike zsh-history.ts's "!" shell-execution prefix): a
    // pasted prompt here is meant for editing/resubmission, not execution.
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("add unit tests for parser");
  });

  it("Escape resolves without ever calling setEditorText", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput(KEY.tab);
    component.handleInput(KEY.escape);
    await done;

    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("zero entries: never opens the picker, notifies instead", async () => {
    refreshPromptHistoryMock.mockReturnValue({ entries: [], cache: { version: 1, files: {} } });
    const { ctx, getComponent } = makeCtx();

    await handler(ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(getComponent()).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith("No prompt history found", "info");
  });
});
