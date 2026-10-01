import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, initTheme, SettingsManager, type EntryRenderer, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import { defaults, loadConfig, parseConfig, saveConfig } from "../src/config.ts";
import { OUTPUT } from "../src/extension.ts";

test("strict configuration, defaults, atomic round trip, corrupt-file error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-config-"));
  try {
    const path = join(dir, "translate.json");
    assert.deepEqual(await loadConfig(path), defaults);
    const config = { ...defaults, provider: "other", model: "cheap", enabled: true };
    await saveConfig(path, config); assert.deepEqual(await loadConfig(path), config);
    for (const raw of [null, [], { enabled: "yes" }, { provider: "foo" }, { model: "" }, { timeoutMs: 0 }, { maxTokens: 1.5 }, { unknown: 42 }]) {
      assert.throws(() => parseConfig(raw));
    }
    await writeFile(path, "{broken"); await assert.rejects(loadConfig(path));
    assert.equal(await readFile(path, "utf8"), "{broken");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("entry renderer uses native Markdown and keeps long Chinese text in chat at narrow widths", () => {
  initTheme("dark", false);
  const renderers = new Map<string, EntryRenderer<any>>();
  extension({
    registerEntryRenderer: (type: string, renderer: EntryRenderer<any>) => renderers.set(type, renderer),
    on: () => {}, registerCommand: () => {}, registerShortcut: () => {},
  } as unknown as ExtensionAPI);
  const renderer = renderers.get(OUTPUT)!;
  const theme = { fg: (_color: unknown, text: string) => text } as Theme;
  const content = "# 中文回答\n\n不要重新运行训练。\n\n- 保留警告和不确定性\n- 数量不变\n\n| 项目 | 数量 |\n| --- | --- |\n| 文件 | 2 |\n\n```ts\nconst save = '保存';\n```\n";
  const component = renderer({ type: "custom", id: "view", parentId: null, timestamp: new Date().toISOString(), customType: OUTPUT, data: { translated: content } }, { expanded: false }, theme)!;
  for (const width of [24, 40, 80]) {
    component.invalidate();
    const lines = component.render(width);
    assert.ok(lines.length > 5);
    assert.ok(lines.join("\n").includes("中文回答"));
    assert.ok(lines.join("\n").includes("不要重新运行训练"));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("published TypeScript entry point loads through pi's actual extension loader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-translate-loader-"));
  try {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("src/index.ts")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].handlers.has("agent_settled"));
    assert.ok(loaded.extensions[0].entryRenderers?.has(OUTPUT));
    assert.ok(loaded.extensions[0].shortcuts.has("alt+t"));
    assert.ok(!loaded.extensions[0].shortcuts.has("ctrl+alt+t"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
