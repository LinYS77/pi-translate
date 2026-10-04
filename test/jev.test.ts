import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ClassifierContext,
  ClassifierResult,
  Context,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { translate } from "../src/translator.ts";
import { defaults } from "../src/config.ts";
import {
  classifySegments,
  type JudgmentDiagnostic,
} from "../src/jev-classifier.ts";
import { createTranslationPlan } from "../src/translation-plan.ts";
import { RequestBudget } from "../src/request-budget.ts";
import { NOTICE, OUTPUT } from "../src/extension.ts";
import {
  assistant,
  deferred,
  flushUI,
  harness,
  model,
  userText,
} from "./helpers.ts";

const config = {
  ...defaults,
  provider: model.provider,
  model: model.id,
  decisionMode: "jev" as const,
  classifierProvider: "typesafe",
  classifierModel: "jev-latest",
};
function setup(answer: (ctx: ClassifierContext) => Partial<ClassifierResult>) {
  const classifications: ClassifierContext[] = [];
  const chats: Context[] = [];
  const registry = {
    find: () => model,
    findOfType: () => ({
      provider: "typesafe",
      id: "jev-latest",
      contextWindow: 64000,
    }),
    classify: async (_m: unknown, ctx: ClassifierContext) => {
      classifications.push(ctx);
      return { stopReason: "stop", answers: {}, ...answer(ctx) };
    },
    streamSimple: (_m: unknown, ctx: Context) => {
      chats.push(ctx);
      return {
        result: async () =>
          assistant(
            userText(ctx)
              .replace("Docker", "容器平台")
              .replace("Warning", "警告"),
          ),
      };
    },
  } as unknown as ModelRegistry;
  return { registry, classifications, chats };
}
const choice = (value: string, probability = 0.99) => ({
  type: "choice" as const,
  choice: value,
  confidence: 0.95,
  probabilities: {
    translate: value === "translate" ? probability : 1 - probability,
    keep: value === "keep" ? probability : 0,
    uncertain: 0,
  },
});

test("opt-in diagnostics distinguish rejection causes without exposing text or weakening gates", async () => {
  const answers = [
    undefined,
    { ...choice("translate"), confidence: 0.49 },
    choice("translate", 0.7),
    {
      ...choice("translate"),
      probabilities: { translate: 0.9, keep: 0.9, uncertain: 0 },
    },
    {
      ...choice("uncertain"),
      probabilities: { translate: 0, keep: 0, uncertain: 1 },
    },
    choice("translate"),
  ];
  // A low-probability answer must otherwise have a valid normalized distribution.
  answers[2] = {
    ...choice("translate", 0.7),
    probabilities: { translate: 0.7, keep: 0.3, uncertain: 0 },
  };
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).flatMap((id, i) =>
        answers[i] ? [[id, answers[i]!]] : [],
      ),
    ),
  }));
  const source = Array.from({ length: 6 }, () => "Private phrase.").join(
    "\n\n",
  );
  const plan = createTranslationPlan(source, "zh");
  const diagnostics: JudgmentDiagnostic[] = [];
  const budget = new RequestBudget(1000);
  try {
    const decisions = await classifySegments(
      h.registry,
      plan.segments,
      "zh",
      config,
      budget,
      (d) => diagnostics.push(d),
    );
    assert.deepEqual(
      diagnostics.map((d) => d.reason),
      [
        "missing-answer",
        "low-confidence",
        "low-probability",
        "invalid-distribution",
        "uncertain",
        "accepted",
      ],
    );
    assert.equal(decisions.size, 1);
    assert.ok(!JSON.stringify(diagnostics).includes("Private"));
  } finally {
    budget.dispose();
  }
});

test("Chinese inside protected literals does not turn clear English into a language ambiguity", async () => {
  const h = setup(() => {
    throw new Error("must not classify protected literals");
  });
  const source = "Warning: do not edit `中文目录` or the label “保存”.";
  const result = await translate(h.registry, source, "zh", config);
  assert.equal(h.classifications.length, 0);
  assert.ok(result.text.includes("`中文目录`"));
  assert.ok(result.text.includes("“保存”"));
});

test("clear English prose stays local and cannot be voted away by Jev", async () => {
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).map((id) => [id, choice("keep")]),
    ),
  }));
  const result = await translate(
    h.registry,
    "Warning: do not retry.\n\nInspect the files first.\n\n使用 Docker 部署。",
    "zh",
    config,
  );
  assert.equal(h.classifications.length, 1);
  assert.deepEqual(
    (h.classifications[0].state.segments as { text: string }[]).map(
      (s) => s.text,
    ),
    ["使用 Docker 部署。"],
  );
  assert.equal(h.chats.length, 2);
  assert.ok(result.text.startsWith("警告"));
  const plan = createTranslationPlan("Warning: do not retry.", "zh");
  assert.equal(
    plan.select(new Map([[plan.segments[0].id, "keep"]])).segments.length,
    1,
  );
});

test("invalid, missing or uncertain answers silently fall back without losing valid decisions", async () => {
  const h = setup((ctx) => {
    const ids = Object.keys(ctx.questions);
    return {
      answers: {
        [ids[0]]: choice("keep"),
        [ids[1]]: { ...choice("translate"), confidence: NaN },
        bogus: choice("translate"),
      },
    };
  });
  const warnings: string[] = [];
  const result = await translate(
    h.registry,
    "Docker.\n\nDeployment ready.\n\nChanges pending.",
    "zh",
    config,
    undefined,
    (m) => warnings.push(m),
  );
  assert.equal(h.classifications.length, 1);
  assert.equal(h.chats.length, 2);
  assert.ok(result.text.startsWith("Docker."));
  assert.deepEqual(warnings, []);
  assert.deepEqual(result.warnings, []);
});

test("silent fallback adds no UI notice, but actual partial translations still warn", async () => {
  for (const partial of [false, true]) {
    const h = await harness(translate, { ...config, enabled: true });
    const r = setup(() => ({}));
    r.registry.streamSimple = (_model, ctx) =>
      ({
        result: async () =>
          userText(ctx).startsWith("Warning")
            ? assistant("警告：不要重试。")
            : assistant("第二段。", partial ? "length" : "stop"),
      }) as ReturnType<ModelRegistry["streamSimple"]>;
    Object.assign(h.ctx.modelRegistry, r.registry);
    try {
      await h.start("English input");
      await h.turn(assistant("Warning: do not retry.\n\nSecond paragraph."));
      await h.settle();
      const notices = h.entries.filter((e) => e.customType === NOTICE);
      assert.equal(notices.length, partial ? 1 : 0);
      if (partial) assert.match(notices[0].data.message, /部分段落保留原文/);
      assert.deepEqual(h.notifications, []);
      assert.equal(
        h.entries.find((e) => e.customType === OUTPUT)?.data.status,
        partial ? "partial" : "complete",
      );
    } finally {
      await h.close();
    }
  }
});

test("a provider failure diagnoses all remaining candidates without retries or leaking the exception", async () => {
  const h = setup(() => {
    throw new Error("https://secret.example?key=private");
  });
  const plan = createTranslationPlan(
    Array.from({ length: 20 }, () => "Deployment ready.").join("\n\n"),
    "zh",
  );
  const diagnostics: JudgmentDiagnostic[] = [];
  const budget = new RequestBudget(1000);
  try {
    const decisions = await classifySegments(
      h.registry,
      plan.segments,
      "zh",
      config,
      budget,
      (d) => diagnostics.push(d),
    );
    assert.equal(decisions.size, 0);
    assert.equal(h.classifications.length, 1);
    assert.deepEqual(diagnostics, [{ reason: "service-error", count: 20 }]);
  } finally {
    budget.dispose();
  }
});

test("an oversized candidate does not suppress later judgments, and diagnostics cannot affect routing", async () => {
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).map((id) => [id, choice("keep")]),
    ),
  }));
  Object.assign(h.registry, {
    findOfType: () => ({
      provider: "typesafe",
      id: "jev-latest",
      contextWindow: 5000,
    }),
  });
  const plan = createTranslationPlan(
    `${"背景".repeat(500)} Docker。\n\nDeployment ready.`,
    "zh",
  );
  for (const throwing of [false, true]) {
    const diagnostics: JudgmentDiagnostic[] = [];
    const budget = new RequestBudget(1000);
    try {
      const decisions = await classifySegments(
        h.registry,
        plan.segments,
        "zh",
        config,
        budget,
        (d) => {
          diagnostics.push(d);
          if (throwing) throw new Error("observer failed");
        },
      );
      assert.equal(decisions.size, 1);
      assert.equal(decisions.get(plan.segments.at(-1)!.id), "keep");
      assert.deepEqual(
        diagnostics.map((d) => d.reason),
        ["capacity", "accepted"],
      );
    } finally {
      budget.dispose();
    }
  }
});

test("context-heavy candidates split into fitting batches instead of losing the whole batch", async () => {
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).map((id) => [id, choice("keep")]),
    ),
  }));
  Object.assign(h.registry, {
    findOfType: () => ({
      provider: "typesafe",
      id: "jev-latest",
      contextWindow: 5000,
    }),
  });
  const text = Array.from(
    { length: 8 },
    () => `${"背景".repeat(180)} Docker。`,
  ).join("\n\n");
  await translate(h.registry, text, "zh", config);
  assert.ok(h.classifications.length > 1);
  assert.equal(
    h.classifications.reduce((n, c) => n + Object.keys(c.questions).length, 0),
    8,
  );
  assert.ok(
    h.classifications.every(
      (c) =>
        Buffer.byteLength(JSON.stringify(c)) +
          Object.keys(c.questions).length * 128 <=
        5000,
    ),
  );
  assert.equal(h.chats.length, 0);
});

test("all candidates are classified in bounded batches without truncating the tail", async () => {
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).map((id) => [id, choice("keep")]),
    ),
  }));
  await translate(
    h.registry,
    Array.from({ length: 19 }, () => "Docker.").join("\n\n"),
    "zh",
    config,
  );
  assert.equal(h.classifications.length, 3);
  assert.equal(
    h.classifications.reduce((n, c) => n + Object.keys(c.questions).length, 0),
    19,
  );
  assert.equal(h.chats.length, 0);
});

test("missing model, unsupported Pi and returned provider errors silently use local rules", async () => {
  for (const mode of ["missing", "unsupported", "error", "lookup-error"]) {
    const h = setup(() => ({ stopReason: "error" }));
    if (mode === "missing") h.registry.findOfType = () => undefined;
    if (mode === "lookup-error")
      h.registry.findOfType = () => {
        throw new Error("catalog unavailable");
      };
    if (mode === "unsupported")
      (h.registry as unknown as { classify: unknown }).classify = undefined;
    const result = await translate(
      h.registry,
      "Deployment ready.",
      "zh",
      config,
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(h.chats.length, 1);
  }
});

test("local mode and deterministic passthroughs never call Jev", async () => {
  const h = setup(() => {
    throw new Error("must not classify");
  });
  await translate(h.registry, "Warning: do not retry.", "zh", {
    ...config,
    decisionMode: "local",
  });
  for (const [text, direction] of [
    ["Inspect files.", "en"],
    ["已完成。", "zh"],
    ["```js\n代码\n```", "en"],
  ] as const)
    await translate(h.registry, text, direction, config);
  assert.equal(h.classifications.length, 0);
});

test("classifier cancellation stops rather than falling back; late replies have no effect", async () => {
  const h = setup(() => ({}));
  const gate = deferred<ClassifierResult>();
  h.registry.classify = () => gate.promise;
  const controller = new AbortController();
  const warnings: string[] = [];
  const request = translate(
    h.registry,
    "Deployment ready.",
    "zh",
    config,
    controller.signal,
    (m) => warnings.push(m),
  );
  controller.abort(new Error("cancel classifier"));
  await assert.rejects(request, /cancel classifier/);
  gate.resolve({ stopReason: "stop", answers: {} } as ClassifierResult);
  await flushUI();
  assert.equal(warnings.length, 0);
  assert.equal(h.chats.length, 0);
});

test("classifier internal timeout falls back within the original operation deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup(() => ({}));
  let classifierSignal: AbortSignal | undefined;
  h.registry.classify = (_m, _c, options) => {
    classifierSignal = options?.signal;
    return new Promise(() => {});
  };
  const result = translate(h.registry, "Deployment ready.", "zh", config);
  t.mock.timers.tick(8000);
  assert.deepEqual((await result).warnings, []);
  assert.ok(classifierSignal?.aborted);
  assert.equal(h.chats.length, 1);
});

test("Jev judges only an inline ambiguity while translation keeps its entire host sentence", async () => {
  const quote = "“情况正在改善”";
  for (const englishHost of [false, true])
    for (const selected of ["prose", "material", "uncertain"] as const) {
      const h = setup((ctx) => {
        const segments = ctx.state.segments as {
          id: string;
          text: string;
          placement: string;
          paragraph: string;
        }[];
        assert.equal(segments.length, 1);
        assert.equal(segments[0].text, quote);
        assert.equal(segments[0].placement, "inline");
        assert.ok(
          segments[0].paragraph.includes(englishHost ? "She said" : "她说"),
        );
        assert.ok(segments[0].paragraph.includes("[candidate]"));
        return {
          answers: {
            [segments[0].id]: {
              type: "choice",
              choice: selected,
              confidence: 1,
              probabilities: {
                prose: selected === "prose" ? 1 : 0,
                material: selected === "material" ? 1 : 0,
                uncertain: selected === "uncertain" ? 1 : 0,
              },
            },
          },
        };
      });
      const sent: string[] = [];
      h.registry.streamSimple = (_m, ctx) => {
        const text = userText(ctx);
        sent.push(text);
        return {
          result: async () =>
            assistant(
              text
                .replace("她说", "She said ")
                .replace("情况正在改善", "Things are improving"),
            ),
        } as ReturnType<ModelRegistry["streamSimple"]>;
      };
      const source = `${englishHost ? "She said " : "她说"}${quote}.`;
      const result = await translate(h.registry, source, "en", config);
      assert.equal(h.classifications.length, 1);
      assert.equal(
        result.text,
        `She said ${selected === "prose" ? "“Things are improving”" : quote}.`,
      );
      assert.equal(sent.length, englishHost && selected !== "prose" ? 0 : 1);
      assert.equal(
        sent.some((text) => text.includes("情况正在改善")),
        selected === "prose",
      );
    }
});

test("Jev gets the role and lead-in for an ambiguous quote, while input instructions cannot be skipped", async () => {
  const quote = "“这是一段普通叙述，还没有给出结论。”";
  const h = setup((context) => {
    const segments = context.state.segments as {
      id: string;
      text: string;
      role: string;
      leadIn: string;
      kind: string;
    }[];
    assert.equal(
      segments.length,
      1,
      "do not ask Jev to overrule known task instructions",
    );
    assert.equal(segments[0].text, quote);
    assert.equal(segments[0].role, "uncertain");
    assert.equal(segments[0].kind, "quote");
    assert.equal(segments[0].leadIn, "她补充说道：");
    return {
      answers: {
        [segments[0].id]: {
          type: "choice",
          choice: "material",
          confidence: 1,
          probabilities: { prose: 0, material: 1, uncertain: 0 },
        },
      },
    };
  });
  h.registry.streamSimple = (_model, ctx) =>
    ({
      result: async () =>
        assistant(
          userText(ctx)
            .replace("她补充说道：", "She added:")
            .replace("请说明你的看法。", "Give your opinion."),
        ),
    }) as ReturnType<ModelRegistry["streamSimple"]>;
  const result = await translate(
    h.registry,
    `她补充说道：\n${quote}\n\n请说明你的看法。`,
    "en",
    config,
  );
  assert.equal(result.text, `She added:\n${quote}\n\nGive your opinion.`);
  assert.equal(h.classifications.length, 1);
  assert.deepEqual(result.warnings, []);
});

test("uncertain input roles preserve material on classifier failure but can translate confirmed narrative", async () => {
  const quote = "“这是一段叙述，尚未结束。”";
  for (const selected of [
    "prose",
    "material",
    "uncertain",
    "invalid",
  ] as const) {
    const h = setup((ctx) => ({
      answers: Object.fromEntries(
        Object.keys(ctx.questions).map((id) => [
          id,
          selected === "invalid"
            ? choice("translate")
            : {
                type: "choice",
                choice: selected,
                confidence: 1,
                probabilities: {
                  prose: selected === "prose" ? 1 : 0,
                  material: selected === "material" ? 1 : 0,
                  uncertain: selected === "uncertain" ? 1 : 0,
                },
              },
        ]),
      ),
    }));
    const sent: string[] = [];
    h.registry.streamSimple = (_model, ctx) => {
      const text = userText(ctx);
      sent.push(text);
      return {
        result: async () =>
          assistant(
            text
              .replace("她说：", "She said:")
              .replace(
                "这是一段叙述，尚未结束。",
                "This narrative is not finished.",
              ),
          ),
      } as ReturnType<ModelRegistry["streamSimple"]>;
    };
    const result = await translate(
      h.registry,
      `她说：\n${quote}`,
      "en",
      config,
    );
    assert.equal(
      result.text,
      selected === "prose"
        ? "She said:\n“This narrative is not finished.”"
        : `She said:\n${quote}`,
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(
      sent.some((s) => s.includes("这是一段叙述")),
      selected === "prose",
    );
  }
});

test("Jev judges ambiguous candidates before local heuristics and sees only current readable text", async () => {
  const h = setup((ctx) => ({
    answers: Object.fromEntries(
      Object.keys(ctx.questions).map((id) => [id, choice("translate")]),
    ),
  }));
  const result = await translate(
    h.registry,
    "使用 Docker 部署。",
    "zh",
    config,
  );
  assert.equal(h.classifications.length, 1);
  const context = h.classifications[0];
  assert.deepEqual(Object.keys(context).sort(), ["questions", "state"]);
  assert.match(JSON.stringify(context.state), /使用 Docker 部署/);
  for (const [id, question] of Object.entries(context.questions))
    assert.ok(question.instructions.includes(id));
  assert.equal(result.text, "使用 容器平台 部署。");
});
