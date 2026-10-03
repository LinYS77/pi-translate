import type { ImageContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { defaults, loadConfig, saveConfig, type Config } from "./config.ts";
import { translate } from "./translator.ts";
import { createTranslationPlan } from "./translation-plan.ts";
import { showTranslationSettings } from "./settings-pane.ts";
import { isJev } from "./jev-classifier.ts";

export const OUTPUT = "pi-translate.output";
export const INPUT = "pi-translate.input";
export const FAILURE = "pi-translate.failure";
export const NOTICE = "pi-translate.notice";
export interface NoticeData {
  message: string;
  direction: "input" | "output";
}
export interface OutputData {
  original: string;
  translated: string;
  messageEntryId: string;
  provider?: string;
  model?: string;
  status?: "unchanged" | "complete" | "partial";
  warnings?: string[];
  failedSegmentIds?: string[];
}
interface InputData {
  original: string;
  images?: ImageContent[];
}
export interface FailureData extends InputData {
  direction: "input" | "output";
  error: string;
  messageEntryId?: string;
}
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
  let configurationJob: AbortController | undefined;
  let configWrites: Promise<void> = Promise.resolve();
  let configError: string | undefined;
  let prepared: { text: string; config: Config } | undefined;
  let run: Run | undefined;
  let epoch = 0;
  let inputJob: AbortController | undefined;
  let outputJob: AbortController | undefined;
  let unsubscribeKeys: (() => void) | undefined;
  let lastInput: InputData | undefined;
  const spinnerFrames = ["⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋", "⠙"];
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let statusContext: ExtensionContext | undefined;
  const stopSpinner = () => {
    if (spinnerTimer) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    statusContext = undefined;
  };

  const status = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      stopSpinner();
      return;
    }
    statusContext = ctx;
    const translating = Boolean(inputJob || outputJob);
    if (translating && !spinnerTimer) {
      spinnerFrame = 0;
      const ownEpoch = epoch;
      spinnerTimer = setInterval(() => {
        if (ownEpoch !== epoch || !statusContext) return;
        spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
        status(statusContext);
      }, 80);
      spinnerTimer.unref?.();
    } else if (!translating) stopSpinner();
    const busy = translating ? ` ${spinnerFrames[spinnerFrame]}` : "";
    const locked =
      run && run.config.enabled !== config.enabled
        ? ` · 本任务 ${run.config.enabled ? "on" : "off"}`
        : "";
    const missing = !config.provider || !config.model ? " · 未选模型" : "";
    try {
      ctx.ui.setStatus(
        "pi-translate",
        `译 ${config.enabled ? "on" : "off"}${busy}${locked}${configError ? " · 配置错误" : missing}`,
      );
    } catch {
      /* UI teardown must never make the input hook fail open. */
    }
  };
  const reset = () => {
    epoch++;
    stopSpinner();
    inputJob?.abort(new Error("会话已改变"));
    outputJob?.abort(new Error("会话已改变"));
    inputJob = outputJob = undefined;
    prepared = undefined;
    run = undefined;
    lastInput = undefined;
    configurationJob?.abort();
    configurationJob = undefined;
  };
  const toggle = (ctx: ExtensionContext) => {
    config = { ...config, enabled: !config.enabled };
    status(ctx);
  };
  const fail = (ctx: ExtensionContext, failure: FailureData) => {
    if (failure.direction === "input") lastInput = failure;
    // Custom entries NEVER participate in model context, unlike sendMessage(display: true).
    let storageError = "";
    try {
      pi.appendEntry(FAILURE, failure);
      return; // Its entry renderer already reports this error visibly.
    } catch {
      storageError = "（会话记录写入失败；请保留输入框中的原文）";
    }
    // Reporting must not throw out of an input hook: pi would otherwise pass input through.
    try {
      ctx.ui.notify(
        `${failure.direction === "input" ? "输入翻译失败，未提交；原文已保留，可在 /translate 中恢复输入" : "回答翻译失败；原回答保持不变"}：${failure.error}${storageError}`,
        "error",
      );
    } catch {
      /* A shutting-down UI must not turn a handled input into an execution. */
    }
  };
  const warningReporter = (
    ctx: ExtensionContext,
    direction: NoticeData["direction"],
    ownEpoch: number,
    signal: AbortSignal,
  ) => {
    const seen = new Set<string>();
    return (message: string) => {
      if (ownEpoch !== epoch || signal.aborted || seen.has(message)) return;
      seen.add(message);
      try {
        pi.appendEntry(NOTICE, { direction, message } satisfies NoticeData);
        return; // Use exactly one visible channel; notify only if persistence fails.
      } catch {
        /* UI can still report without persistence. */
      }
      try {
        ctx.ui.notify(message, "warning");
      } catch {
        /* Never fail an input hook open. */
      }
    };
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
  const persistSettings = (
    ctx: ExtensionContext,
    changes: Partial<Config>,
    ownEpoch: number,
  ) => {
    // Closing/reopening the panel while a write is in flight must not race or
    // overwrite a newer model/default with a stale configuration snapshot.
    const result = configWrites.then(async () => {
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
        if (ownEpoch !== epoch) return false;
        throw new Error(`保存翻译配置失败：${String(error)}`);
      }
    });
    configWrites = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const recoverableInput = (ctx: ExtensionContext): InputData | undefined => {
    if (lastInput) return lastInput;
    // Inspect only extension-owned data, on explicit recovery; newest input wins.
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "custom" &&
          (entry.customType === INPUT ||
            (entry.customType === FAILURE &&
              (entry.data as FailureData)?.direction === "input")),
      );
    return entry?.type === "custom" ? (entry.data as InputData) : undefined;
  };
  const recoverInput = (ctx: ExtensionContext): string | undefined => {
    const input = recoverableInput(ctx);
    if (!input) return "没有可恢复的输入";
    if (ctx.ui.getEditorText()) return "请先清空输入框，不会覆盖当前草稿";
    ctx.ui.setEditorText(input.original);
    if (input.images?.length)
      ctx.ui.notify("文本已恢复；附件数据仍保留，请重新附加图片", "warning");
    return undefined;
  };
  const showSettings = async (ctx: ExtensionContext) => {
    if (configurationJob) return;
    const job = new AbortController();
    configurationJob = job;
    const ownEpoch = epoch;
    const canRecover = Boolean(recoverableInput(ctx));
    try {
      await showTranslationSettings(
        ctx,
        {
          state: () => ({
            enabled: config.enabled,
            defaultEnabled,
            provider: config.provider,
            model: config.model,
            error: configError,
            canRecover,
            timeoutMs: config.timeoutMs,
            decisionMode: config.decisionMode,
            classifierProvider: config.classifierProvider,
            classifierModel: config.classifierModel,
          }),
          toggle: () => {
            if (ownEpoch === epoch) toggle(ctx);
          },
          loadModels: async (signal, classifier) => {
            await ctx.modelRegistry.refresh({ allowNetwork: false, signal });
            signal.throwIfAborted();
            if (ownEpoch !== epoch) throw new Error("会话已改变");
            const error = ctx.modelRegistry.getError();
            if (error) throw new Error(error);
            if (classifier) {
              if (typeof ctx.modelRegistry.getAvailableOfType !== "function")
                throw new Error("当前 Pi 缺少 classifier 接口，请升级 Pi");
              const models = await ctx.modelRegistry.getAvailableOfType(
                "classifier",
                undefined,
                { signal },
              );
              signal.throwIfAborted();
              return models.filter(isJev);
            }
            return ctx.modelRegistry.getAvailable();
          },
          selectModel: async ({ provider, id }, classifier) => {
            if (ownEpoch !== epoch) return false;
            if (classifier) {
              const selected = ctx.modelRegistry.findOfType?.(
                "classifier",
                provider,
                id,
              );
              if (!selected || !isJev(selected))
                throw new Error(`找不到 Jev 判断模型 ${provider}/${id}`);
              return persistSettings(
                ctx,
                { classifierProvider: provider, classifierModel: id },
                ownEpoch,
              );
            }
            if (!ctx.modelRegistry.find(provider, id))
              throw new Error(
                `找不到翻译模型 ${provider}/${id}，请重新选择或检查 pi provider`,
              );
            return persistSettings(ctx, { provider, model: id }, ownEpoch);
          },
          setDefault: (enabled) => persistSettings(ctx, { enabled }, ownEpoch),
          setTimeout: (timeoutMs) =>
            persistSettings(ctx, { timeoutMs }, ownEpoch),
          setDecisionMode: (decisionMode) =>
            persistSettings(ctx, { decisionMode }, ownEpoch),
          recover: () =>
            ownEpoch === epoch ? recoverInput(ctx) : "会话已改变",
        },
        job.signal,
      );
    } catch (error) {
      if (ownEpoch === epoch && !job.signal.aborted)
        ctx.ui.notify(`翻译设置失败：${String(error)}`, "error");
    } finally {
      if (ownEpoch === epoch) configurationJob = undefined;
    }
  };

  pi.registerShortcut("alt+t", {
    description: "切换自动双向翻译（当前任务的输出策略不变）",
    handler: async (ctx) => {
      if (ctx.mode === "tui") toggle(ctx);
    },
  });
  pi.registerShortcut("ctrl+alt+t", {
    description: "恢复原始输入（不覆盖草稿、不自动提交）",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") return;
      const error = recoverInput(ctx);
      if (error) ctx.ui.notify(error, "warning");
    },
  });
  pi.registerCommand("translate", {
    description: "打开翻译设置（Alt+T 快速切换）",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "pi-translate 仅在 pi 原生 TUI 启用；其他模式保持原样",
          "warning",
        );
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("仅支持 /translate，无需参数", "warning");
        return;
      }
      await showSettings(ctx);
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
      if (!matchesKey(data, "escape") || configurationJob) return;
      if (run) run.cancelled = true;
      inputJob?.abort(new Error("输入翻译已取消"));
      outputJob?.abort(new Error("回答翻译已取消"));
      // Keep pi's normal abort handling; we only cancel our own nested calls.
      return undefined;
    });
  });
  pi.on("session_tree", (_event, ctx) => {
    reset();
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    unsubscribeKeys?.();
    unsubscribeKeys = undefined;
    if (ctx.mode === "tui") {
      try {
        ctx.ui.setStatus("pi-translate", undefined);
      } catch {
        /* The terminal may already have been disposed. */
      }
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
      fail(ctx, {
        direction: "input",
        original: event.text,
        images: event.images,
        error: "上一份输入仍在翻译，请稍后重新提交",
      });
      return { action: "handled" };
    }
    // Native commands, templates and skills keep their original semantics. No expansion is read.
    const nativeEntry =
      /^\/(?:skill:)?[\w-]+(?:\s|$)/u.test(event.text) ||
      event.text.startsWith("!");
    if (!snapshot.enabled || nativeEntry) {
      prepared = {
        text: event.text,
        config: nativeEntry ? { ...snapshot, enabled: false } : snapshot,
      };
      return { action: "continue" };
    }
    const job = new AbortController();
    inputJob = job;
    const warn = warningReporter(ctx, "input", ownEpoch, job.signal);
    status(ctx);
    try {
      // Planning can reject ambiguous preservation boundaries. Keep it inside the
      // fail-closed hook: Pi may otherwise pass untranslated input through on error.
      if (!createTranslationPlan(event.text, "en").segments.length) {
        prepared = { text: event.text, config: snapshot };
        return { action: "continue" };
      }
      // Preserve the original before awaiting anything, even if the session is replaced
      // or the process closes while the translator is pending. This entry is not rendered.
      lastInput = { original: event.text, images: event.images };
      pi.appendEntry(INPUT, lastInput);
      if (configError) throw new Error(configError);
      const result = await translateText(
        ctx.modelRegistry,
        event.text,
        "en",
        snapshot,
        job.signal,
        warn,
      );
      if (ownEpoch !== epoch) return { action: "handled" };
      job.signal.throwIfAborted();
      result.warnings?.forEach(warn);
      if (result.status === "partial")
        throw new Error("输入翻译不完整，未提交");
      prepared = { text: result.text, config: snapshot };
      return { action: "transform", text: result.text, images: event.images };
    } catch (error) {
      if (ownEpoch === epoch) {
        prepared = undefined;
        fail(ctx, {
          direction: "input",
          original: event.text,
          images: event.images,
          error: error instanceof Error ? error.message : String(error),
        });
        // Never overwrite a new draft; the persistent failure entry is the recovery source.
        try {
          if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
        } catch {
          /* The persisted original (or in-memory recovery) remains available. */
        }
      }
      return { action: "handled" };
    } finally {
      if (ownEpoch === epoch) {
        inputJob = undefined;
        status(ctx);
      }
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    // The input transform and this boundary are pi's native single submission path.
    // An unrelated extension-generated request must never acquire a stale snapshot.
    const snapshot =
      prepared?.text === event.prompt
        ? prepared.config
        : { ...config, enabled: false };
    prepared = undefined;
    run = { config: { ...snapshot }, eligible: false, cancelled: false };
    status(ctx);
  });
  pi.on("agent_start", () => {
    // Retry/compaction can start more than one low-level agent loop in one task.
    if (run) {
      run.candidate = undefined;
      run.eligible = false;
    }
  });
  pi.on("turn_start", () => {
    if (run) {
      run.candidate = undefined;
      run.eligible = false;
    }
  });
  pi.on("message_start", (event) => {
    // A new queued user input invalidates any earlier 'conclusion', even before turn_start.
    if (run && event.message.role === "user") {
      run.candidate = undefined;
      run.eligible = false;
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (!run) return;
    run.candidate = undefined;
    run.signal = ctx.signal;
    const message = event.message;
    if (
      message.role !== "assistant" ||
      event.outcome !== "completed" ||
      message.stopReason !== "stop" ||
      message.content.some((part) => part.type === "toolCall") ||
      event.toolResults.length
    )
      return;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
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
    if (
      !finished?.config.enabled ||
      !finished.eligible ||
      finished.cancelled ||
      finished.signal?.aborted ||
      !finished.candidate
    ) {
      status(ctx);
      return;
    }
    const { text, id } = finished.candidate;
    const ownEpoch = epoch;
    const job = new AbortController();
    outputJob = job;
    const warn = warningReporter(ctx, "output", ownEpoch, job.signal);
    status(ctx);
    try {
      const result = await translateText(
        ctx.modelRegistry,
        text,
        "zh",
        finished.config,
        job.signal,
        warn,
      );
      if (ownEpoch !== epoch) return;
      job.signal.throwIfAborted();
      result.warnings?.forEach(warn);
      if (result.changed) {
        pi.appendEntry(OUTPUT, {
          original: text,
          translated: result.text,
          messageEntryId: id,
          provider: finished.config.provider,
          model: finished.config.model,
          usage: result.usage,
          status: result.status,
          warnings: result.warnings,
          failedSegmentIds: result.failedSegmentIds,
        });
      }
    } catch (error) {
      if (ownEpoch === epoch && !job.signal.aborted)
        fail(ctx, {
          direction: "output",
          original: text,
          messageEntryId: id,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (ownEpoch === epoch) {
        outputJob = undefined;
        status(ctx);
      }
    }
  });
}
