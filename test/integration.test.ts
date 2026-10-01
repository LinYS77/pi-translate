import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { registerTranslation, OUTPUT } from "../src/extension.ts";
import { defaults, saveConfig } from "../src/config.ts";
import { assistant, model } from "./helpers.ts";

async function integration(extra?: (pi: ExtensionAPI) => void) {
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-integration-"));
  const path = join(dir, "pi-translate.json");
  await saveConfig(path, {
    ...defaults,
    enabled: true,
    provider: "test-translation",
    model: "small",
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-store.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const mainRequests: TranscriptContext[] = [];
  const translationRequests: TranscriptContext[] = [];
  const errors: unknown[] = [];
  const mainResponses: AssistantMessage[] = [];
  function stream(message: AssistantMessage) {
    const result = createAssistantMessageEventStream();
    queueMicrotask(() => {
      result.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        result.push({
          type: "error",
          reason: message.stopReason,
          error: message,
        });
      } else {
        result.push({
          type: "done",
          reason: message.stopReason as "stop" | "toolUse",
          message,
        });
      }
      result.end(message);
    });
    return result;
  }
  for (const provider of ["test-main", "test-translation"]) {
    runtime.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://invalid.example",
      apiKey: "test-not-a-real-key",
      models: [{ ...model, id: provider === "test-main" ? "large" : "small" }],
      streamSimple: (_model, context) => {
        if (provider === "test-main") {
          mainRequests.push(structuredClone(context));
          const response =
            mainResponses.shift() ??
            assistant("Final answer: do not rerun training.");
          return stream({ ...response, provider, model: "large" });
        }
        translationRequests.push(structuredClone(context));
        const input = context.messages.find(
          (message) => message.role === "user",
        )!;
        const text = typeof input.content === "string" ? input.content : "";
        return stream({
          ...assistant(
            text === "请检查配置，不要训练。"
              ? "Inspect the configuration. Do not train."
              : "最终回答：不要重新运行训练。",
          ),
          provider,
          model: "small",
        });
      },
    });
  }
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "MAIN SYSTEM SECRET: do the task normally.",
    extensionFactories: [
      (pi) => registerTranslation(pi, path),
      ...(extra ? [extra] : []),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("test-main", "large")!,
    thinkingLevel: "off",
    tools: ["read"],
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
  });
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      setStatus: () => {},
      notify: () => {},
      onTerminalInput: () => () => {},
      getEditorText: () => "",
      setEditorText: () => {},
    } as unknown as ExtensionUIContext,
    onError: (error) => errors.push(error),
  });
  return {
    dir,
    session,
    manager,
    mainRequests,
    translationRequests,
    mainResponses,
    errors,
    outputs: () =>
      manager
        .getEntries()
        .filter((e) => e.type === "custom" && e.customType === OUTPUT),
    async close() {
      session.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("real AgentSession: tool progress stays original, final translation is visible data not context", async () => {
  const h = await integration();
  try {
    const file = join(h.dir, "config.txt");
    await writeFile(file, "TOOL RESULT SECRET");
    const progress = assistant("I will inspect the configuration.", "toolUse");
    progress.content.push({
      type: "toolCall",
      id: "read-1",
      name: "read",
      arguments: { path: file },
    });
    h.mainResponses.push(
      progress,
      assistant("Final answer: do not rerun training."),
    );
    await h.session.prompt("请检查配置，不要训练。");
    assert.equal(h.mainRequests.length, 2);
    assert.equal(h.translationRequests.length, 2);
    assert.equal(h.outputs().length, 1);
    const projected = h.manager.buildSessionContext().messages;
    assert.ok(
      JSON.stringify(projected).includes(
        "Inspect the configuration. Do not train.",
      ),
    );
    assert.ok(
      JSON.stringify(projected).includes(
        "Final answer: do not rerun training.",
      ),
    );
    assert.ok(!JSON.stringify(projected).includes("最终回答"));
    assert.ok(!JSON.stringify(projected).includes("请检查配置"));
    for (const request of h.translationRequests) {
      assert.deepEqual(
        request.messages.map((m) => m.role),
        ["system", "user"],
      );
      assert.ok(!JSON.stringify(request).includes("MAIN SYSTEM SECRET"));
      assert.ok(!JSON.stringify(request).includes("TOOL RESULT SECRET"));
      assert.ok(!JSON.stringify(request).includes("I will inspect"));
      assert.ok(!JSON.stringify(request).includes("toolsAdded"));
    }
    assert.equal(h.session.model?.provider, "test-main");
    await h.session.prompt("Continue in English.");
    const nextRequest = h.mainRequests.at(-1)!;
    assert.ok(!JSON.stringify(nextRequest).includes("最终回答"));
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("real AgentSession: another extension can continue after before_settle; only true final is translated", async () => {
  let continued = false;
  const h = await integration((pi) => {
    pi.on("agent_before_settle", () => {
      if (continued) return;
      continued = true;
      return {
        entries: [
          {
            type: "custom_message",
            customType: "test-continuation",
            content: "CONTINUATION SECRET",
            display: false,
          },
        ],
        continue: true,
      };
    });
  });
  try {
    h.mainResponses.push(
      assistant("Premature conclusion"),
      assistant("Final answer: do not rerun training."),
    );
    await h.session.prompt("请检查配置，不要训练。");
    assert.equal(h.mainRequests.length, 2);
    assert.equal(h.translationRequests.length, 2);
    assert.equal(h.outputs().length, 1);
    assert.ok(
      !JSON.stringify(h.translationRequests).includes("Premature conclusion"),
    );
    assert.ok(
      !JSON.stringify(h.translationRequests).includes("CONTINUATION SECRET"),
    );
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});

test("real AgentSession: aborted/error tasks never translate intermediate text", async () => {
  const h = await integration();
  try {
    for (const reason of ["aborted", "error"] as const) {
      h.mainResponses.push(assistant("Unfinished intermediate text", reason));
      await h.session.prompt("请检查配置，不要训练。");
    }
    assert.equal(h.outputs().length, 0);
    assert.equal(h.translationRequests.length, 2);
    assert.deepEqual(h.errors, []);
  } finally {
    await h.close();
  }
});
