import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { defaults, loadConfig, saveConfig, type Config } from "./config.ts";
import { protect, translate } from "./translator.ts";

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
    const locked = run && run.config.enabled !== config.enabled ? ` · 本任务${run.config.enabled ? "开" : "关"}` : "";
    try {
      ctx.ui.setStatus("pi-translate", `译 ${config.enabled ? "开" : "关"}${busy}${locked}${configError ? " · 配置错误" : ""}`);
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
    try {
      config = await loadConfig(configPath);
      configError = undefined;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      // Do not silently fall back to a different model or pretend invalid settings worked.
      ctx.ui.notify(`翻译配置不可用：${configError}`, "error");
    }
    status(ctx);
  };

  pi.registerShortcut("alt+t", {
    description: "切换自动双向翻译（当前任务的输出策略不变）",
    handler: async (ctx) => { if (ctx.mode === "tui") toggle(ctx); },
  });
  pi.registerCommand("translate", {
    description: "双向翻译：on / off / status / model <provider> <id> / reload / recover",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("pi-translate 仅在 pi 原生 TUI 启用；其他模式保持原样", "warning");
        return;
      }
      const [action, provider, model, ...extra] = args.trim().split(/\s+/);
      if (!action || action === "toggle") toggle(ctx);
      else if (action === "on" || action === "off") toggle(ctx, action === "on");
      else if (action === "reload") await reload(ctx);
      else if (action === "model" && provider && model && !extra.length) {
        if (!ctx.modelRegistry.find(provider, model)) {
          ctx.ui.notify(`找不到翻译模型 ${provider}/${model}；请先配置 pi provider`, "error");
          return;
        }
        const next = { ...config, provider, model };
        try {
          await saveConfig(configPath, next);
          config = next;
          configError = undefined;
          status(ctx);
          ctx.ui.notify(`翻译模型：${provider}/${model}（主模型不变）`, "info");
        } catch (error) {
          ctx.ui.notify(`保存翻译配置失败：${String(error)}`, "error");
        }
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
      } else {
        ctx.ui.notify(`翻译${config.enabled ? "开启" : "关闭"} · ${config.provider ?? "未配置"}/${config.model ?? "未配置"}\n配置：${configPath}\n/translate [on|off|status|model <provider> <id>|reload|recover]`, "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    reset();
    unsubscribeKeys?.();
    if (ctx.mode !== "tui") return;
    await reload(ctx);
    unsubscribeKeys = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return;
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
