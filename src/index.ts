import { join } from "node:path";
import { getAgentDir, getMarkdownTheme, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { FAILURE, OUTPUT, registerTranslation, type FailureData, type OutputData } from "./extension.ts";

export default function (pi: ExtensionAPI) {
  const [major, minor, patch] = VERSION.split(".").map(Number);
  if (!(major > 0 || minor > 99 || (minor === 99 && patch >= 2)) || typeof pi.registerEntryRenderer !== "function") {
    throw new Error("pi-translate 需要 pi >= 0.99.2：必须支持 agent_settled 和非上下文 entry renderer，不能回退到 message_end");
  }
  pi.registerEntryRenderer<OutputData>(OUTPUT, (entry, _options, theme) => {
    if (!entry.data) return;
    const content = new Container();
    content.addChild(new Text(theme.fg("muted", "中文译文 · 仅供阅读"), 1, 1));
    content.addChild(new Markdown(entry.data.translated, 1, 0, getMarkdownTheme()));
    return content;
  });
  pi.registerEntryRenderer<FailureData>(FAILURE, (entry, _options, theme) => {
    if (!entry.data) return;
    const data = entry.data;
    const content = new Container();
    content.addChild(new Text(theme.fg("error", `${data.direction === "input" ? "输入翻译失败 · 未提交" : "回答翻译失败 · 原回答保留"}：${data.error}`), 1, 1));
    if (data.direction === "input") {
      content.addChild(new Text(data.original, 1, 0));
      content.addChild(new Text(theme.fg("dim", "/translate recover 恢复文本后可手动重新提交；不会自动重试"), 1, 1));
    }
    return content;
  });
  registerTranslation(pi, process.env.PI_TRANSLATE_CONFIG ?? join(getAgentDir(), "pi-translate.json"));
}
