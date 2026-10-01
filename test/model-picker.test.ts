import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { TranslationModelPicker } from "../src/model-picker.ts";
import { model } from "./helpers.ts";

const theme = { fg: (_color: unknown, text: string) => text } as Theme;
const models = [
  { ...model, provider: "first", id: "qwen3.8-flash", name: "Qwen Flash" },
  { ...model, provider: "second", id: "qwen3.8-flash", name: "Qwen Flash" },
  { ...model, provider: "first", id: "large", name: "Large Model" },
];

function picker() {
  initTheme("dark", false);
  const selections: (Model<Api> | undefined)[] = [];
  let renders = 0;
  const component = new TranslationModelPicker(models, { provider: "second", model: "qwen3.8-flash" },
    { requestRender: () => { renders++; } }, theme, getKeybindings(), (m) => selections.push(m));
  return { component, selections, get renders() { return renders; } };
}

test("picker highlights current model, propagates IME focus and fits narrow screens", () => {
  const h = picker();
  h.component.focused = true;
  for (const width of [24, 40, 80]) {
    h.component.invalidate();
    const lines = h.component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.join("\n").includes(CURSOR_MARKER));
  }
  h.component.handleInput("\r");
  assert.equal(h.selections[0]?.provider, "second");
});

test("picker supports fuzzy name/ID/provider search without confusing equal IDs", () => {
  const h = picker();
  h.component.handleInput("first flash");
  h.component.handleInput("\r");
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0]?.provider, "first");
  assert.equal(h.selections[0]?.id, "qwen3.8-flash");
  assert.ok(h.renders >= 2);
});

test("no-match Enter cannot select a stale model; Escape cancels", () => {
  const h = picker();
  h.component.handleInput("not-an-existing-model");
  assert.ok(h.component.render(80).join("\n").includes("没有匹配的模型"));
  h.component.handleInput("\r");
  assert.deepEqual(h.selections, []);
  h.component.handleInput("\u001b");
  assert.deepEqual(h.selections, [undefined]);
});
