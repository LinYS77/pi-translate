import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  getKeybindings,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  TranslationSettingsPane,
  type SettingsActions,
  type SettingsState,
} from "../src/settings-pane.ts";
import { deferred, flushUI, finishSave, model } from "./helpers.ts";

function pane(
  overrides: Partial<SettingsActions> = {},
  initial: Partial<SettingsState> = {},
) {
  initTheme("dark", false);
  const state: SettingsState = {
    enabled: true,
    defaultEnabled: false,
    provider: model.provider,
    model: model.id,
    canRecover: false,
    ...initial,
  };
  const terminal = { rows: 40, columns: 80 };
  const renders: (boolean | undefined)[] = [];
  let closes = 0;
  const actions: SettingsActions = {
    state: () => state,
    toggle: () => {
      state.enabled = !state.enabled;
    },
    loadModels: async () => [model],
    selectModel: async (selected) => {
      state.provider = selected.provider;
      state.model = selected.id;
      return true;
    },
    setDefault: async (enabled) => {
      state.defaultEnabled = enabled;
      return true;
    },
    recover: () => undefined,
    ...overrides,
  };
  const component = new TranslationSettingsPane(
    actions,
    {
      terminal,
      requestRender: (force?: boolean) => renders.push(force),
    } as unknown as Pick<TUI, "terminal" | "requestRender">,
    { fg: (_color: unknown, text: string) => text } as Theme,
    getKeybindings(),
    () => {
      closes++;
    },
  );
  component.focused = true;
  return {
    component,
    state,
    terminal,
    renders,
    get closes() {
      return closes;
    },
    text: (width = 76) =>
      component.render(width).map(stripVTControlCharacters).join("\n"),
  };
}

test("search accepts input and IME focus immediately, even while model metadata is loading", async () => {
  const gate = deferred<Model<Api>[]>();
  const h = pane({ loadModels: () => gate.promise });
  try {
    h.component.handleInput("\r");
    h.component.handleInput("flash");
    assert.ok(h.text().includes("flash"));
    assert.ok(h.component.render(76).join("\n").includes(CURSOR_MARKER));
    gate.resolve([
      { ...model, id: "flash" },
      { ...model, id: "large" },
    ]);
    await flushUI();
    assert.ok(h.text().includes("flash"));
    h.component.handleInput("\r");
    await finishSave(h.component);
    assert.equal(h.state.model, "flash");
    assert.equal(h.closes, 0);
  } finally {
    h.component.close();
  }
});

test("returning from a model submenu aborts its request and cannot repaint from a late response", async () => {
  const gate = deferred<Model<Api>[]>();
  let signal: AbortSignal | undefined;
  const h = pane({
    loadModels: (s) => {
      signal = s;
      return gate.promise;
    },
  });
  try {
    const height = h.component.render(76).length;
    h.component.handleInput("\r");
    await flushUI();
    h.component.handleInput("\u001b");
    assert.equal(signal?.aborted, true);
    assert.equal(h.component.render(76).length, height);
    assert.ok(h.text().includes("翻译设置"));
    const renders = h.renders.length;
    gate.resolve([model]);
    await flushUI();
    assert.equal(h.renders.length, renders);
    assert.equal(h.closes, 0);
  } finally {
    h.component.close();
  }
  h.component.close();
  assert.equal(h.closes, 1);
});

test("idle rendering has no timer or forced repaint, and navigation never remounts the pane", async () => {
  const h = pane();
  try {
    const height = h.component.render(76).length;
    for (let i = 0; i < 20; i++) h.component.render(76);
    assert.equal(h.renders.length, 0);
    for (let i = 0; i < 5; i++) {
      h.component.handleInput("\r");
      assert.equal(h.component.render(76).length, height);
      await flushUI();
      assert.equal(h.component.render(76).length, height);
      h.component.handleInput("\u001b");
      assert.equal(h.component.render(76).length, height);
    }
    assert.ok(h.renders.length > 0);
    assert.ok(h.renders.every((force) => force === undefined));
    assert.equal(h.closes, 0);
  } finally {
    h.component.close();
  }
});

test("a pending save keeps its selected value, ignores duplicate Enter and rolls back visibly on failure", async () => {
  const gate = deferred<boolean>();
  let saves = 0;
  const h = pane({
    setDefault: async () => {
      saves++;
      return gate.promise;
    },
  });
  try {
    const height = h.component.render(76).length;
    h.component.handleInput("\u001b[B");
    h.component.handleInput("\u001b[B");
    h.component.handleInput("\r");
    assert.match(h.text(), /新对话默认\s+on/);
    assert.equal(h.component.render(76).length, height);
    assert.ok(h.text().includes("保存中"));
    h.component.handleInput("\r");
    assert.equal(saves, 1);
    gate.resolve(false);
    await finishSave(h.component);
    assert.match(h.text(), /新对话默认\s+off/);
    assert.ok(h.text().includes("未保存"));
    assert.equal(h.component.render(76).length, height);
  } finally {
    h.component.close();
  }
});

test("terminal resize retains selection, bounds and exit controls", async () => {
  const h = pane(
    {
      loadModels: async () => [
        { ...model, provider: "one", id: "same" },
        { ...model, provider: "two", id: "same" },
      ],
    },
    { provider: "one", model: "same" },
  );
  try {
    h.component.handleInput("\r");
    await flushUI();
    h.component.handleInput("\u001b[B");
    for (const rows of [40, 16, 10]) {
      h.terminal.rows = rows;
      for (const width of [24, 40, 80]) {
        const lines = h.component.render(width);
        assert.ok(lines.length <= rows - 2);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(
          lines.map(stripVTControlCharacters).join("\n").includes("Esc"),
        );
      }
    }
    h.component.handleInput("\r");
    await finishSave(h.component);
    assert.equal(h.state.provider, "two");
  } finally {
    h.component.close();
  }
});

test("model search highlights current choice and distinguishes providers with equal IDs", async () => {
  const models = [
    { ...model, provider: "first", id: "qwen-flash", name: "Qwen Flash" },
    { ...model, provider: "second", id: "qwen-flash", name: "Qwen Flash" },
    { ...model, provider: "first", id: "large", name: "Large Model" },
  ];
  const h = pane(
    { loadModels: async () => models },
    { provider: "second", model: "qwen-flash" },
  );
  try {
    h.component.handleInput("\r");
    await flushUI();
    assert.match(h.text(), /qwen-flash ✓/);
    h.component.handleInput("\r");
    await finishSave(h.component);
    assert.equal(h.state.provider, "second");
    h.component.handleInput("\r");
    await flushUI();
    h.component.handleInput("first flash");
    h.component.handleInput("\r");
    await finishSave(h.component);
    assert.equal(h.state.provider, "first");
    assert.equal(h.state.model, "qwen-flash");
    assert.equal(h.closes, 0);
  } finally {
    h.component.close();
  }
});

test("no-match Enter cannot select a stale model; Escape returns without saving", async () => {
  const h = pane();
  try {
    h.component.handleInput("\r");
    await flushUI();
    h.component.handleInput("not-an-existing-model");
    assert.match(h.text(), /没有匹配的模型/);
    h.component.handleInput("\r");
    assert.equal(h.state.model, model.id);
    assert.match(h.text(), /翻译模型/);
    h.component.handleInput("\u001b");
    assert.match(h.text(), /翻译设置/);
    assert.equal(h.closes, 0);
  } finally {
    h.component.close();
  }
});

test("recovery appears only when input exists, and closes through the same single overlay", () => {
  let recovered = 0;
  const h = pane(
    {
      recover: () => {
        recovered++;
        return undefined;
      },
    },
    { canRecover: true },
  );
  assert.ok(h.text().includes("恢复输入"));
  for (let i = 0; i < 3; i++) h.component.handleInput("\u001b[B");
  h.component.handleInput("\r");
  assert.equal(recovered, 1);
  assert.equal(h.closes, 1);
  h.component.close();
  assert.equal(h.closes, 1);
  const empty = pane();
  try {
    assert.ok(!empty.text().includes("恢复输入"));
  } finally {
    empty.component.close();
  }
});
