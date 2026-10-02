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
import { assistant, deferred, flushUI, model, userText } from "./helpers.ts";

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

test("invalid, missing or uncertain answers visibly fall back once without losing valid decisions", async () => {
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
    "Docker.\n\nWarning: do not retry.\n\nWarning: unsafe.",
    "zh",
    config,
    undefined,
    (m) => warnings.push(m),
  );
  assert.equal(h.classifications.length, 1);
  assert.equal(h.chats.length, 2);
  assert.ok(result.text.startsWith("Docker."));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /回退本地/);
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

test("missing model, unsupported Pi and returned provider errors visibly use local rules", async () => {
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
      "Warning: do not retry.",
      "zh",
      config,
    );
    assert.match(result.warnings!.join(""), /回退本地/);
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
    "Warning: do not retry.",
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
  const result = translate(h.registry, "Warning: do not retry.", "zh", config);
  t.mock.timers.tick(8000);
  assert.match((await result).warnings!.join(""), /回退本地/);
  assert.ok(classifierSignal?.aborted);
  assert.equal(h.chats.length, 1);
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
