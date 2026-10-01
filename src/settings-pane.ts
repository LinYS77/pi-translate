import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  SettingsList,
  truncateToWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { TranslationModelPicker } from "./model-picker.ts";

export interface SettingsState {
  enabled: boolean;
  defaultEnabled: boolean;
  provider?: string;
  model?: string;
  error?: string;
  canRecover: boolean;
}
export interface SettingsActions {
  state(): SettingsState;
  toggle(): void;
  loadModels(signal: AbortSignal): Promise<Model<Api>[]>;
  selectModel(model: Model<Api>): Promise<boolean>;
  setDefault(enabled: boolean): Promise<boolean>;
  /** Undefined means the input was restored; a string explains why it could not be. */
  recover(): string | undefined;
}

/** One Pi-managed overlay. Submenus stay inside it, rather than restoring/replacing the editor. */
export class TranslationSettingsPane implements Component, Focusable {
  private readonly list: SettingsList;
  private readonly border: DynamicBorder;
  private picker?: TranslationModelPicker;
  private modelJob?: AbortController;
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
  }

  constructor(
    private readonly actions: SettingsActions,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {
    const state = actions.state();
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
    this.list = new SettingsList(
      items,
      4,
      getSettingsListTheme(),
      (id, value) => {
        if (id === "enabled") {
          actions.toggle();
          this.sync();
        } else if (id === "default")
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
    this.border = new DynamicBorder((text) => theme.fg("border", text));
  }

  private height() {
    return Math.max(1, Math.min(14, this.tui.terminal.rows - 2));
  }
  private modelLabel() {
    const state = this.actions.state();
    return state.provider && state.model
      ? `${state.provider}/${state.model}`
      : "未选择";
  }
  private sync() {
    const state = this.actions.state();
    this.list.updateValue("model", this.modelLabel());
    this.list.updateValue("enabled", state.enabled ? "on" : "off");
    this.list.updateValue("default", state.defaultEnabled ? "on" : "off");
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

  private models(back: (value?: string) => void): Component {
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
      this.actions.state(),
      this.theme,
      this.keybindings,
      (selected) => {
        if (!active()) return;
        cancel();
        if (selected) void this.save(() => this.actions.selectModel(selected));
      },
      Math.max(1, this.height() - 8),
    );
    this.picker.focused = this.focused;
    void Promise.resolve()
      .then(() => this.actions.loadModels(controller.signal))
      .then((models) => {
        if (!active()) return;
        if (!models.length)
          throw new Error("没有可用模型，请先用 /login 配置 provider");
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
      this.picker ? "翻译模型" : "翻译设置",
    );
    const hint = this.picker
      ? width < 55
        ? "Esc 返回 · Enter 保存"
        : "输入搜索 · ↑↓ 选择 · Enter 保存 · Esc 返回"
      : width < 40
        ? "Esc 关闭 · Enter 更改"
        : "Enter/Space 更改 · Esc 关闭";
    const feedback = this.feedback || this.actions.state().error || "";
    const nativeRows = this.list.render(Math.max(1, width - 2));
    const content = this.picker ? nativeRows : nativeRows.slice(0, -2);
    const body = content.slice(0, Math.max(1, height - 5));
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
