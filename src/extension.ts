import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { defaults, loadConfig, saveConfig, type Config } from "./config.ts";
import { protect, translate } from "./translator.ts";
import { pickTranslationModel } from "./model-picker.ts";

export const OUTPUT = "pi-translate.output";
export const INPUT = "pi-translate.input";
export const FAILURE = "pi-translate.failure";
export interface OutputData { original: string; translated: string; messageEntryId: string; provider?: string; model?: string }
export interface FailureData { direction: "input" | "output"; original: string; error: string; images?: ImageContent[]; messageEntryId?: string }
interface Run {
  config: Config;
  candidate?: { text: string; id: string };
  eligible: boolean;
  cancelled: boolean;
  signal?: AbortSignal;
}

export function registerTranslation(
  pi: ExtensionAPI,
  configPath: string,
  translateText: typeof translate = translate,
): void {
  let config: Config = { ...defaults };
  let defaultEnabled = defaults.enabled;
  let configurationOpen = false;
  let configError: string | undefined;
  let prepared: { text: string; config: Config } | undefined;
  let run: Run | undefined;
  let epoch = 0;
  let inputJob: AbortController | undefined;
  let outputJob: AbortController | undefined;
  let unsubscribeKeys: (() => void) | undefined;
  let lastFailure: FailureData | undefined;

  const status = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    const busy = inputJob ? " · 输入→EN…" : outputJob ? " · 回答→中文…" : "";
    const locked = run && run.config.enabled !== config.enabled ? ` · 本任务 ${run.config.enabled ? "on" : "off"}` : "";
    const missing = !config.provider || !config.model ? " · 未选模型" : "";
    try {
      ctx.ui.setStatus("pi-translate", `译 ${config.enabled ? "on" : "off"}${busy}${locked}${configError ? " · 配置错误" : missing}`);
    } catch { /* UI teardown must never make the input hook fail open. */ }
  };
  const reset = () => {
    epoch++;
    inputJob?.abort(new Error("会话已改变"));
    outputJob?.abort(new Error("会话已改变"));
    inputJob = outputJob = undefined;
    prepared = undefined;
    run = undefined;
    lastFailure = undefined;
    configurationOpen = false;
  };
  const toggle = (ctx: ExtensionContext, enabled = !config.enabled) => {
    config = { ...config, enabled };
    status(ctx);
  };
  const fail = (ctx: ExtensionContext, failure: FailureData) => {
    lastFailure = failure;
    // Custom entries NEVER participate in model context, unlike sendMessage(display: true).
    let storageError = "";
    try { pi.appendEntry(FAILURE, failure); }
    catch { storageError = "（会话记录写入失败；请保留输入框中的原文）"; }
    // Reporting must not throw out of an input hook: pi would otherwise pass input through.
    try {
      ctx.ui.notify(`${failure.direction === "input" ? "输入翻译失败，未提交；原文已保留，/translate recover 可恢复" : "回答翻译失败；原回答保持不变"}：${failure.error}${storageError}`, "error");
    } catch { /* A shutting-down UI must not turn a handled input into an execution. */ }
  };
  const reload = async (ctx: ExtensionContext) => {
    const ownEpoch = epoch;
    try {
      const loaded = await loadConfig(configPath);
      if (ownEpoch !== epoch) return;
      config = loaded;
      defaultEnabled = config.enabled;
      configError = undefined;
    } catch (error) {
      if (ownEpoch !== epoch) return;
      configError = error instanceof Error ? error.message : String(error);
      // Do not silently fall back to a different model or pretend invalid settings worked.
      ctx.ui.notify(`翻译配置不可用：${configError}`, "error");
    }
    status(ctx);
  };

  // Keep the saved startup policy separate from Alt+T's temporary runtime switch.
  const persistSettings = async (ctx: ExtensionContext, changes: Partial<Config>, ownEpoch: number) => {
    if (ownEpoch !== epoch) return false;
    const next = { ...config, enabled: defaultEnabled, ...changes };
    try {
      await saveConfig(configPath, next);
      if (ownEpoch !== epoch) return false;
      defaultEnabled = next.enabled;
      config = { ...next, enabled: config.enabled };
      configError = undefined;
      status(ctx);
      return true;
    } catch (error) {
      if (ownEpoch === epoch) ctx.ui.notify(`保存翻译配置失败：${String(error)}`, "error");
      return false;
    }
  };
  const selectModel = async (ctx: ExtensionContext, provider: string, model: string, ownEpoch: number) => {
    if (ownEpoch !== epoch) return;
    if (!ctx.modelRegistry.find(provider, model)) {
      ctx.ui.notify(`找不到翻译模型 ${provider}/${model}；用 /translate model 选择，或先配置 pi provider`, "error");
      return;
    }
    if (await persistSettings(ctx, { provider, model }, ownEpoch)) {
      ctx.ui.notify(`已保存翻译模型：${provider}/${model}（跨会话生效，主模型不变）`, "info");
    }
  };
  const chooseModel = async (ctx: ExtensionContext, ownEpoch: number) => {
    // Reload local model definitions without a network catalog refresh or a model switch.
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    if (ownEpoch !== epoch) return;
    const error = ctx.modelRegistry.getError();
    if (error) { ctx.ui.notify(`pi 模型配置不可用：${error}`, "error"); return; }
    const models = ctx.modelRegistry.getAvailable();
    if (!models.length) {
      ctx.ui.notify("没有可用的翻译模型；请先用 /login 配置 provider，或检查 pi 的 models.json", "warning");
      return;
    }
    const selected = await pickTranslationModel(ctx, models, config);
    if (selected && ownEpoch === epoch) await selectModel(ctx, selected.provider, selected.id, ownEpoch);
  };
  const chooseDefault = async (ctx: ExtensionContext, ownEpoch: number, value?: string) => {
    const choice = value ?? await ctx.ui.select(`新对话默认开关 · 当前 ${defaultEnabled ? "on" : "off"}\n保存后不改变当前开关或任务`, ["on", "off"]);
    if (choice !== "on" && choice !== "off") return;
    if (await persistSettings(ctx, { enabled: choice === "on" }, ownEpoch)) {
      ctx.ui.notify(`新对话默认：${choice}（已保存；当前开关不变）`, "info");
    }
  };
  const configure = async (ctx: ExtensionContext, action: (ownEpoch: number) => Promise<void>) => {
    if (configurationOpen) { ctx.ui.notify("翻译设置已打开，请先完成或取消当前操作", "warning"); return; }
    configurationOpen = true;
    const ownEpoch = epoch;
    try { await action(ownEpoch); }
    catch (error) { if (ownEpoch === epoch) ctx.ui.notify(`翻译设置失败：${String(error)}`, "error"); }
    finally { if (ownEpoch === epoch) configurationOpen = false; }
  };
  const showSettings = async (ctx: ExtensionContext, ownEpoch: number) => {
    while (ownEpoch === epoch) {
      const options = [
        `翻译模型 · ${config.provider && config.model ? `${config.provider}/${config.model}` : "未选择"}`,
        `当前开关 · ${config.enabled ? "on" : "off"}（Alt+T）`,
        `新对话默认 · ${defaultEnabled ? "on" : "off"}`,
        "关闭设置",
      ];
      const choice = await ctx.ui.select("翻译设置 · 主模型不变\n模型和新对话默认会保存；当前开关只临时生效", options);
      if (ownEpoch !== epoch || !choice || choice === options[3]) return;
      if (choice === options[0]) await chooseModel(ctx, ownEpoch);
      else if (choice === options[1]) toggle(ctx);
      else if (choice === options[2]) await chooseDefault(ctx, ownEpoch);
      else return;
    }
  };

  pi.registerShortcut("alt+t", {
    description: "切换自动双向翻译（当前任务的输出策略不变）",
    handler: async (ctx) => { if (ctx.mode === "tui") toggle(ctx); },
  });
  pi.registerCommand("translate", {
    description: "翻译设置与选模（Alt+T 快速切换）",
    getArgumentCompletions: (prefix) => {
      const commands = ["model", "default", "on", "off", "status", "toggle", "reload", "recover", "config"];
      const matches = commands.filter((name) => name.startsWith(prefix));
      return matches.length ? matches.map((name) => ({ value: name, label: name })) : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("pi-translate 仅在 pi 原生 TUI 启用；其他模式保持原样", "warning");
        return;
      }
      const [action, provider, model, ...extra] = args.trim().split(/\s+/);
      if (!action || action === "config") await configure(ctx, (ownEpoch) => showSettings(ctx, ownEpoch));
      else if (action === "toggle") toggle(ctx);
      else if (action === "on" || action === "off") toggle(ctx, action === "on");
      else if (action === "reload") await configure(ctx, () => reload(ctx));
      else if (action === "model" && !provider) await configure(ctx, (ownEpoch) => chooseModel(ctx, ownEpoch));
      else if (action === "model" && provider && model && !extra.length) {
        await configure(ctx, (ownEpoch) => selectModel(ctx, provider, model, ownEpoch));
      } else if (action === "default" && !model && (!provider || provider === "on" || provider === "off")) {
        await configure(ctx, (ownEpoch) => chooseDefault(ctx, ownEpoch, provider));
      } else if (action === "recover") {
        // Only extension-owned recovery data is read, and only on explicit user request.
        const ownEntries = ctx.sessionManager.getBranch().filter((entry) =>
          entry.type === "custom" && (entry.customType === FAILURE || entry.customType === INPUT));
        const failures = ownEntries.filter((entry) => entry.type === "custom" && entry.customType === FAILURE)
          .map((entry) => (entry as { data?: FailureData }).data);
        const failure = (lastFailure?.direction === "input" ? lastFailure : undefined)
          ?? failures.findLast((data) => data?.direction === "input")
          ?? (ownEntries.findLast((entry) => entry.type === "custom" && entry.customType === INPUT) as { data?: FailureData } | undefined)?.data;
        if (!failure) ctx.ui.notify("没有可恢复的失败输入", "info");
        else if (ctx.ui.getEditorText().trim()) ctx.ui.notify("请先清空输入框；不会覆盖当前草稿", "warning");
        else {
          ctx.ui.setEditorText(failure.original);
          if (failure.images?.length) ctx.ui.notify("文本已恢复；附件原始数据保存在失败记录中，请重新附加图片", "warning");
        }
      } else if (action === "status") {
        ctx.ui.notify(`翻译：${config.enabled ? "on" : "off"}\n翻译模型：${config.provider && config.model ? `${config.provider}/${config.model}` : "未选择（/translate model）"}\n新对话默认：${defaultEnabled ? "on" : "off"}\n配置：${configPath}${configError ? `\n配置错误：${configError}` : ""}\nAlt+T 快速切换 · /translate 打开设置`, "info");
      } else {
        ctx.ui.notify("用 /translate 打开设置；命令：model [provider id] / default [on|off] / on / off / status / toggle / reload / recover", "warning");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    reset();
    unsubscribeKeys?.();
    if (ctx.mode !== "tui") return;
    const ownEpoch = epoch;
    await reload(ctx);
    if (ownEpoch !== epoch) return;
    unsubscribeKeys = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape") || configurationOpen) return;
      if (run) run.cancelled = true;
      inputJob?.abort(new Error("输入翻译已取消"));
      outputJob?.abort(new Error("回答翻译已取消"));
      // Keep pi's normal abort handling; we only cancel our own nested calls.
      return undefined;
    });
  });
  pi.on("session_tree", (_event, ctx) => { reset(); status(ctx); });
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    unsubscribeKeys?.();
    unsubscribeKeys = undefined;
    if (ctx.mode === "tui") {
      try { ctx.ui.setStatus("pi-translate", undefined); }
      catch { /* The terminal may already have been disposed. */ }
    }
  });

  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive") {
      prepared = undefined;
      return { action: "continue" };
    }
    const snapshot = { ...config };
    const ownEpoch = epoch;
    // Don't allow a second Enter to overtake an asynchronous input translation.
    if (inputJob) {
      fail(ctx, { direction: "input", original: event.text, images: event.images, error: "上一份输入仍在翻译，请稍后重新提交" });
      return { action: "handled" };
    }
    // Native commands, templates and skills keep their original semantics. No expansion is read.
    const nativeEntry = /^\/(?:skill:)?[\w-]+(?:\s|$)/u.test(event.text) || event.text.startsWith("!");
    if (!snapshot.enabled || nativeEntry) {
      prepared = { text: event.text, config: nativeEntry ? { ...snapshot, enabled: false } : snapshot };
      return { action: "continue" };
    }
    if (!protect(event.text, "en").needsTranslation) {
      prepared = { text: event.text, config: snapshot };
      return { action: "continue" };
    }
    const job = new AbortController();
    inputJob = job;
    status(ctx);
    try {
      // Preserve the original before awaiting anything, even if the session is replaced
      // or the process closes while the translator is pending. This entry is not rendered.
      pi.appendEntry(INPUT, { original: event.text, images: event.images });
      if (configError) throw new Error(configError);
      const result = await translateText(ctx.modelRegistry, event.text, "en", snapshot, job.signal);
      if (ownEpoch !== epoch) return { action: "handled" };
      job.signal.throwIfAborted();
      prepared = { text: result.text, config: snapshot };
      if (result.changed) pi.appendEntry(INPUT, { original: event.text, translated: result.text, usage: result.usage });
      return { action: "transform", text: result.text, images: event.images };
    } catch (error) {
      if (ownEpoch === epoch) {
        prepared = undefined;
        fail(ctx, { direction: "input", original: event.text, images: event.images, error: error instanceof Error ? error.message : String(error) });
        // Never overwrite a new draft; the persistent failure entry is the recovery source.
        try { if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text); }
        catch { /* The persisted original (or in-memory recovery) remains available. */ }
      }
      return { action: "handled" };
    } finally {
      if (ownEpoch === epoch) { inputJob = undefined; status(ctx); }
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    // The input transform and this boundary are pi's native single submission path.
    // An unrelated extension-generated request must never acquire a stale snapshot.
    const snapshot = prepared?.text === event.prompt ? prepared.config : { ...config, enabled: false };
    prepared = undefined;
    run = { config: { ...snapshot }, eligible: false, cancelled: false };
    status(ctx);
  });
  pi.on("agent_start", () => {
    // Retry/compaction can start more than one low-level agent loop in one task.
    if (run) { run.candidate = undefined; run.eligible = false; }
  });
  pi.on("turn_start", () => {
    if (run) { run.candidate = undefined; run.eligible = false; }
  });
  pi.on("message_start", (event) => {
    // A new queued user input invalidates any earlier 'conclusion', even before turn_start.
    if (run && event.message.role === "user") { run.candidate = undefined; run.eligible = false; }
  });
  pi.on("turn_end", (event, ctx) => {
    if (!run) return;
    run.candidate = undefined;
    run.signal = ctx.signal;
    const message = event.message;
    if (message.role !== "assistant" || event.outcome !== "completed" || message.stopReason !== "stop" ||
        message.content.some((part) => part.type === "toolCall") || event.toolResults.length) return;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
    if (text.trim()) run.candidate = { text, id: event.messageEntryId };
  });
  pi.on("agent_before_settle", (event) => {
    if (run) run.eligible = event.outcome === "completed";
    // No continuation, context changes, or translation calls at this actionable boundary.
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const finished = run;
    run = undefined;
    prepared = undefined;
    if (!finished?.config.enabled || !finished.eligible || finished.cancelled || finished.signal?.aborted || !finished.candidate) {
      status(ctx);
      return;
    }
    const { text, id } = finished.candidate;
    const ownEpoch = epoch;
    const job = new AbortController();
    outputJob = job;
    status(ctx);
    try {
      const result = await translateText(ctx.modelRegistry, text, "zh", finished.config, job.signal);
      if (ownEpoch !== epoch) return;
      job.signal.throwIfAborted();
      if (result.changed) {
        pi.appendEntry(OUTPUT, {
          original: text, translated: result.text, messageEntryId: id,
          provider: finished.config.provider, model: finished.config.model, usage: result.usage,
        });
      }
    } catch (error) {
      if (ownEpoch === epoch) fail(ctx, { direction: "output", original: text, messageEntryId: id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (ownEpoch === epoch) { outputJob = undefined; status(ctx); }
    }
  });
}
