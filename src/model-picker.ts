import type { Api, Model } from "@earendil-works/pi-ai";
import { DynamicBorder, getSelectListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, type Focusable, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";

/** A session-independent picker: selecting never touches pi's main model or defaults. */
export class TranslationModelPicker extends Container implements Focusable {
  private readonly search: Input;
  private readonly listHost = new Container();
  private list!: SelectList;
  private readonly models: Model<Api>[];
  private _focused = false;

  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.search.focused = value; }

  constructor(
    models: readonly Model<Api>[],
    private readonly current: { provider?: string; model?: string },
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (model: Model<Api> | undefined) => void,
  ) {
    super();
    const isCurrent = (m: Model<Api>) => m.provider === current.provider && m.id === current.model;
    this.models = [...models].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)) ||
      a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    this.search = new Input({ prompt: "> ", placeholder: "搜索模型名称、ID 或 provider" });
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    this.addChild(new Text(theme.fg("accent", "选择翻译模型 · 主模型不变"), 1, 0));
    this.addChild(new Text(theme.fg("muted", "只显示已配置凭据的 provider；选择后跨会话保存。"), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.listHost);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "输入搜索 · ↑↓选择 · Enter 保存 · Esc 取消"), 1, 0));
    this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    this.updateList();
  }

  private updateList() {
    const query = this.search.getValue().trim();
    const matches = query ? fuzzyFilter(this.models, query, (m) => `${m.id} ${m.provider} ${m.name}`) : this.models;
    const byValue = new Map(matches.map((m) => [JSON.stringify([m.provider, m.id]), m]));
    this.list = new SelectList(matches.map((m) => ({
      value: JSON.stringify([m.provider, m.id]),
      label: `${m.id}${m.provider === this.current.provider && m.id === this.current.model ? " ✓" : ""}`,
      description: `[${m.provider}] ${m.name}`,
    })), 10, { ...getSelectListTheme(), noMatch: () => this.theme.fg("muted", "没有匹配的模型") });
    this.list.onSelect = (item) => this.done(byValue.get(item.value));
    this.list.onCancel = () => this.done(undefined);
    this.listHost.clear();
    this.listHost.addChild(this.list);
  }

  handleInput(data: string) {
    const navigation = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;
    if (navigation.some((action) => this.keybindings.matches(data, action))) this.list.handleInput(data);
    else {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.updateList();
    }
    this.tui.requestRender();
  }
}

export function pickTranslationModel(ctx: ExtensionContext, models: readonly Model<Api>[], current: { provider?: string; model?: string }) {
  return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) =>
    new TranslationModelPicker(models, current, tui, theme, keybindings, done));
}
