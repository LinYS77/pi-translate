import { test } from "node:test";
import assert from "node:assert/strict";
import type { Translation } from "../src/translator.ts";
import { deferred, harness } from "./helpers.ts";

const spinner = /^译 on [⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙]$/;

test("input progress is one animated icon and stops when translation completes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gate = deferred<Translation>();
  const h = await harness(async () => gate.promise);
  try {
    const pending = h.input("请检查");
    assert.equal(h.status, "译 on ⠹");
    t.mock.timers.tick(80);
    assert.match(h.status, spinner);
    assert.notEqual(h.status, "译 on ⠹");
    assert.ok(!h.status.includes("输入") && !h.status.includes("EN"));
    gate.resolve({ text: "Inspect", changed: true }); await pending;
    assert.equal(h.status, "译 on");
    const writes = h.statusHistory.length;
    t.mock.timers.tick(800);
    assert.equal(h.statusHistory.length, writes);
  } finally { await h.close(); }
});

test("output uses the same compact icon, including when toggled off mid-translation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gate = deferred<Translation>();
  const h = await harness(async (_r, _text, direction) => direction === "en" ? { text: "Inspect", changed: true } : gate.promise);
  try {
    await h.start(); await h.turn();
    const pending = h.settle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.status, "译 on ⠹");
    t.mock.timers.tick(80); assert.match(h.status, spinner);
    await h.toggle(); assert.match(h.status, /^译 off [⠹⠸⠼⠴⠦⠧⠇⠏⠋⠙]$/);
    gate.resolve({ text: "完成", changed: true }); await pending;
    assert.equal(h.status, "译 off");
    const writes = h.statusHistory.length;
    t.mock.timers.tick(800); assert.equal(h.statusHistory.length, writes);
  } finally { await h.close(); }
});

test("cancellation stops animation without executing the original input", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(async (_r, _text, _direction, _config, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  try {
    const pending = h.input("不得丢失");
    h.key("\u001b");
    assert.deepEqual(await pending, { action: "handled" });
    assert.equal(h.status, "译 on");
    assert.equal(h.editor, "不得丢失");
    const writes = h.statusHistory.length;
    t.mock.timers.tick(800); assert.equal(h.statusHistory.length, writes);
  } finally { await h.close(); }
});

test("session replacement disposes the old animation and discards its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gate = deferred<Translation>();
  const h = await harness(async () => gate.promise);
  try {
    const pending = h.input("旧会话的输入");
    await h.emit("session_start");
    assert.equal(h.status, "译 on");
    const writes = h.statusHistory.length;
    t.mock.timers.tick(800); assert.equal(h.statusHistory.length, writes);
    gate.resolve({ text: "Late", changed: true });
    assert.deepEqual(await pending, { action: "handled" });
    assert.equal(h.statusHistory.length, writes);
  } finally { await h.close(); }
});

test("shutdown clears status and cannot leave an interval alive", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const gate = deferred<Translation>();
  const h = await harness(async () => gate.promise);
  try {
    const pending = h.input("退出时仍在翻译");
    await h.emit("session_shutdown");
    assert.equal(h.statusHistory.at(-1), undefined);
    const writes = h.statusHistory.length;
    t.mock.timers.tick(800); assert.equal(h.statusHistory.length, writes);
    gate.resolve({ text: "Late", changed: true }); await pending;
    assert.equal(h.statusHistory.length, writes);
  } finally { await h.close(); }
});
