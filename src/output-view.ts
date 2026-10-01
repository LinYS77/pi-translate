import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export interface OutputLayout {
  outputPad: 0 | 1;
  codeBlockIndent: string;
}

/** Reuse pi's assistant renderer for display only; this message is never submitted or stored as a message. */
export function translationView(
  text: string,
  layout: OutputLayout = { outputPad: 1, codeBlockIndent: "  " },
): Component {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: "openai-completions",
    provider: "pi-translate",
    model: "display-only",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const native = new AssistantMessageComponent(
    message,
    true,
    { ...getMarkdownTheme(), codeBlockIndent: layout.codeBlockIndent },
    undefined,
    layout.outputPad,
  );
  return {
    render(width) {
      const lines = native.render(width);
      // CustomEntryComponent already supplies the leading blank line. Merge the
      // native spacer's terminal zone marker into its next line, without double spacing.
      return lines.length > 1 ? [lines[0] + lines[1], ...lines.slice(2)] : [];
    },
    invalidate() {
      native.invalidate();
    },
  };
}
