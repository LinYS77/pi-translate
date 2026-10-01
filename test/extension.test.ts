import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { assistant, deferred, harness } from "./helpers.ts";
import { FAILURE, OUTPUT } from "../src/extension.ts";
import type { Translation } from "../src/translator.ts";

const outputs = (h: Awaited<ReturnType<typeof harness>>) => h.entries.filter((e) => e.customType === OUTPUT);

test("disabled is transparent, shortcut toggles status without dialogs", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    assert.deepEqual(await h.start("原样输入"), { action: "continue" });
    await h.turn(); await h.settle();
    assert.equal(h.calls.length, 0); assert.equal(h.entries.length, 0);
    await h.toggle(); assert.match(h.status, /译 开/);
    assert.equal(h.notifications.length, 0);
  } finally { await h.close(); }
});

test("single input transform and only settled final body is translated", async () => {
  const h = await harness();
  try {
    assert.equal((await h.start()).action, "transform");
    const progress = assistant("I will inspect the files", "toolUse");
    progress.content.push({ type: "toolCall", id: "tool", name: "read", arguments: { path: "secret.txt" } });
    await h.emit("message_end", { message: progress });
    await h.turn(progress);
    await h.emit("agent_end", { messages: [progress] });
    assert.equal(h.calls.length, 1);
    await h.emit("turn_start");
    const final = assistant("# Result\nDo not rerun training.");
    final.content.unshift({ type: "thinking", thinking: "private reasoning" });
    await h.turn(final);
    await h.emit("agent_before_settle", { outcome: "completed" });
    assert.equal(h.calls.length, 1);
    await h.emit("agent_settled");
    assert.deepEqual(h.calls.map((c) => c.text), ["请检查", "# Result\nDo not rerun training."]);
    assert.equal(outputs(h).length, 1);
    assert.equal(outputs(h)[0].data.messageEntryId, "answer-id");
    assert.equal(final.content[1].type === "text" && final.content[1].text, "# Result\nDo not rerun training.");
    await h.emit("agent_settled"); assert.equal(outputs(h).length, 1);
  } finally { await h.close(); }
});

test("run snapshot survives toggles, queued prompts, retries and further boundaries", async () => {
  const h = await harness();
  try {
    await h.start(); await h.toggle();
    assert.match(h.status, /本任务开/);
    assert.deepEqual(await h.input("不要训练", { streamingBehavior: "steer" }), { action: "continue" });
    await h.turn(assistant("Not final"));
    await h.emit("agent_before_settle", { outcome: "completed" });
    await h.emit("agent_start"); await h.emit("turn_start");
    await h.turn(assistant("Actual final"), "actual"); await h.settle();
    assert.equal(outputs(h).length, 1);
    assert.equal(outputs(h)[0].data.original, "Actual final");
    await h.start("下一轮"); await h.toggle();
    await h.turn(assistant("Untranslated run")); await h.settle();
    assert.equal(outputs(h).length, 1);
  } finally { await h.close(); }
});

for (const reason of ["aborted", "error", "length", "toolUse", "pending", "deferred"] as const) {
  test(`no final translation for ${reason}`, async () => {
    const h = await harness();
    try { await h.start(); await h.turn(assistant("Do not use this", reason)); await h.settle(); assert.equal(outputs(h).length, 0); }
    finally { await h.close(); }
  });
}
test("abort/error settlement, Escape, no answer, and stale prior answers are excluded", async () => {
  const h = await harness();
  try {
    for (const outcome of ["aborted", "error"]) {
      await h.start(); await h.turn(); await h.settle(outcome);
    }
    await h.start(); await h.turn(); h.key("\u001b"); await h.settle();
    await h.start(); await h.settle();
    await h.start(); await h.turn(); await h.emit("turn_start"); await h.settle();
    await h.start(); await h.turn(); await h.emit("message_start", { message: { role: "user" } }); await h.settle();
    assert.equal(outputs(h).length, 0);
  } finally { await h.close(); }
});

test("input failure blocks execution, preserves draft/attachments and is explicitly recoverable", async () => {
  const h = await harness(async () => { throw new Error("network failure"); });
  try {
    h.editor = "new draft";
    const images = [{ type: "image", mimeType: "image/png", data: "original-image" }];
    assert.deepEqual(await h.input("不能丢失", { images }), { action: "handled" });
    assert.equal(h.editor, "new draft");
    const failure = h.entries.find((e) => e.customType === FAILURE)!;
    assert.equal(failure.data.original, "不能丢失"); assert.deepEqual(failure.data.images, images);
    assert.match(h.notifications[0], /未提交/);
    await h.command("recover"); assert.equal(h.editor, "new draft");
    h.editor = ""; await h.command("recover"); assert.equal(h.editor, "不能丢失");
  } finally { await h.close(); }
});

test("output failure leaves the completed task and original answer intact", async () => {
  const h = await harness(async (_registry, text, direction) => {
    if (direction === "zh") throw new Error("timeout");
    return { text: "Inspect", changed: true };
  });
  try {
    await h.start(); const original = assistant("Completed answer"); await h.turn(original); await h.settle();
    assert.deepEqual(original, { ...original, content: [{ type: "text", text: "Completed answer" }] });
    assert.equal(outputs(h).length, 0); assert.equal(h.entries.at(-1)?.customType, FAILURE);
  } finally { await h.close(); }
});

test("pending input snapshots toggle and duplicate Enter cannot overtake it", async () => {
  const gate = deferred<Translation>();
  const h = await harness(async (_r, text, direction) => direction === "en" ? gate.promise : { text: "最终译文", changed: true });
  try {
    const pending = h.input("第一份");
    await h.toggle();
    assert.deepEqual(await h.input("第二份"), { action: "handled" });
    gate.resolve({ text: "First", changed: true });
    assert.equal((await pending).action, "transform");
    await h.emit("before_agent_start", { prompt: "First" }); await h.emit("agent_start");
    await h.turn(); await h.settle(); assert.equal(outputs(h).length, 1);
  } finally { await h.close(); }
});

test("session replacement discards late translation and cannot mix answers", async () => {
  const gate = deferred<Translation>();
  const h = await harness(async (_r, text, direction) => direction === "zh" ? gate.promise : { text: "Inspect", changed: true });
  try {
    await h.start(); await h.turn();
    const pending = h.settle();
    await new Promise((resolve) => setImmediate(resolve));
    await h.emit("session_start");
    gate.resolve({ text: "不能插入新会话", changed: true }); await pending;
    assert.equal(outputs(h).length, 0);
  } finally { await h.close(); }
});

test("saved translation model is reused in a new session while the toggle follows its saved default", async () => {
  const h = await harness(undefined, { enabled: false });
  try {
    await h.command("model other small-2");
    const saved = await loadConfig(join(h.dir, "config.json"));
    assert.equal(saved.provider, "other");
    assert.equal(saved.model, "small-2");
    assert.equal(saved.enabled, false);
    await h.toggle();
    assert.match(h.status, /译 开/);
    await h.emit("session_start");
    assert.match(h.status, /译 关/);
    await h.toggle();
    await h.start();
    assert.equal(h.calls[0].config.provider, "other");
    assert.equal(h.calls[0].config.model, "small-2");
  } finally { await h.close(); }
});

test("model changes don't change the model snapshot of an active task", async () => {
  const h = await harness();
  try {
    await h.start(); await h.command("model other small-2"); await h.turn(); await h.settle();
    assert.equal(h.calls.at(-1)?.config.provider, "translator");
    await h.start(); assert.equal(h.calls.at(-1)?.config.provider, "other");
  } finally { await h.close(); }
});

test("a storage/UI reporting failure must never let untranslated input execute", async () => {
  const h = await harness();
  try {
    h.pi.appendEntry = () => { throw new Error("disk full"); };
    h.ctx.ui.notify = () => { throw new Error("UI closed"); };
    h.ctx.ui.setStatus = () => { throw new Error("UI closed"); };
    assert.deepEqual(await h.input("不要丢失"), { action: "handled" });
    assert.equal(h.editor, "不要丢失");
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test("pure English input is exact passthrough even without a configured translation model", async () => {
  const h = await harness(undefined, { provider: undefined, model: undefined });
  try {
    const prompt = " Do NOT train. Keep the existing API.\n";
    assert.deepEqual(await h.start(prompt), { action: "continue" });
    assert.equal(h.calls.length, 0);
    assert.equal(h.entries.length, 0);
    await h.turn(); await h.settle();
    assert.equal(outputs(h).length, 1);
  } finally { await h.close(); }
});

test("pending input is backed up before session replacement and recoverable without resubmitting", async () => {
  const gate = deferred<Translation>();
  const h = await harness(async () => gate.promise);
  try {
    const pending = h.input("原始中文");
    assert.equal(h.entries[0].data.original, "原始中文");
    await h.emit("session_start");
    gate.resolve({ text: "Original Chinese", changed: true });
    assert.deepEqual(await pending, { action: "handled" });
    assert.equal(h.entries.length, 1);
    await h.command("recover");
    assert.equal(h.editor, "原始中文");
  } finally { await h.close(); }
});

test("a leading absolute path is a prompt, not a slash command", async () => {
  const h = await harness();
  try {
    assert.equal((await h.start("/tmp/example.txt 请只检查，不要修改")).action, "transform");
    await h.turn(); await h.settle();
    assert.equal(outputs(h).length, 1);
  } finally { await h.close(); }
});

test("non-TUI, extension inputs and native commands stay untouched", async () => {
  const h = await harness();
  try {
    for (const mode of ["rpc", "json", "print"] as const) {
      Object.assign(h.ctx, { mode });
      assert.deepEqual(await h.input("中文"), { action: "continue" });
    }
    Object.assign(h.ctx, { mode: "tui" });
    assert.deepEqual(await h.input("中文", { source: "extension" }), { action: "continue" });
    assert.deepEqual(await h.input("/skill:inspect 中文参数"), { action: "continue" });
    assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});
