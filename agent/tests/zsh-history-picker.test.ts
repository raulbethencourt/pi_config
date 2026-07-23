import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Characterization tests for zsh-history.ts's ctrl+r picker SCAFFOLDING
 * (pi-improvement-plan item #26, Phase B prep): the Container/DynamicBorder/
 * Input/SelectList setup registered via `ctx.ui.custom`, its fuzzy-filtering,
 * and its keyboard navigation. These pin down CURRENT behavior so a later
 * extraction into a shared module (mirrored in prompt-history's ctrl+f
 * picker — see prompt-history-picker.test.ts) can be verified against a
 * concrete contract instead of trusted by inspection.
 *
 * `parseZshHistory`/`sanitizeForDisplay` (the pure helpers) already have
 * their own tests in zsh-history.test.ts; this file only drives the
 * `registerShortcut("ctrl+r", ...)` handler end to end through a stubbed
 * `ExtensionAPI`/`ctx`.
 */

// zsh-history.ts reads ~/.zsh_history via node:fs directly (no injected
// dependency), so node:fs itself must be stubbed to keep these tests off the
// real filesystem and the developer's actual shell history.
const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

import registerZshHistoryPicker from "../extensions/zsh-history.ts";

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

describe("zsh-history ctrl+r picker", () => {
  let handler: (ctx: FakeCtx) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    const pi = {
      registerShortcut: vi.fn((_key: string, options: { handler: (ctx: FakeCtx) => Promise<void> }) => {
        handler = options.handler;
      }),
    };
    registerZshHistoryPicker(pi as never);

    // Raw file is oldest-first; parseZshHistory dedupes+reverses to
    // most-recent-first, so the picker's item order ends up:
    // ["ls -la", "git status", "docker ps", "git commit -m wip"].
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("git commit -m wip\ndocker ps\ngit status\nls -la");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens with the correct header label and entry count", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent();
    expect(component).toBeTruthy();
    const rendered = component!.render(80).join("\n");
    expect(rendered).toContain("zsh history");
    expect(rendered).toContain("4 entries");

    component!.handleInput(KEY.escape);
    await done;
  });

  it("narrows the visible list via fuzzy filtering against each item's raw value", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput("git");
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain("git status");
    expect(rendered).toContain("git commit -m wip");
    expect(rendered).not.toContain("docker ps");
    expect(rendered).not.toContain("ls -la");

    component.handleInput(KEY.escape);
    await done;
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });

  it("Tab and Down move the selection forward, wrapping at the end", async () => {
    // 0 tabs -> first item.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      getComponent()!.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!ls -la");
    }
    // 1 Tab -> second item.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.tab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!git status");
    }
    // 1 Down -> second item (Down behaves identically to Tab: moves forward).
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.down);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!git status");
    }
    // 4 Tabs on a 4-item list wraps all the way back to the first item.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      for (let i = 0; i < 4; i++) component.handleInput(KEY.tab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!ls -la");
    }
  });

  it("Shift+Tab and Up move the selection backward, wrapping at the start", async () => {
    // 1 Shift+Tab from the first item wraps to the last item.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.shiftTab);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!git commit -m wip");
    }
    // 1 Up behaves identically to Shift+Tab: moves backward, wraps to the last item.
    {
      const { ctx, getComponent } = makeCtx();
      const done = handler(ctx);
      const component = getComponent()!;
      component.handleInput(KEY.up);
      component.handleInput(KEY.enter);
      await done;
      expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!git commit -m wip");
    }
  });

  it("with exactly one item in the filtered list, navigation keys are a no-op", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput("docker"); // narrows to exactly ["docker ps"]
    expect(() => {
      component.handleInput(KEY.tab);
      component.handleInput(KEY.down);
      component.handleInput(KEY.shiftTab);
      component.handleInput(KEY.up);
    }).not.toThrow();

    component.handleInput(KEY.enter);
    await done;
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!docker ps");
  });

  it("Enter resolves with the selected item's raw value, '!'-prefixed, pasted into the editor", async () => {
    const { ctx, getComponent } = makeCtx();
    const done = handler(ctx);
    const component = getComponent()!;

    component.handleInput(KEY.tab); // select "git status" (index 1)
    component.handleInput(KEY.enter);
    await done;

    expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("!git status");
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
    readFileSyncMock.mockReturnValue("");
    const { ctx, getComponent } = makeCtx();

    await handler(ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(getComponent()).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith("No history entries found", "info");
  });

  it("missing ~/.zsh_history: notifies an error and never opens the picker", async () => {
    existsSyncMock.mockReturnValue(false);
    const { ctx, getComponent } = makeCtx();

    await handler(ctx);

    expect(ctx.ui.custom).not.toHaveBeenCalled();
    expect(getComponent()).toBeNull();
    expect(ctx.ui.notify).toHaveBeenCalledWith("~/.zsh_history not found", "error");
  });
});
