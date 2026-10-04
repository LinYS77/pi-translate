<div align="center">

# ⇄ pi-translate

**在 [Pi](https://github.com/earendil-works/pi) 中用中文输入、英文任务说明、中文阅读。**

[English](./README.md) · 简体中文

[![npm](https://img.shields.io/npm/v/@linys77/pi-translate?style=flat-square)](https://www.npmjs.com/package/@linys77/pi-translate)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

</div>

## 安装

```bash
# 单次试用
pi -e npm:@linys77/pi-translate

# 或永久安装
pi install npm:@linys77/pi-translate
```

重启 Pi，或执行 `/reload`。

也支持 Git 安装：`pi install git:github.com/LinYS77/pi-translate`。
只保留一种安装来源。切换到 npm 前，先移除已有的 Git / 本地安装。

## 功能

- **双向翻译** — 提交后将中文任务说明转英文，原始任务材料保持原样；任务真正结束后，最终回答转中文。
- **独立模型** — 两个方向共用一个翻译模型；可选 Jev 判断哪些片段需要翻译。复用 Pi 的 provider，主模型不变。
- **克制状态** — `Alt+T` 切换，`译 on` / `译 off` 显示状态；翻译中只有一个动态 spinner。
- **原生排版** — 译文使用 Pi 的 assistant 样式，没有额外标签，原回答保留。
- **上下文隔离** — 译文只供显示；翻译模型不接收历史、工具、项目文件或图片。

无需单独安装运行时依赖，无遥测。

## 配置

执行 `/translate`，设置**翻译模型、翻译超时、判断方式（本地规则 / Jev）、当前开关、新对话默认**。Jev 有独立的判断模型选择。方向键导航，`Enter` 更改，`Esc` 返回或关闭；所有操作都在同一个 Pi 管理的面板内完成。

模型和默认状态自动保存；当前开关临时生效。模型只需配置一次，新对话自动复用。

扩展只有这一个命令，没有子命令，也不改动 Pi 的 `/settings`。

## 说明

- 默认关闭。不翻译过程消息、思考、工具或历史回答；`Alt+T` 即时生效：关闭会取消未完成的翻译，在当前回答结束前开启会翻译其最终回答；不补译历史。
- provider 需要可用凭据。通过 Pi 的 `/login` 或 `models.json` 配置，扩展不保存 API key。
- 每次翻译默认有 **10 分钟**总期限，包含判断和恢复尝试。在 `/translate` 中修改，最多 1 小时；已有显式超时值不被覆盖。
- 默认使用本地规则。Jev 辅助判断歧义内容的角色及输出语言，不得推翻明确的任务说明或材料保留规则。Jev 不可用或判断不确定时静默回退，不确定的输入材料保留原语种。Jev 不生成译文，对 CJK 文本的可靠性相对较低。
- 输入失败会阻止提交并保留原文。`Ctrl+Alt+T` 将最近可恢复的原文填回空输入框，不自动提交。若终端或系统拦截快捷键，仍可在 `/translate` 中选择**恢复输入**；两个入口都不覆盖草稿。
- 输出失败保留原回答。仅部分片段失败时，失败片段原位保留原文，并明确提示部分翻译。代码块留在本地，行内字面内容仍受保护；普通正文的准确性取决于翻译模型。
- 仅支持 TUI。原生命令和其他扩展生成的输入保持原样。要求 Pi 0.99.2+、Node.js 22.19+。

更多：[配置与行为](docs/behavior.md)。

## 更新

```bash
pi update npm:@linys77/pi-translate
```

Git 安装使用 `pi update git:github.com/LinYS77/pi-translate`。
本地开发安装直接引用项目目录，修改后执行 `/reload`。

## 开发

```bash
npm ci --ignore-scripts
npm run verify
```

测试使用临时会话和模拟 provider，不调用付费模型、不读取你的凭据。参见[开发说明](docs/behavior.md#development)。

## 许可

[MIT](LICENSE)
