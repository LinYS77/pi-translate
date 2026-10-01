import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { OUTPUT } from "../src/extension.ts";
import { deferred, harness, model } from "./helpers.ts";

const other = { ...model, provider: "other", id: "fast" };

test("/translate opens settings without toggling, execution or changing the main model", async () => {
  const h = await harness();
  try {
    const main = h.ctx.model;
    await h.command("");
    assert.equal(h.dialogs.length, 1);
    assert.match(h.dialogs[0].title, /翻译设置/);
    assert.ok(h.dialogs[0].options.some((text) => text.includes("translator/small")));
    assert.ok(h.dialogs[0].options.some((text) => text.includes("当前开关 · on")));
    assert.match(h.status, /^译 on$/);
    assert.equal(h.ctx.model, main);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("searchable model picker saves selection, not the temporary switch or main model", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    const main = h.ctx.model;
    await h.toggle();
    h.modelChoices.push(other);
    await h.command("model");
    const saved = await loadConfig(join(h.dir, "config.json"));
    assert.equal(saved.provider, "other");
    assert.equal(saved.model, "fast");
    assert.equal(saved.enabled, false);
    assert.match(h.status, /^译 on$/);
    assert.equal(h.ctx.model, main);
    assert.equal(h.modelPickerCalls, 1);
    assert.equal(h.calls.length, 0);
    await h.emit("session_start");
    assert.match(h.status, /^译 off$/);
  } finally { await h.close(); }
});

test("cancelled picker and unavailable providers keep the old configuration", async () => {
  const h = await harness();
  try {
    await h.command("model");
    assert.equal((await loadConfig(join(h.dir, "config.json"))).provider, "translator");
    h.ctx.modelRegistry.getAvailable = () => [];
    await h.command("model");
    assert.equal(h.modelPickerCalls, 1);
    assert.match(h.notifications.at(-1)!, /没有可用.*\/login/);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).model, "small");
  } finally { await h.close(); }
});

test("default on saves startup policy without changing the runtime or active task", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    await h.start();
    await h.command("default on");
    assert.match(h.status, /^译 off$/);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, true);
    await h.turn(); await h.settle();
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 0);
    await h.emit("session_start");
    assert.match(h.status, /^译 on$/);
  } finally { await h.close(); }
});

test("settings menu changes startup default through native selection", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    h.choices.push(2, "on", 3);
    await h.command("");
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, true);
    assert.match(h.status, /^译 off$/);
    assert.ok(h.dialogs.at(-1)!.options.includes("新对话默认 · on"));
  } finally { await h.close(); }
});

test("explicit model command cannot accidentally persist an Alt+T switch", async () => {
  const h = await harness();
  try {
    await h.toggle();
    await h.command("model other fast");
    assert.match(h.status, /^译 off$/);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, true);
    await h.emit("session_start");
    assert.match(h.status, /^译 on$/);
  } finally { await h.close(); }
});

test("Escape in settings only cancels settings, not the active task's final translation", async () => {
  const gate = deferred<Model<Api> | undefined>();
  const h = await harness();
  try {
    await h.start();
    h.ctx.ui.custom = (() => gate.promise) as typeof h.ctx.ui.custom;
    const pending = h.command("model");
    await new Promise((resolve) => setImmediate(resolve));
    h.key("\u001b");
    gate.resolve(undefined); await pending;
    await h.turn(); await h.settle();
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 1);
  } finally { await h.close(); }
});

test("late picker selection after session replacement is discarded", async () => {
  const gate = deferred<Model<Api> | undefined>();
  const h = await harness();
  try {
    h.ctx.ui.custom = (() => gate.promise) as typeof h.ctx.ui.custom;
    const pending = h.command("model");
    await new Promise((resolve) => setImmediate(resolve));
    await h.emit("session_start");
    gate.resolve(other); await pending;
    assert.equal((await loadConfig(join(h.dir, "config.json"))).provider, "translator");
    assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test("status shows current switch, selected model and saved startup default separately", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    await h.toggle(); await h.command("status");
    assert.match(h.notifications.at(-1)!, /翻译：on/);
    assert.match(h.notifications.at(-1)!, /翻译模型：translator\/small/);
    assert.match(h.notifications.at(-1)!, /新对话默认：off/);
  } finally { await h.close(); }
});
