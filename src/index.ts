import { join } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  FAILURE,
  OUTPUT,
  registerTranslation,
  type FailureData,
  type OutputData,
} from "./extension.ts";
import { translationView } from "./output-view.ts";

export default function (pi: ExtensionAPI) {
  const [major, minor, patch] = VERSION.split(".").map(Number);
  if (
    !(major > 0 || minor > 99 || (minor === 99 && patch >= 2)) ||
    typeof pi.registerEntryRenderer !== "function"
  ) {
    throw new Error(
      "pi-translate 需要 pi >= 0.99.2：必须支持 agent_settled 和非上下文 entry renderer，不能回退到 message_end",
    );
  }
  let displayContext: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => {
    displayContext = ctx;
  });
  pi.on("session_shutdown", () => {
    displayContext = undefined;
  });
  pi.registerEntryRenderer<OutputData>(OUTPUT, (entry) => {
    if (!entry.data?.translated.trim()) return;
    // Read only display settings. They never enter a translation request or model context.
    const settings = displayContext
      ? SettingsManager.create(displayContext.cwd, getAgentDir(), {
          projectTrusted: displayContext.isProjectTrusted(),
        })
      : SettingsManager.inMemory();
    return translationView(entry.data.translated, {
      outputPad: settings.getOutputPad(),
      codeBlockIndent: settings.getCodeBlockIndent(),
    });
  });
  pi.registerEntryRenderer<FailureData>(FAILURE, (entry, _options, theme) => {
    if (!entry.data) return;
    const data = entry.data;
    const content = new Container();
    content.addChild(
      new Text(
        theme.fg(
          "error",
          `${data.direction === "input" ? "输入翻译失败 · 未提交" : "回答翻译失败 · 原回答保留"}：${data.error}`,
        ),
        1,
        1,
      ),
    );
    if (data.direction === "input") {
      content.addChild(new Text(data.original, 1, 0));
      content.addChild(
        new Text(
          theme.fg(
            "dim",
            "/translate 中选择“恢复输入”后可手动重新提交；不会自动重试",
          ),
          1,
          1,
        ),
      );
    }
    return content;
  });
  registerTranslation(
    pi,
    process.env.PI_TRANSLATE_CONFIG ?? join(getAgentDir(), "pi-translate.json"),
  );
}
