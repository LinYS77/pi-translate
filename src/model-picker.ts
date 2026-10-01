import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  Input,
  SelectList,
  Spacer,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";

/** A session-independent picker: selecting never touches pi's main model or defaults. */
export class TranslationModelPicker extends Container implements Focusable {
  private readonly search: Input;
  private readonly listHost = new Container();
  private list!: SelectList;
  private models: Model<Api>[];
  private _focused = false;
  private loading = false;
  private maxVisible: number;

  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(
    models: readonly Model<Api>[],
    private readonly current: { provider?: string; model?: string },
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (model: Model<Api> | undefined) => void,
    maxVisible = 6,
  ) {
    super();
    this.maxVisible = maxVisible;
    this.loading = models.length === 0;
    this.models = this.sortModels(models);
    this.search = new Input({
      prompt: "> ",
      placeholder: "搜索模型名称、ID 或 provider",
    });
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.listHost);
    this.updateList();
  }

  private sortModels(models: readonly Model<Api>[]) {
    const isCurrent = (m: Model<Api>) =>
      m.provider === this.current.provider && m.id === this.current.model;
    return [...models].sort(
      (a, b) =>
        Number(isCurrent(b)) - Number(isCurrent(a)) ||
        a.provider.localeCompare(b.provider) ||
        a.id.localeCompare(b.id),
    );
  }
  setModels(models: readonly Model<Api>[]) {
    this.loading = false;
    this.models = this.sortModels(models);
    this.updateList(true);
  }

  setVisibleRows(rows: number) {
    if (rows === this.maxVisible) return;
    this.maxVisible = rows;
    this.updateList(true);
  }

  private updateList(keepSelection = false) {
    const selected = keepSelection
      ? this.list?.getSelectedItem()?.value
      : undefined;
    const query = this.search.getValue().trim();
    const matches = query
      ? fuzzyFilter(
          this.models,
          query,
          (m) => `${m.id} ${m.provider} ${m.name}`,
        )
      : this.models;
    const byValue = new Map(
      matches.map((m) => [JSON.stringify([m.provider, m.id]), m]),
    );
    this.list = new SelectList(
      matches.map((m) => ({
        value: JSON.stringify([m.provider, m.id]),
        label: `${m.id}${m.provider === this.current.provider && m.id === this.current.model ? " ✓" : ""}`,
        description: `[${m.provider}] ${m.name}`,
      })),
      this.maxVisible,
      {
        ...getSelectListTheme(),
        noMatch: () =>
          this.theme.fg("muted", this.loading ? "读取模型…" : "没有匹配的模型"),
      },
    );
    if (selected)
      this.list.setSelectedIndex(
        Math.max(
          0,
          matches.findIndex(
            (m) => JSON.stringify([m.provider, m.id]) === selected,
          ),
        ),
      );
    this.list.onSelect = (item) => this.done(byValue.get(item.value));
    this.list.onCancel = () => this.done(undefined);
    this.listHost.clear();
    this.listHost.addChild(this.list);
  }

  handleInput(data: string) {
    const navigation = [
      "tui.select.up",
      "tui.select.down",
      "tui.select.pageUp",
      "tui.select.pageDown",
      "tui.select.confirm",
      "tui.select.cancel",
    ] as const;
    if (navigation.some((action) => this.keybindings.matches(data, action)))
      this.list.handleInput(data);
    else {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.updateList();
    }
  }
}
