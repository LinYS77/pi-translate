<div align="center">

# ⇄ pi-translate

**在 [Pi](https://github.com/earendil-works/pi) 中用中文输入、英文上下文、中文阅读。**

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

- **双向翻译** — 中文输入提交后转英文；任务真正结束后，最终回答转中文。
- **独立模型** — 两个方向共用一个翻译模型，复用 Pi 已配置的 provider，主模型不变。
- **克制状态** — `Alt+T` 切换，`译 on` / `译 off` 显示状态；翻译中只有一个动态 spinner。
- **原生排版** — 译文使用 Pi 的 assistant 样式，没有额外标签，原回答保留。
- **上下文隔离** — 译文只供显示；翻译模型不接收历史、工具、项目文件或图片。

无需单独安装运行时依赖，无遥测。

## 配置

执行 `/translate`，设置**翻译模型、当前开关、新对话默认**。方向键导航，`Enter` 更改，`Esc` 关闭。模型搜索在同一个 Pi 管理的界面内展开，`Esc` 返回菜单。

模型和默认状态自动保存；当前开关临时生效。模型只需配置一次，新对话自动复用。

扩展只有这一个命令，没有子命令，也不改动 Pi 的 `/settings`。

## 说明

- 默认关闭。不翻译过程消息、思考、工具或历史回答；任务中切换只影响下一个任务，不改变当前回答。
- provider 需要可用凭据。通过 Pi 的 `/login` 或 `models.json` 配置，扩展不保存 API key。
- 输入失败会阻止提交并保留原文。有恢复记录时，`/translate` 显示**恢复输入**；不覆盖草稿，不自动重交。
- 输出失败保留原回答。代码、路径等可识别字面内容受到保护，普通正文的准确性仍取决于翻译模型。
- 仅支持 TUI。原生命令和其他扩展生成的输入保持原样。要求 Pi 0.99.2+、Node.js 22.19+。

更多：[配置与行为](docs/behavior.md) · [手工验收](https://github.com/LinYS77/pi-translate/blob/main/docs/acceptance.md)。

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

测试使用临时会话和模拟 provider，不调用付费模型、不读取你的凭据。参见[开发说明](docs/behavior.md#development)与[发布清单](https://github.com/LinYS77/pi-translate/blob/main/docs/releasing.md)。

## 许可

[MIT](LICENSE)
