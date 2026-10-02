import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  type EntryRenderer,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import {
  defaults,
  loadConfig,
  parseConfig,
  saveConfig,
} from "../src/config.ts";
import { OUTPUT } from "../src/extension.ts";
import { translationView } from "../src/output-view.ts";
import { assistant } from "./helpers.ts";

test("strict configuration, defaults, atomic round trip, corrupt-file error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-config-"));
  try {
    const path = join(dir, "translate.json");
    assert.equal(defaults.timeoutMs, 600_000);
    assert.deepEqual(await loadConfig(path), defaults);
    const config = {
      ...defaults,
      provider: "other",
      model: "cheap",
      enabled: true,
    };
    await saveConfig(path, config);
    assert.deepEqual(await loadConfig(path), config);
    for (const timeoutMs of [100, 60_000, 600_000, 3_600_000]) {
      await saveConfig(path, { ...config, timeoutMs });
      assert.equal((await loadConfig(path)).timeoutMs, timeoutMs);
    }
    for (const raw of [
      null,
      [],
      { enabled: "yes" },
      { provider: "foo" },
      { model: "" },
      { timeoutMs: 0 },
      { timeoutMs: 99 },
      { timeoutMs: 3_600_001 },
      { maxTokens: 1.5 },
      { unknown: 42 },
    ]) {
      assert.throws(() => parseConfig(raw));
    }
    await writeFile(path, "{broken");
    await assert.rejects(loadConfig(path));
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("translated entries use exactly native assistant spacing and Markdown, without a label", () => {
  initTheme("dark", false);
  const renderers = new Map<string, EntryRenderer<any>>();
  extension({
    registerEntryRenderer: (type: string, renderer: EntryRenderer<any>) =>
      renderers.set(type, renderer),
    on: () => {},
    registerCommand: () => {},
    registerShortcut: () => {},
  } as unknown as ExtensionAPI);
  const renderer = renderers.get(OUTPUT)!;
  const theme = { fg: (_color: unknown, text: string) => text } as Theme;
  const content =
    "# 中文回答\n\n不要重新运行训练。\n\n- 保留警告和不确定性\n- 数量不变\n\n| 项目 | 数量 |\n| --- | --- |\n| 文件 | 2 |\n\n```ts\nconst save = '保存';\n```\n";
  const component = renderer(
    {
      type: "custom",
      id: "view",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: OUTPUT,
      data: { translated: content },
    },
    { expanded: false },
    theme,
  )!;
  const native = new AssistantMessageComponent(assistant(content), true);
  for (const width of [24, 40, 80]) {
    component.invalidate();
    const lines = component.render(width);
    assert.ok(lines.length > 5);
    assert.ok(lines.join("\n").includes("中文回答"));
    assert.ok(lines.join("\n").includes("不要重新运行训练"));
    assert.ok(!lines.join("\n").includes("中文译文 · 仅供阅读"));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    // The host adds ONE leading spacer to custom entries; no extra heading or margin.
    assert.deepEqual(
      ["", ...lines].map(stripVTControlCharacters),
      native.render(width).map(stripVTControlCharacters),
    );
  }
});

test("translation view follows native output padding and code block indentation", () => {
  initTheme("dark", false);
  const text = "  第一段。\n\n第二段。\n\n```ts\nconst label = '保存';\n```\n";
  for (const outputPad of [0, 1] as const) {
    for (const codeBlockIndent of ["", "  ", "    "]) {
      const component = translationView(text, { outputPad, codeBlockIndent });
      const native = new AssistantMessageComponent(
        assistant(text),
        true,
        { ...getMarkdownTheme(), codeBlockIndent },
        undefined,
        outputPad,
      );
      for (const width of [24, 40, 80]) {
        component.invalidate();
        assert.deepEqual(
          ["", ...component.render(width)].map(stripVTControlCharacters),
          native.render(width).map(stripVTControlCharacters),
        );
      }
    }
  }
});
