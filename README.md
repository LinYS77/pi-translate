<div align="center">

# ⇄ pi-translate

**Chinese prompts, English context, Chinese answers for [Pi](https://github.com/earendil-works/pi).**

English · [简体中文](./README.zh-CN.md)

[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

</div>

## Install

```bash
# Try it for one session
pi -e git:github.com/LinYS77/pi-translate

# Or install it
pi install git:github.com/LinYS77/pi-translate
```

Restart Pi or run `/reload`.

The npm package is prepared as **`@linys77/pi-translate`**; its first release is pending. After publication:

```bash
pi install npm:@linys77/pi-translate
```

Use one installation source. Remove an existing Git/local install before switching to npm.

## Features

- **Bidirectional** — Chinese input becomes English after submission; the final answer gets a Chinese translation when the task settles.
- **Independent model** — one translation model for both directions, using Pi's configured providers. Your main model stays unchanged.
- **Quiet status** — `Alt+T` toggles translation; `译 on` / `译 off` shows the state. A single spinner appears while translating.
- **Native output** — translations use Pi's assistant layout, without an extra label. Original answers stay visible.
- **Context isolation** — translations are display-only. No history, tools, project files or images are sent to the translator.

No runtime dependencies to install separately. No telemetry.

## Configure

Run `/translate` for **Translation model**, **Current switch**, and **New-session default**. Arrows navigate, `Enter` changes, and `Esc` closes. Model search stays in the same Pi-managed panel; `Esc` returns to the menu.

Models and startup defaults are saved automatically. The current switch is temporary. Configure the model once; new conversations reuse it.

This is the extension's only command. There are no subcommands and no changes to Pi's `/settings`.

## Notes

- Off by default. Intermediate messages, thinking, tools and past answers are never translated. Toggling mid-task affects the next task, not the current answer.
- Providers need working credentials. Use Pi's `/login` or `models.json`; the extension does not store API keys.
- Input failures block submission and preserve the original. **Restore input** appears in `/translate` when recovery data exists; it never overwrites a draft or submits automatically.
- Output failures keep the original answer. Code, paths and other recognizable literals are protected; ordinary prose still depends on the translation model's accuracy.
- TUI only. Native commands and extension-generated inputs pass through unchanged. Requires Pi 0.99.2+ and Node.js 22.19+.

Details: [configuration and behavior](docs/behavior.md) · [manual checks](https://github.com/LinYS77/pi-translate/blob/main/docs/acceptance.md).

## Update

```bash
pi update git:github.com/LinYS77/pi-translate
# For an npm installation, after publication:
pi update npm:@linys77/pi-translate
```

Local development installs reference their directory directly; use `/reload` after editing.

## Contributing

```bash
npm ci --ignore-scripts
npm run verify
```

Tests use temporary sessions and fake providers. They do not call a paid model or read your credentials. See [development](docs/behavior.md#development) and the [release checklist](https://github.com/LinYS77/pi-translate/blob/main/docs/releasing.md).

## License

[MIT](LICENSE)
