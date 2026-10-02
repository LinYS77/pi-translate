import type { Config } from "./config.ts";
import {
  DynamicBorder,
  getSettingsListTheme,
  getSelectListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  SelectList,
  Input,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { TranslationModelPicker, type ModelChoice } from "./model-picker.ts";

export interface SettingsState {
  enabled: boolean;
  defaultEnabled: boolean;
  provider?: string;
  model?: string;
  error?: string;
  canRecover: boolean;
  timeoutMs: number;
  decisionMode: Config["decisionMode"];
  classifierProvider?: string;
  classifierModel?: string;
}
export interface SettingsActions {
  state(): SettingsState;
  toggle(): void;
  loadModels(
    signal: AbortSignal,
    classifier?: boolean,
  ): Promise<readonly ModelChoice[]>;
  selectModel(model: ModelChoice, classifier?: boolean): Promise<boolean>;
  setDefault(enabled: boolean): Promise<boolean>;
  setTimeout(ms: number): Promise<boolean>;
  setDecisionMode(mode: Config["decisionMode"]): Promise<boolean>;
  /** Undefined means the input was restored; a string explains why it could not be. */
  recover(): string | undefined;
}

/** One Pi-managed overlay. Submenus stay inside it, rather than restoring/replacing the editor. */
export class TranslationSettingsPane implements Component, Focusable {
  private list: SettingsList;
  private classifierShown = false;
  private classifierPicker = false;
  private readonly border: DynamicBorder;
  private picker?: TranslationModelPicker;
  private modelJob?: AbortController;
  private timeoutInput?: Input;
  private timeoutOpen = false;
  private busy = false;
  private disposed = false;
  private _focused = false;
  private feedback = "";

  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.picker) this.picker.focused = value;
    if (this.timeoutInput) this.timeoutInput.focused = value;
  }

  constructor(
    private readonly actions: SettingsActions,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {
    this.border = new DynamicBorder((text) => theme.fg("border", text));
    this.list = this.mainList();
  }

  private mainList() {
    const actions = this.actions;
    const state = actions.state();
    this.classifierShown = state.decisionMode === "jev";
    const items: SettingItem[] = [
      {
        id: "model",
        label: "翻译模型",
        currentValue: this.modelLabel(),
        submenu: (_value, back) => this.models(back),
      },
      {
        id: "enabled",
        label: "当前开关",
        currentValue: state.enabled ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "default",
        label: "新对话默认",
        currentValue: state.defaultEnabled ? "on" : "off",
        values: ["on", "off"],
      },
    ];
    if (state.canRecover)
      items.push({
        id: "recover",
        label: "恢复输入",
        currentValue: "",
        values: ["恢复"],
      });
    items.push({
      id: "timeout",
      label: "翻译超时",
      currentValue: this.timeoutLabel(),
      submenu: (_value, back) => this.timeout(back),
    });
    items.push({
      id: "route",
      label: "判断方式",
      currentValue: state.decisionMode === "jev" ? "Jev" : "本地规则",
      values: ["本地规则", "Jev"],
    });
    if (this.classifierShown)
      items.push({
        id: "classifier",
        label: "判断模型",
        currentValue: this.modelLabel(true),
        submenu: (_value, back) => this.models(back, true),
      });
    return new SettingsList(
      items,
      4,
      getSettingsListTheme(),
      (id, value) => {
        if (id === "enabled") {
          actions.toggle();
          this.sync();
        } else if (id === "route")
          void this.save(() =>
            actions.setDecisionMode(value === "Jev" ? "jev" : "local"),
          );
        else if (id === "default")
          void this.save(() => actions.setDefault(value === "on"));
        else if (id === "recover") {
          const error = actions.recover();
          if (error) {
            this.feedback = error;
            this.list.updateValue("recover", "");
          } else this.close();
        }
      },
      () => this.close(),
    );
  }

  private height() {
    return Math.max(1, Math.min(14, this.tui.terminal.rows - 2));
  }
  private modelLabel(classifier = false) {
    const state = this.actions.state();
    const provider = classifier ? state.classifierProvider : state.provider;
    const model = classifier ? state.classifierModel : state.model;
    return provider && model ? `${provider}/${model}` : "未选择";
  }
  private timeoutLabel() {
    const ms = this.actions.state().timeoutMs;
    return ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${ms / 1000} 秒`;
  }
  private timeout(back: () => void): Component {
    this.timeoutOpen = true;
    this.feedback = "";
    const close = () => {
      if (this.timeoutInput) this.timeoutInput.focused = false;
      this.timeoutInput = undefined;
      this.timeoutOpen = false;
      back();
    };
    const presets = [1, 5, 10, 20, 30, 60];
    const select = new SelectList(
      [
        ...presets.map((m) => ({
          value: String(m * 60000),
          label: `${m} 分钟`,
        })),
        { value: "custom", label: "自定义（秒）" },
      ],
      6,
      getSelectListTheme(),
    );
    select.onCancel = close;
    select.onSelect = ({ value }) => {
      if (value === "custom") {
        this.timeoutInput = new Input({ prompt: "秒 > " });
        this.timeoutInput.handleInput(
          String(this.actions.state().timeoutMs / 1000),
        );
        this.timeoutInput.focused = this.focused;
      } else {
        close();
        void this.save(() => this.actions.setTimeout(Number(value)));
      }
    };
    return {
      render: (width) =>
        this.timeoutInput?.render(width) ?? select.render(width),
      invalidate: () => {
        this.timeoutInput?.invalidate();
        select.invalidate();
      },
      handleInput: (data) => {
        if (!this.timeoutInput) return select.handleInput(data);
        if (this.keybindings.matches(data, "tui.select.cancel")) {
          this.timeoutInput.focused = false;
          this.timeoutInput = undefined;
          this.feedback = "";
        } else if (this.keybindings.matches(data, "tui.select.confirm")) {
          const value = this.timeoutInput.getValue().trim();
          const ms = Math.round(Number(value) * 1000);
          if (!/^\d+(?:\.\d{1,3})?$/.test(value) || ms < 100 || ms > 3600000) {
            this.feedback = "请输入 0.1–3600 秒，最多三位小数";
            return;
          }
          close();
          void this.save(() => this.actions.setTimeout(ms));
        } else this.timeoutInput.handleInput(data);
      },
    };
  }
  private sync() {
    const state = this.actions.state();
    if (
      this.classifierShown !== (state.decisionMode === "jev") &&
      !this.picker &&
      !this.timeoutOpen
    ) {
      this.list = this.mainList();
      this.list.selectItem("route");
    }
    this.list.updateValue(
      "route",
      state.decisionMode === "jev" ? "Jev" : "本地规则",
    );
    this.list.updateValue("classifier", this.modelLabel(true));
    this.list.updateValue("model", this.modelLabel());
    this.list.updateValue("enabled", state.enabled ? "on" : "off");
    this.list.updateValue("default", state.defaultEnabled ? "on" : "off");
    this.list.updateValue("timeout", this.timeoutLabel());
  }
  private async save(operation: () => Promise<boolean>) {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.feedback = "保存中…";
    this.tui.requestRender();
    try {
      this.feedback = (await operation()) ? "已保存" : "未保存，原配置保留";
    } catch (error) {
      this.feedback = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.sync();
        this.tui.requestRender();
      }
    }
  }

  private models(
    back: (value?: string) => void,
    classifier = false,
  ): Component {
    this.classifierPicker = classifier;
    const controller = new AbortController();
    this.modelJob = controller;
    this.feedback = "";
    const active = () =>
      !this.disposed &&
      this.modelJob === controller &&
      !controller.signal.aborted;
    const cancel = () => {
      if (!active()) return;
      controller.abort();
      this.modelJob = undefined;
      if (this.picker) this.picker.focused = false;
      this.picker = undefined;
      back();
      this.sync();
      this.tui.requestRender();
    };
    this.picker = new TranslationModelPicker(
      [],
      classifier
        ? {
            provider: this.actions.state().classifierProvider,
            model: this.actions.state().classifierModel,
          }
        : this.actions.state(),
      this.theme,
      this.keybindings,
      (selected) => {
        if (!active()) return;
        cancel();
        if (selected)
          void this.save(() => this.actions.selectModel(selected, classifier));
      },
      Math.max(1, this.height() - 8),
    );
    this.picker.focused = this.focused;
    void Promise.resolve()
      .then(() => this.actions.loadModels(controller.signal, classifier))
      .then((models) => {
        if (!active()) return;
        if (!models.length)
          throw new Error(
            classifier
              ? "没有可用 Jev 模型，请先配置 TypeSafe 或其它 Jev provider"
              : "没有可用模型，请先用 /login 配置 provider",
          );
        this.picker!.setModels(models);
        this.tui.requestRender();
      })
      .catch((error) => {
        if (!active()) return;
        cancel();
        this.feedback = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
    return {
      render: (width) => {
        this.picker?.setVisibleRows(Math.max(1, this.height() - 8));
        return this.picker?.render(width) ?? [];
      },
      invalidate: () => this.picker?.invalidate(),
      handleInput: (data) => this.picker?.handleInput(data),
    };
  }

  handleInput(data: string) {
    if (this.disposed) return;
    if (this.busy) {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.close();
      return;
    }
    this.list.handleInput(data);
    if (!this.disposed) this.tui.requestRender();
  }
  invalidate() {
    this.list.invalidate();
    this.border.invalidate();
  }
  render(width: number) {
    if (!this.busy) this.sync();
    const height = this.height();
    const title = this.theme.fg(
      "accent",
      this.picker
        ? this.classifierPicker
          ? "判断模型"
          : "翻译模型"
        : this.timeoutOpen
          ? "翻译超时"
          : "翻译设置",
    );
    const hint =
      this.picker || this.timeoutOpen
        ? width < 55
          ? "Esc 返回 · Enter 保存"
          : "输入搜索 · ↑↓ 选择 · Enter 保存 · Esc 返回"
        : width < 40
          ? "Esc 关闭 · Enter 更改"
          : "Enter/Space 更改 · Esc 关闭";
    const feedback = this.feedback || this.actions.state().error || "";
    const nativeRows = this.list.render(Math.max(1, width - 2));
    const content =
      this.picker || this.timeoutOpen ? nativeRows : nativeRows.slice(0, -2);
    const available = Math.max(1, height - 5);
    const selectedIndex = content.findIndex((line) =>
      line.startsWith(getSettingsListTheme().cursor),
    );
    const start = Math.max(0, selectedIndex - available + 1);
    const body = content.slice(start, start + available);
    // Keep outer bounds stable through loading, searching and returning to the menu.
    const lines = [
      ...this.border.render(width),
      ` ${title}`,
      ...body.map((line) => ` ${line}`),
    ];
    while (lines.length < height - 3) lines.push("");
    lines.push(
      this.theme.fg("muted", truncateToWidth(` ${feedback}`, width)),
      this.theme.fg("dim", truncateToWidth(` ${hint}`, width)),
      ...this.border.render(width),
    );
    if (height < 7) {
      const cursor = getSettingsListTheme().cursor;
      const selected =
        content.find((line) => line.startsWith(cursor)) ?? body[0] ?? "";
      return [selected, truncateToWidth(hint, width)]
        .slice(0, height)
        .map((line) => truncateToWidth(line, width));
    }
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
  close() {
    if (!this.disposed) {
      this.dispose();
      this.done();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.modelJob?.abort();
    if (this.timeoutInput) this.timeoutInput.focused = false;
    if (this.picker) this.picker.focused = false;
  }
}

export async function showTranslationSettings(
  ctx: ExtensionContext,
  actions: SettingsActions,
  signal: AbortSignal,
): Promise<void> {
  let pane: TranslationSettingsPane | undefined;
  const abort = () => pane?.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        pane = new TranslationSettingsPane(
          actions,
          tui,
          theme,
          keybindings,
          () => done(undefined),
        );
        if (signal.aborted) pane.close();
        return pane;
      },
      {
        overlay: true,
        overlayOptions: { width: 76, anchor: "bottom-center", margin: 1 },
      },
    );
  } finally {
    signal.removeEventListener("abort", abort);
    pane?.dispose();
  }
}
