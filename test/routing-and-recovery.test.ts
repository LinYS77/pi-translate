import { test } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai";
import { translate } from "../src/translator.ts";
import { createTranslationPlan } from "../src/translation-plan.ts";
import { defaults } from "../src/config.ts";
import { routingCases } from "./fixtures/routing.ts";
import { FAILURE, NOTICE, OUTPUT } from "../src/extension.ts";
import {
  assistant,
  deferred,
  flushUI,
  harness,
  model,
  userText,
} from "./helpers.ts";

const config = { ...defaults, provider: model.provider, model: model.id };
function service(
  response: (
    text: string,
    count: number,
  ) => ReturnType<typeof assistant> | Promise<ReturnType<typeof assistant>>,
) {
  const texts: string[] = [];
  const signals: AbortSignal[] = [];
  return {
    texts,
    signals,
    find: () => model,
    streamSimple: (
      _model: unknown,
      context: Context,
      options: { signal?: AbortSignal },
    ) => {
      texts.push(userText(context));
      signals.push(options.signal!);
      return { result: async () => response(texts.at(-1)!, texts.length) };
    },
  };
}

for (const example of routingCases) {
  test(`local judgment fixture: ${example.id}`, () => {
    const plan = createTranslationPlan(example.text, example.direction);
    assert.equal(
      plan.segments.some((s) => s.local === "translate"),
      example.translate,
    );
    assert.equal(plan.assemble(new Map()), example.text);
  });
}

test("long output cannot amplify into unlimited fragment requests", async () => {
  const r = service((text) => assistant(text.replace("Paragraph", "段落")));
  const source = Array.from({ length: 100 }, (_, i) => `Paragraph ${i}.`).join(
    "\n\n",
  );
  const result = await translate(r as never, source, "zh", config);
  assert.ok(r.texts.length <= 64);
  assert.equal(result.status, "partial");
  assert.match(result.warnings!.join(""), /预算/);
  assert.ok(result.text.endsWith("Paragraph 99."));
});

test("usage sums optional reasoning/cache breakdowns across completed fragment requests", async () => {
  const r = service((text, n) => {
    const response = assistant(text.replace("paragraph", "段落"));
    response.usage = {
      ...response.usage,
      input: n,
      output: n + 1,
      totalTokens: 2 * n + 1,
      reasoning: n,
      cacheWrite1h: n,
    };
    return response;
  });
  const result = await translate(
    r as never,
    "First paragraph.\n\nSecond paragraph.",
    "zh",
    config,
  );
  assert.equal(result.usage?.input, 3);
  assert.equal(result.usage?.output, 5);
  assert.equal(result.usage?.totalTokens, 8);
  assert.equal(result.usage?.reasoning, 3);
  assert.equal(result.usage?.cacheWrite1h, 3);
});

test("source offsets preserve CRLF, tables, nested lists, emoji, combining characters and fenced code", () => {
  const source =
    "# Heading 👩‍💻 e\u0301\r\n\r\n- First item.\r\n  - Nested item.\r\n\r\n| Name | Value |\r\n| --- | --- |\r\n| `a|b` | Two |\r\n\r\n> ~~~~js\r\n> const secret = 42;\r\n> ~~~~\r\n\r\nLast paragraph.\r\n";
  const plan = createTranslationPlan(source, "zh");
  assert.equal(plan.assemble(new Map()), source);
  assert.ok(!plan.segments.some((s) => s.text.includes("secret")));
  const replacements = new Map(plan.segments.map((s) => [s.id, "译文"]));
  const result = plan.assemble(replacements);
  assert.ok(result.includes("> const secret = 42;\r\n"));
  assert.ok(result.includes("| --- | --- |\r\n"));
  assert.ok(result.includes("| `a|b` | 译文 |"));
  assert.ok(result.includes("  - 译文"));
  for (const segment of plan.segments)
    assert.equal(source.slice(segment.start, segment.end), segment.text);
});

test("short English warnings translate while existing Chinese sentences are not sent", async () => {
  const r = service((text) =>
    assistant(
      text.replace("Do not retry.", "不要重试。").replace("STOP", "停止"),
    ),
  );
  const result = await translate(
    r as never,
    "已完成。Do not retry.\n\nSTOP",
    "zh",
    config,
  );
  assert.equal(result.text, "已完成。不要重试。\n\n停止");
  assert.ok(r.texts.every((text) => !text.includes("已完成")));
});

test("input failure after a successful segment blocks all submission and preserves original", async () => {
  const h = await harness(translate);
  const r = service((text, n) =>
    assistant(
      n === 1 ? "Inspect first." : text.replace(/PI_KEEP_\w+?_END/g, ""),
    ),
  );
  Object.assign(h.ctx.modelRegistry, r);
  const original = "先检查。\n\n不要修改 `important_file`。";
  try {
    assert.deepEqual(await h.input(original), { action: "handled" });
    assert.equal(h.editor, original);
    assert.equal(r.texts.length, 3);
    assert.equal(h.entries.filter((e) => e.customType === FAILURE).length, 1);
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 0);
  } finally {
    await h.close();
  }
});

test("settled partial output persists exactly one warning and no duplicate full failure", async () => {
  const h = await harness(translate);
  const r = service((text) =>
    assistant(text.startsWith("First") ? "第一段。" : "missing literal"),
  );
  Object.assign(h.ctx.modelRegistry, r);
  try {
    await h.start("English input");
    await h.turn(assistant("First paragraph.\n\nKeep `literal` unchanged."));
    await h.settle();
    const output = h.entries.filter((e) => e.customType === OUTPUT);
    assert.equal(output.length, 1);
    assert.equal(output[0].data.status, "partial");
    assert.equal(
      output[0].data.translated,
      "第一段。\n\nKeep `literal` unchanged.",
    );
    assert.equal(h.entries.filter((e) => e.customType === NOTICE).length, 1);
    assert.equal(h.entries.filter((e) => e.customType === FAILURE).length, 0);
    assert.equal(
      h.notifications.filter((s) => s.includes("部分段落保留原文")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("all output segments failing leaves only the original answer and one failure", async () => {
  const h = await harness(translate);
  Object.assign(
    h.ctx.modelRegistry,
    service(() => assistant("bad", "length")),
  );
  try {
    await h.start("English input");
    await h.turn(assistant("First paragraph.\n\nSecond paragraph."));
    await h.settle();
    assert.equal(h.entries.filter((e) => e.customType === OUTPUT).length, 0);
    assert.equal(h.entries.filter((e) => e.customType === FAILURE).length, 1);
  } finally {
    await h.close();
  }
});

test("one shared deadline keeps already completed output, never gives each segment a new timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred<ReturnType<typeof assistant>>();
  const r = service((_text, n) =>
    n === 1 ? first.promise : new Promise(() => {}),
  );
  const request = translate(r as never, "First.\n\nSecond.", "zh", {
    ...config,
    timeoutMs: 1000,
  });
  t.mock.timers.tick(900);
  first.resolve(assistant("第一段。"));
  await flushUI();
  assert.equal(r.texts.length, 2);
  t.mock.timers.tick(100);
  const result = await request;
  assert.equal(result.status, "partial");
  assert.equal(result.text, "第一段。\n\nSecond.");
  assert.ok(r.signals[1].aborted);
});

test("cancellation after a completed output segment discards the entire display operation", async () => {
  const controller = new AbortController();
  const late = deferred<ReturnType<typeof assistant>>();
  const r = service((_text, n) =>
    n === 1 ? assistant("第一段。") : late.promise,
  );
  const request = translate(
    r as never,
    "First.\n\nSecond.",
    "zh",
    config,
    controller.signal,
  );
  await flushUI();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(request, /user cancelled/);
  late.resolve(assistant("迟到"));
  assert.ok(r.signals[1].aborted);
});

test("oversized fragments are explicitly rejected, not truncated or silently omitted", async () => {
  const r = service(() => assistant("bad"));
  await assert.rejects(
    translate(
      { ...r, find: () => ({ ...model, contextWindow: 9000 }) } as never,
      "检查".repeat(10000),
      "en",
      config,
    ),
    /容量/,
  );
  assert.equal(r.texts.length, 0);
});
