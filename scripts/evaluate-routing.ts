import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createTranslationPlan } from "../src/translation-plan.ts";
import { classifySegments } from "../src/jev-classifier.ts";
import { RequestBudget } from "../src/request-budget.ts";
import { defaults } from "../src/config.ts";
import { translate } from "../src/translator.ts";
import { routingCases } from "../test/fixtures/routing.ts";

// No history or project files are sampled. Network calls require explicit --live.
const live = process.argv.includes("--live");
const baselinePath = process.env.PI_TRANSLATE_EVAL_BASELINE;
const baseline = baselinePath
  ? ((await import(baselinePath)) as {
      translate: typeof translate;
      protect: (
        text: string,
        direction: string,
      ) => { needsTranslation: boolean };
    })
  : undefined;
const registry = live
  ? new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false }))
  : undefined;
const config = {
  ...defaults,
  decisionMode: "jev" as const,
  classifierProvider: "typesafe",
  classifierModel: "jev-latest",
};
const rows = [];
for (const example of routingCases) {
  const plan = createTranslationPlan(example.text, example.direction);
  const local = plan.segments.some((s) => s.local === "translate");
  const warnings: string[] = [];
  const start = performance.now();
  const budget = new RequestBudget(30000);
  try {
    const decisions =
      registry && plan.segments.length
        ? await classifySegments(
            registry,
            plan.segments,
            example.direction,
            config,
            budget,
            (m) => warnings.push(m),
          )
        : new Map();
    const jev = registry
      ? plan.segments.some(
          (s) => (decisions.get(s.id) ?? s.local) === "translate",
        )
      : undefined;
    rows.push({
      id: example.id,
      expected: example.translate,
      baseline: baseline?.protect(example.text, example.direction)
        .needsTranslation,
      local,
      jev,
      classified: decisions.size,
      fallback: warnings.length > 0,
      elapsedMs: Math.round(performance.now() - start),
      usage: budget.usage,
    });
  } finally {
    budget.dispose();
  }
}
console.log(
  JSON.stringify(
    {
      mode: live ? "live typesafe/jev-latest" : "offline",
      rows,
      errors: {
        baseline: baseline
          ? rows.filter((r) => r.baseline !== r.expected).map((r) => r.id)
          : undefined,
        local: rows.filter((r) => r.local !== r.expected).map((r) => r.id),
        jev: live
          ? rows.filter((r) => r.jev !== r.expected).map((r) => r.id)
          : undefined,
      },
    },
    null,
    2,
  ),
);
if (registry && process.argv.includes("--translate")) {
  const provider = process.env.PI_TRANSLATE_EVAL_PROVIDER;
  const model = process.env.PI_TRANSLATE_EVAL_MODEL;
  if (!provider || !model)
    throw new Error(
      "--translate needs explicit PI_TRANSLATE_EVAL_PROVIDER and PI_TRANSLATE_EVAL_MODEL",
    );
  for (const direction of ["en", "zh"] as const) {
    const text =
      direction === "en"
        ? "先检查原因，不要修改 `src/main.ts`，也不要重新运行训练。"
        : "The update is complete.\n\n```ts\nconst label = '保存';\n```\n\nWarning: do not retry after 42 seconds.";
    for (const route of [...(baseline ? ["baseline"] : []), "local", "jev"]) {
      let chatRequests = 0;
      let classifierRequests = 0;
      let requestBytes = 0;
      const stream = registry.streamSimple.bind(registry);
      const classify = registry.classify.bind(registry);
      registry.streamSimple = (...args) => {
        chatRequests++;
        requestBytes += Buffer.byteLength(JSON.stringify(args[1]));
        return stream(...args);
      };
      registry.classify = (...args) => {
        classifierRequests++;
        requestBytes += Buffer.byteLength(JSON.stringify(args[1]));
        return classify(...args);
      };
      const start = performance.now();
      try {
        const result = await (
          route === "baseline" ? baseline!.translate : translate
        )(registry, text, direction, {
          ...config,
          decisionMode: route === "jev" ? "jev" : "local",
          provider,
          model,
          timeoutMs: 120000,
        });
        console.log(
          JSON.stringify(
            {
              route,
              direction,
              elapsedMs: Math.round(performance.now() - start),
              chatRequests,
              classifierRequests,
              requestBytes,
              ...result,
            },
            null,
            2,
          ),
        );
      } finally {
        registry.streamSimple = stream;
        registry.classify = classify;
      }
    }
  }
}
