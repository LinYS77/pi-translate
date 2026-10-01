import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InputEventResult } from "@earendil-works/pi-coding-agent";
import { saveConfig, defaults, type Config } from "../src/config.ts";
import { registerTranslation } from "../src/extension.ts";
import type { translate } from "../src/translator.ts";

export const model: Model<Api> = {
  id: "small", name: "small", api: "openai-completions", provider: "translator", baseUrl: "https://invalid.example",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 8192,
};
export function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: "main", model: "large", stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
export async function harness(translateText?: typeof translate, overrides: Partial<Config> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-test-"));
  const configPath = join(dir, "config.json");
  await saveConfig(configPath, { ...defaults, enabled: true, provider: model.provider, model: model.id, ...overrides });
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const entries: { type: string; customType: string; data: any }[] = [];
  const notifications: string[] = [];
  const calls: { text: string; direction: string; config: Config }[] = [];
  let editor = "";
  let status = "";
  let keyHandler: ((data: string) => unknown) | undefined;
  const ctx = {
    mode: "tui", hasUI: true, signal: undefined,
    ui: {
      setStatus: (_key: string, value: string) => { status = value; },
      notify: (value: string) => notifications.push(value),
      getEditorText: () => editor,
      setEditorText: (value: string) => { editor = value; },
      onTerminalInput: (fn: typeof keyHandler) => { keyHandler = fn; return () => { keyHandler = undefined; }; },
    },
    sessionManager: { getBranch: () => entries },
    modelRegistry: { find: () => model },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: any) => shortcuts.set(name, shortcut),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  registerTranslation(pi, configPath, translateText ?? (async (_registry, text, direction, config) => {
    calls.push({ text, direction, config });
    return { text: direction === "en" ? `English: ${text}` : `中文：${text}`, changed: true };
  }));
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, ctx);
    return result;
  };
  await emit("session_start");
  return {
    ctx, pi, entries, calls, notifications, emit, dir,
    get editor() { return editor; }, set editor(value: string) { editor = value; },
    get status() { return status; },
    key: (data: string) => keyHandler?.(data),
    command: (text: string) => commands.get("translate").handler(text, ctx),
    toggle: () => shortcuts.get("alt+t").handler(ctx),
    input: (text: string, extra = {}): Promise<InputEventResult> => emit("input", { text, source: "interactive", ...extra }),
    async start(text = "请检查") {
      const input = await emit("input", { text, source: "interactive" });
      if (input?.action === "handled") return input;
      await emit("before_agent_start", { prompt: input?.action === "transform" ? input.text : text });
      await emit("agent_start");
      await emit("turn_start");
      return input;
    },
    turn: (message = assistant("Final answer"), id = "answer-id", extra = {}) => emit("turn_end", { message, messageEntryId: id, toolResults: [], outcome: "completed", ...extra }),
    async settle(outcome = "completed") {
      await emit("agent_end");
      await emit("agent_before_settle", { outcome });
      await emit("agent_settled");
    },
    async close() { await emit("session_shutdown"); await rm(dir, { recursive: true, force: true }); },
  };
}

export function userText(context: Context): string {
  const message = context.messages[0];
  if (message.role !== "user" || typeof message.content !== "string") throw new Error("not a plain user message");
  return message.content;
}
