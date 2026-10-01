import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { loadConfig } from "../src/config.ts";
import { OUTPUT } from "../src/extension.ts";
import { deferred, harness, model, flushUI, finishSave } from "./helpers.ts";

const other = { ...model, provider: "other", id: "fast" };
const text = (h: Awaited<ReturnType<typeof harness>>) => h.panes.at(-1)!.render(76).map(stripVTControlCharacters).join("\n");

test("only /translate is registered; opening uses one native overlay without changing model or input", async () => {
  const h = await harness();
  try {
    const main = h.ctx.model;
    h.editor = "unfinished draft";
    assert.deepEqual([...h.commands.keys()], ["translate"]);
    assert.equal(h.commands.get("translate").getArgumentCompletions, undefined);
    await h.command();
    assert.equal(h.panes.length, 1);
    assert.equal(h.customOptions[0].overlay, true);
    assert.ok(text(h).includes("翻译设置"));
    assert.ok(text(h).includes("translator/small"));
    assert.match(text(h), /当前开关\s+on/);
    assert.equal(h.editor, "unfinished draft");
    assert.equal(h.ctx.model, main);
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("model selection saves without persisting the temporary switch or opening another UI", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    const main = h.ctx.model;
    await h.toggle(); await h.chooseModel(other);
    const saved = await loadConfig(join(h.dir, "config.json"));
    assert.equal(saved.provider, "other"); assert.equal(saved.model, "fast");
    assert.equal(saved.enabled, false);
    assert.equal(h.panes.length, 1);
    assert.match(h.status, /^译 on$/);
    assert.equal(h.ctx.model, main); assert.equal(h.calls.length, 0);
    await h.emit("session_start"); assert.match(h.status, /^译 off$/);
  } finally { await h.close(); }
});

test("cancelled selection and unavailable providers leave configuration intact, with errors inside the pane", async () => {
  const h = await harness();
  try {
    await h.chooseModel();
    assert.equal((await loadConfig(join(h.dir, "config.json"))).provider, "translator");
    h.ctx.modelRegistry.getAvailable = () => [];
    await h.chooseModel();
    assert.equal(h.panes.length, 2);
    assert.match(text(h), /没有可用模型.*\/login/);
    assert.equal(h.notifications.length, 0);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).model, "small");
  } finally { await h.close(); }
});

test("new-session default saves without changing the current switch or active task", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    await h.start(); await h.chooseDefault(true);
    assert.match(h.status, /^译 off$/);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, true);
    await h.turn(); await h.settle();
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 0);
    await h.emit("session_start"); assert.match(h.status, /^译 on$/);
  } finally { await h.close(); }
});

test("menu and model view retain fixed geometry through repeated navigation and saving", async () => {
  const h = await harness();
  try {
    h.uiSteps.push(async (pane) => {
      const height = pane.render(76).length;
      for (let i = 0; i < 5; i++) {
        pane.handleInput("\r"); assert.equal(pane.render(76).length, height);
        await flushUI(); assert.equal(pane.render(76).length, height);
        pane.handleInput("\u001b"); assert.equal(pane.render(76).length, height);
      }
      pane.handleInput("\u001b[B"); pane.handleInput("\u001b[B"); pane.handleInput("\r");
      await finishSave(pane);
      assert.equal(pane.render(76).length, height);
      pane.handleInput("\u001b");
    });
    await h.command();
    assert.equal(h.panes.length, 1);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, false);
  } finally { await h.close(); }
});

test("changing the model cannot accidentally persist an Alt+T switch", async () => {
  const h = await harness();
  try {
    await h.toggle(); await h.chooseModel(other);
    assert.match(h.status, /^译 off$/);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).enabled, true);
    await h.emit("session_start"); assert.match(h.status, /^译 on$/);
  } finally { await h.close(); }
});

test("Escape in the model view returns to the same menu, without cancelling an active task", async () => {
  const gate = deferred<{ aborted: boolean; errors: Map<string, Error> }>();
  const h = await harness();
  try {
    await h.start(); h.ctx.modelRegistry.refresh = () => gate.promise;
    h.uiSteps.push(async (pane) => {
      pane.handleInput("\r"); await flushUI();
      h.key("\u001b"); pane.handleInput("\u001b");
      assert.ok(pane.render(76).map(stripVTControlCharacters).join("\n").includes("翻译设置"));
      pane.handleInput("\u001b");
    });
    await h.command();
    gate.resolve({ aborted: false, errors: new Map() }); await flushUI();
    await h.turn(); await h.settle();
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 1);
    assert.equal(h.panes.length, 1);
  } finally { await h.close(); }
});

test("session replacement closes the overlay and discards a late catalog result", async () => {
  const gate = deferred<{ aborted: boolean; errors: Map<string, Error> }>();
  const opened = deferred<void>();
  const h = await harness();
  try {
    h.ctx.modelRegistry.refresh = () => gate.promise;
    h.uiSteps.push(async (pane) => { pane.handleInput("\r"); await flushUI(); opened.resolve(); });
    const pending = h.command(); await opened.promise;
    await h.emit("session_start"); await pending;
    assert.equal(h.panes[0].isClosed, true);
    const renders = h.renderRequests;
    gate.resolve({ aborted: false, errors: new Map() }); await flushUI();
    assert.equal(h.renderRequests, renders);
    assert.equal((await loadConfig(join(h.dir, "config.json"))).provider, "translator");
    assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test("repeated command while the panel is open cannot mount another overlay", async () => {
  const opened = deferred<void>();
  const h = await harness();
  try {
    h.uiSteps.push(() => { opened.resolve(); });
    const pending = h.command(); await opened.promise;
    await h.command();
    assert.equal(h.panes.length, 1);
    h.panes[0].close(); await pending;
    assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test("closing during a save and reopening serializes model/default writes without losing either", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    let firstSave!: Promise<void>;
    h.uiSteps.push((pane) => {
      pane.handleInput("\u001b[B"); pane.handleInput("\u001b[B"); pane.handleInput("\r");
      firstSave = finishSave(pane);
      pane.close();
    });
    await h.command(); await h.chooseModel(other); await firstSave;
    const saved = await loadConfig(join(h.dir, "config.json"));
    assert.equal(saved.enabled, true);
    assert.equal(saved.provider, "other"); assert.equal(saved.model, "fast");
    assert.equal(h.status, "译 off");
  } finally { await h.close(); }
});

test("every former subcommand is rejected, without aliases, config changes or execution", async () => {
  const h = await harness();
  try {
    const before = await loadConfig(join(h.dir, "config.json"));
    for (const args of ["on", "off", "toggle", "status", "reload", "recover", "model", "model other fast", "default on", "config"]) await h.command(args);
    assert.equal(h.panes.length, 0); assert.equal(h.calls.length, 0);
    assert.deepEqual(await loadConfig(join(h.dir, "config.json")), before);
    assert.ok(h.notifications.every((message) => message === "仅支持 /translate，无需参数"));
  } finally { await h.close(); }
});

test("current/default state is visible in the menu without a separate status command", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    await h.toggle(); await h.command();
    assert.match(text(h), /当前开关\s+on/);
    assert.match(text(h), /新对话默认\s+off/);
    assert.ok(text(h).includes("translator/small"));
  } finally { await h.close(); }
});
