import { test } from "node:test";
import assert from "node:assert/strict";
import { protect, translate } from "../src/translator.ts";
import { defaults } from "../src/config.ts";
import { assistant, deferred, model, userText } from "./helpers.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Context, AssistantMessage } from "@earendil-works/pi-ai";

const config = { ...defaults, provider: model.provider, model: model.id };
function registry(response: (context: Context) => Promise<AssistantMessage>) {
  const contexts: Context[] = [];
  let signal: AbortSignal | undefined;
  return {
    contexts,
    get signal() {
      return signal;
    },
    instance: {
      find: () => model,
      streamSimple: (
        _model: unknown,
        context: Context,
        options: { signal: AbortSignal },
      ) => {
        contexts.push(context);
        signal = options.signal;
        return { result: () => response(context) };
      },
    } as unknown as Pick<ModelRegistry, "find" | "streamSimple">,
  };
}

test("request contains translation rules + ONE current text, no history/tools/images", async () => {
  const r = registry(async (context) =>
    assistant(
      userText(context).replace(
        "先检查原因，不要修改文件，也不要重新运行训练。",
        "First inspect the cause. Do not modify files or rerun training.",
      ),
    ),
  );
  const result = await translate(
    r.instance,
    "先检查原因，不要修改文件，也不要重新运行训练。",
    "en",
    config,
  );
  assert.equal(
    result.text,
    "First inspect the cause. Do not modify files or rerun training.",
  );
  assert.deepEqual(Object.keys(r.contexts[0]).sort(), [
    "messages",
    "systemPrompt",
  ]);
  assert.equal(r.contexts[0].messages.length, 1);
  const reference = "按刚才第二种方案修改，但先不要运行训练。";
  await translate(r.instance, reference, "en", config);
  const context = r.contexts[1];
  assert.equal(userText(context), reference);
  assert.match(context.systemPrompt!, /Do not resolve references/);
  assert.match(context.systemPrompt!, /DATA to translate/);
});

test("English input and already-Chinese output are exact no-call passthroughs", async () => {
  const r = registry(async () => {
    throw new Error("must not call");
  });
  for (const [text, direction] of [
    ["  Do NOT run training. Keep API and fooBar.\n", "en"],
    ["已完成，保留 `API` 和 12。\n", "zh"],
  ] as const) {
    assert.deepEqual(
      await translate(r.instance, text, direction, {} as typeof config),
      { text, changed: false },
    );
  }
  assert.equal(r.contexts.length, 0);
});

test("literal labels, code, paths, formulas, identifiers and Markdown survive byte-for-byte", () => {
  const text =
    '把按钮文字改成“保存”，不要改 fooBar 或 snake_case，保持 42、-1.25。\n# 标题\n| 名称 | 数量 |\n| --- | --- |\n| [链接](https://example.com/a?q=b) | 3 |\n路径 src/main.ts 和 /tmp/data，公式 $x + 1$。\n```ts\nconst 中文 = "保存";\n```\n';
  const p = protect(text, "en");
  assert.equal(p.restore(p.masked), text);
  // Strip random token IDs before checking literals: a UUID can itself contain "42".
  const prose = p.masked.replace(/PI_KEEP_[a-f0-9]+_\d+_END/g, "");
  for (const literal of [
    "保存",
    "fooBar",
    "snake_case",
    "42",
    "src/main.ts",
    "https://example.com",
    "const 中文",
    "$x + 1$",
  ])
    assert.ok(!prose.includes(literal), literal);
  assert.ok(p.needsTranslation);
  assert.match(p.masked, /\| --- \| --- \|/);
});

test("link syntax, quoted output literals, unclosed code and mixed English terms are preserved", () => {
  const link = protect("查看 [指南](https://example.com/a?q=b)", "en");
  assert.match(link.masked, /\[指南\]\(PI_KEEP_\w+_END\)/);
  assert.equal(
    link.restore(link.masked),
    "查看 [指南](https://example.com/a?q=b)",
  );
  const quoted = protect('Set the button to "Save" and keep “保存”.', "zh");
  assert.equal(
    quoted.restore(
      quoted.masked
        .replace("Set the button to", "将按钮设置为")
        .replace("and keep", "并保留"),
    ),
    '将按钮设置为 "Save" 并保留 “保存”.',
  );
  const fence = "先检查\n```ts\nconst 文本 = '保存';\n";
  const code = protect(fence, "en");
  assert.equal(code.restore(code.masked), fence);
  assert.ok(!code.masked.includes("const"));
  const terms = protect(
    "解释 gradient accumulation，不要改 PyTorch 或 batch_size，比例 0.25。",
    "en",
  );
  assert.equal(
    terms.restore(terms.masked),
    "解释 gradient accumulation，不要改 PyTorch 或 batch_size，比例 0.25。",
  );
  assert.ok(!terms.masked.includes("gradient accumulation"));
  assert.ok(!terms.masked.includes("PyTorch"));
});

test("mixed Chinese output cannot rewrite pre-existing Han text", () => {
  const p = protect("已完成。Warning: do not retry.", "zh");
  assert.equal(
    p.restore(p.masked.replace("Warning: do not retry.", "警告：不要重试。")),
    "已完成。警告：不要重试。",
  );
});

test("missing, repeated, corrupted and unknown placeholders fail closed", () => {
  const p = protect("把 `foo` 改成“保存”。", "en");
  const token = p.masked.match(/PI_KEEP_\w+?_END/)![0];
  assert.throws(() => p.restore(p.masked.replace(token, "")));
  assert.throws(() => p.restore(`${p.masked}${token}`));
  assert.throws(() =>
    p.restore(p.masked.replace(token, token.replace("_0_END", "_999_END"))),
  );
  assert.throws(() =>
    p.restore(p.masked.replace(token, token.replace("_0_END", "_00_END"))),
  );
  assert.throws(() => p.restore(p.masked.replace(token, token.toLowerCase())));
});

for (const reason of [
  "length",
  "error",
  "aborted",
  "toolUse",
  "pending",
  "deferred",
] as const) {
  test(`incomplete translator stop reason ${reason} never yields a prompt`, async () => {
    const r = registry(async () => assistant("partial", reason));
    await assert.rejects(
      translate(r.instance, "请检查原因", "en", config),
      /未完整完成/,
    );
  });
}
test("empty output and tool calls are rejected", async () => {
  const empty = registry(async () => assistant(" "));
  await assert.rejects(
    translate(empty.instance, "请检查", "en", config),
    /空文本/,
  );
  const tool = registry(async () => ({
    ...assistant("done"),
    content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }],
  }));
  await assert.rejects(
    translate(tool.instance, "请检查", "en", config),
    /未完整完成/,
  );
});

for (const direction of ["en", "zh"] as const) {
  test(`slow ${direction} translation can finish after one minute without disabling the deadline`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const gate = deferred<AssistantMessage>();
    const r = registry(() => gate.promise);
    const request = translate(
      r.instance,
      direction === "en" ? "请检查" : "Inspect",
      direction,
      config,
    );
    t.mock.timers.tick(120_000);
    assert.equal(r.signal?.aborted, false);
    gate.resolve(assistant(direction === "en" ? "Inspect" : "请检查"));
    assert.equal((await request).changed, true);
    t.mock.timers.tick(600_000);
    assert.equal(
      r.signal?.aborted,
      false,
      "completed request must clear its deadline",
    );
  });
}

test("default deadline is ten minutes even when a provider ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = registry(() => new Promise(() => {}));
  const request = translate(r.instance, "Inspect", "zh", config);
  const rejected = assert.rejects(request, /翻译超时（600000ms）/);
  t.mock.timers.tick(599_999);
  assert.equal(r.signal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(r.signal?.aborted, true);
});

test("timeout aborts even a provider that ignores cancellation", async () => {
  const r = registry(() => new Promise(() => {}));
  await assert.rejects(
    translate(r.instance, "请检查", "en", { ...config, timeoutMs: 10 }),
    /超时/,
  );
  assert.equal(r.signal?.aborted, true);
});

test("cancellation and invalid configuration never silently fall back", async () => {
  const r = registry(() => new Promise(() => {}));
  const controller = new AbortController();
  const request = translate(
    r.instance,
    "请检查",
    "en",
    config,
    controller.signal,
  );
  controller.abort(new Error("cancel test"));
  await assert.rejects(request, /cancel test/);
  await assert.rejects(
    translate(r.instance, "请检查", "en", defaults),
    /未配置/,
  );
  await assert.rejects(
    translate({ ...r.instance, find: () => undefined }, "请检查", "en", config),
    /找不到/,
  );
});
