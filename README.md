<div align="center">

# ⇄ pi-translate

**Chinese prompts, English context, Chinese answers for [Pi](https://github.com/earendil-works/pi).**

English · [简体中文](./README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@linys77/pi-translate?style=flat-square)](https://www.npmjs.com/package/@linys77/pi-translate)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

</div>

## Install

```bash
# Try it for one session
pi -e npm:@linys77/pi-translate

# Or install it
pi install npm:@linys77/pi-translate
```

Restart Pi or run `/reload`.

Git installation is also supported: `pi install git:github.com/LinYS77/pi-translate`.
Use one installation source. Remove an existing Git/local install before switching to npm.

## Features

- **Bidirectional** — Chinese input becomes English after submission; the final answer gets a Chinese translation when the task settles.
- **Independent models** — one translation model for both directions; optional Jev classification decides which passages need translation. Your main model stays unchanged.
- **Quiet status** — `Alt+T` toggles translation; `译 on` / `译 off` shows the state. A single spinner appears while translating.
- **Native output** — translations use Pi's assistant layout, without an extra label. Original answers stay visible.
- **Context isolation** — translations are display-only. No history, tools, project files or images are sent to the translator.

No runtime dependencies to install separately. No telemetry.

## Configure

Run `/translate` to choose the **Translation model**, **Timeout**, **Decision route** (local rules or Jev), **Current switch**, and **New-session default**. Jev has its own classifier model picker. Arrows navigate, `Enter` changes, and `Esc` returns or closes; everything stays in one Pi-managed panel.

Models and startup defaults are saved automatically. The current switch is temporary. Configure the model once; new conversations reuse it.

This is the extension's only command. There are no subcommands and no changes to Pi's `/settings`.

## Notes

- Off by default. Intermediate messages, thinking, tools and past answers are never translated. Toggling mid-task affects the next task, not the current answer.
- Providers need working credentials. Use Pi's `/login` or `models.json`; the extension does not store API keys.
- Each translation has a **10-minute** total deadline by default, including classification and recovery. Change it in `/translate` (up to 1 hour). Existing explicit values are preserved.
- Local rules are the default. Jev uses Pi's classifier credentials; unavailable or uncertain judgments visibly fall back to local rules. Jev is not a translator and is less reliable on CJK text.
- Input failures block submission and preserve the original. **Restore input** appears in `/translate` when recovery data exists; it never overwrites a draft or submits automatically.
- Output failures keep the original answer. If only some passages fail, their source text stays in place with a visible partial-translation warning. Code blocks stay local; inline literals remain protected. Ordinary prose still depends on the model's accuracy.
- TUI only. Native commands and extension-generated inputs pass through unchanged. Requires Pi 0.99.2+ and Node.js 22.19+.

Details: [configuration and behavior](docs/behavior.md).

## Update

```bash
pi update npm:@linys77/pi-translate
```

Git installs use `pi update git:github.com/LinYS77/pi-translate`.
Local development installs reference their directory directly; use `/reload` after editing.

## Contributing

```bash
npm ci --ignore-scripts
npm run verify
```

Tests use temporary sessions and fake providers. They do not call a paid model or read your credentials. See [development](docs/behavior.md#development).

## License

[MIT](LICENSE)
