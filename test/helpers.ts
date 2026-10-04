import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  Context,
  Model,
  Api,
} from "@earendil-works/pi-ai";
import {
  initTheme,
  type Theme,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import {
  saveConfig,
  loadConfig,
  defaults,
  type Config,
} from "../src/config.ts";
import { registerTranslation } from "../src/extension.ts";
import type { translate } from "../src/translator.ts";
import type { TranslationSettingsPane } from "../src/settings-pane.ts";

export const model: Model<Api> = {
  id: "small",
  name: "small",
  api: "openai-completions",
  provider: "translator",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 8192,
};
export function assistant(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: "main",
    model: "large",
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export const flushUI = () =>
  new Promise<void>((resolve) => setImmediate(resolve));
export async function finishSave(pane: TranslationSettingsPane) {
  const saving = () => pane.render(76).join("\n").includes("保存中…");
  for (let i = 0; saving() && i < 1000; i++) await flushUI();
  if (saving()) throw new Error("settings save did not finish");
}
export async function harness(
  translateText?: typeof translate,
  overrides: Partial<Config> = {},
) {
  initTheme("dark", false);
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-test-"));
  const configPath = join(dir, "config.json");
  await saveConfig(configPath, {
    ...defaults,
    enabled: true,
    provider: model.provider,
    model: model.id,
    ...overrides,
  });
  const handlers = new Map<
    string,
    ((event: any, ctx: ExtensionContext) => any)[]
  >();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const entries: { type: string; customType: string; data: any }[] = [];
  const notifications: string[] = [];
  const calls: { text: string; direction: string; config: Config }[] = [];
  const statusHistory: (string | undefined)[] = [];
  const uiSteps: ((pane: TranslationSettingsPane) => void | Promise<void>)[] =
    [];
  const panes: TranslationSettingsPane[] = [];
  const customOptions: any[] = [];
  let renderRequests = 0;
  let editor = "";
  let status = "";
  let keyHandler: ((data: string) => unknown) | undefined;
  const ctx = {
    mode: "tui",
    hasUI: true,
    signal: undefined,
    model: { ...model, provider: "main", id: "large" },
    ui: {
      select: () => {
        throw new Error(
          "Settings must stay in one overlay, not reopen a selector",
        );
      },
      custom: (factory: any, options: any) =>
        new Promise((resolve, reject) => {
          customOptions.push(options);
          void Promise.resolve(
            factory(
              {
                terminal: { rows: 40, columns: 80 },
                requestRender: () => {
                  renderRequests++;
                },
              },
              { fg: (_color: unknown, text: string) => text } as Theme,
              getKeybindings(),
              resolve,
            ),
          )
            .then(async (pane: TranslationSettingsPane) => {
              panes.push(pane);
              pane.focused = true;
              const step = uiSteps.shift();
              if (step) await step(pane);
              else pane.handleInput("\u001b");
            })
            .catch(reject);
        }),
      setStatus: (_key: string, value: string | undefined) => {
        status = value ?? "";
        statusHistory.push(value);
      },
      notify: (value: string) => notifications.push(value),
      getEditorText: () => editor,
      setEditorText: (value: string) => {
        editor = value;
      },
      onTerminalInput: (fn: typeof keyHandler) => {
        keyHandler = fn;
        return () => {
          keyHandler = undefined;
        };
      },
    },
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      find: () => model,
      getAvailable: () => [model],
      getError: () => undefined,
      refresh: async () => ({ aborted: false, errors: new Map() }),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerShortcut: (name: string, shortcut: any) =>
      shortcuts.set(name, shortcut),
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  registerTranslation(
    pi,
    configPath,
    translateText ??
      (async (_registry, text, direction, config) => {
        calls.push({ text, direction, config });
        return {
          text: direction === "en" ? `English: ${text}` : `中文：${text}`,
          changed: true,
        };
      }),
  );
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? [])
      result = await handler({ type: name, ...event }, ctx);
    return result;
  };
  const command = (text = "") => commands.get("translate").handler(text, ctx);
  await emit("session_start");
  return {
    ctx,
    pi,
    entries,
    calls,
    notifications,
    emit,
    dir,
    panes,
    uiSteps,
    customOptions,
    statusHistory,
    commands,
    shortcuts,
    get renderRequests() {
      return renderRequests;
    },
    get editor() {
      return editor;
    },
    set editor(value: string) {
      editor = value;
    },
    get status() {
      return status;
    },
    key: (data: string) => keyHandler?.(data),
    command,
    async chooseModel(selected?: Model<Api>) {
      const available = ctx.modelRegistry.getAvailable;
      if (selected) ctx.modelRegistry.getAvailable = () => [selected];
      uiSteps.push(async (pane) => {
        pane.handleInput("\r");
        await flushUI();
        pane.handleInput(selected ? "\r" : "\u001b");
        await finishSave(pane);
        pane.handleInput("\u001b");
      });
      try {
        await command();
      } finally {
        ctx.modelRegistry.getAvailable = available;
      }
    },
    async chooseDefault(enabled: boolean) {
      const saved = await loadConfig(configPath);
      uiSteps.push(async (pane) => {
        pane.handleInput("\u001b[B");
        pane.handleInput("\u001b[B");
        if (saved.enabled !== enabled) pane.handleInput("\r");
        await finishSave(pane);
        pane.handleInput("\u001b");
      });
      await command();
    },
    async restoreInput() {
      uiSteps.push((pane) => {
        for (let i = 0; i < 3; i++) pane.handleInput("\u001b[B");
        pane.handleInput("\r");
        pane.handleInput("\u001b");
      });
      await command();
    },
    toggle: () => shortcuts.get("alt+t").handler(ctx),
    input: (text: string, extra = {}): Promise<InputEventResult> =>
      emit("input", { text, source: "interactive", ...extra }),
    async start(text = "请检查") {
      const input = await emit("input", { text, source: "interactive" });
      if (input?.action === "handled") return input;
      await emit("before_agent_start", {
        prompt: input?.action === "transform" ? input.text : text,
      });
      await emit("agent_start");
      await emit("turn_start");
      return input;
    },
    turn: (message = assistant("Final answer"), id = "answer-id", extra = {}) =>
      emit("turn_end", {
        message,
        messageEntryId: id,
        toolResults: [],
        outcome: "completed",
        ...extra,
      }),
    async settle(outcome = "completed") {
      await emit("agent_end");
      await emit("agent_before_settle", { outcome });
      await emit("agent_settled");
      await flushUI(); // Allow immediately-resolving display jobs to finish independently.
    },
    async close() {
      await emit("session_shutdown");
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function userText(context: Context): string {
  const message = context.messages[0];
  if (message.role !== "user" || typeof message.content !== "string")
    throw new Error("not a plain user message");
  return message.content;
}
