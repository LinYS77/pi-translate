import type { Direction } from "../../src/translation-plan.ts";

/** Public synthetic examples only; safe to send with the opt-in evaluation script. */
export const routingCases: {
  id: string;
  text: string;
  direction: Direction;
  translate: boolean;
}[] = [
  {
    id: "english-input",
    text: "Inspect the files. Do NOT modify them.",
    direction: "en",
    translate: false,
  },
  {
    id: "literal-label",
    text: "Set the label to “保存”.",
    direction: "en",
    translate: false,
  },
  {
    id: "chinese-input",
    text: "先检查原因，不要修改文件，也不要重新运行训练。",
    direction: "en",
    translate: true,
  },
  {
    id: "command-input",
    text: "不要运行 `npm install`。",
    direction: "en",
    translate: true,
  },
  {
    id: "history-reference",
    text: "按刚才第二种方案修改，但先不要运行训练。",
    direction: "en",
    translate: true,
  },
  {
    id: "chinese-output",
    text: "已完成，请先检查结果。",
    direction: "zh",
    translate: false,
  },
  {
    id: "embedded-terms",
    text: "使用 Docker 部署，使用 PyTorch 训练。",
    direction: "zh",
    translate: false,
  },
  {
    id: "technical-phrase",
    text: "已启用 gradient accumulation。",
    direction: "zh",
    translate: false,
  },
  {
    id: "mixed-warning",
    text: "已完成。Warning: do not retry.",
    direction: "zh",
    translate: true,
  },
  {
    id: "short-negation",
    text: "不要继续。Do not retry.",
    direction: "zh",
    translate: true,
  },
  { id: "allcaps-warning", text: "STOP", direction: "zh", translate: true },
  {
    id: "prose-quote",
    text: 'He said: "Do not retry after 42 seconds."',
    direction: "zh",
    translate: true,
  },
  {
    id: "code-only",
    text: "```ts\nconst label = '保存';\n```",
    direction: "en",
    translate: false,
  },
  {
    id: "literals-only",
    text: "`npm install` /tmp/data https://example.com 42",
    direction: "zh",
    translate: false,
  },
  {
    id: "english-output",
    text: "The update is complete. Do not restart the service yet.",
    direction: "zh",
    translate: true,
  },
  {
    id: "table",
    text: "| Item | Status |\n| --- | --- |\n| API | Ready |",
    direction: "zh",
    translate: true,
  },
];
