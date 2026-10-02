# Configuration and behavior

## Settings

`/translate` is the only extension command and accepts no arguments. `Alt+T` is the quick switch. Configuration stays in a single Pi-managed overlay (`ctx.ui.custom`); returning from search or changing a value does not replace the input editor or reopen the panel. It does not integrate with Pi's `/settings`.

The menu has three settings:

| Setting | Behavior |
| --- | --- |
| Translation model | Search Pi's available chat models by name, provider or ID. Enter saves the selection; Esc returns without selecting. |
| Current switch | Temporary on/off for future submissions. Same effect as Alt+T. |
| New-session default | Saved on/off for new sessions, restarts and reloads; does not change the current switch. |

Changes are saved immediately, not on close. A failed save leaves the old value intact and shows an inline error. **Restore input** appears only when extension-owned recovery data is available. It fills an empty editor, closes the panel and never submits.

The model and default policy are shared across projects using the same agent directory. Choosing a model never changes the main model, scoped models or main-model default. It also never persists a temporary Alt+T switch.

## Configuration file

Default: `~/.pi/agent/pi-translate.json`, following Pi's `getAgentDir()`. `PI_TRANSLATE_CONFIG` can select another file. Switching that path or agent directory means using another configuration.

```json
{
  "enabled": false,
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "timeoutMs": 600000,
  "maxTokens": 8192
}
```

The example model must be available in your own Pi setup; no provider or credentials are bundled. `enabled` is the saved startup policy. `timeoutMs` defaults to **600000 ms (10 minutes)** for both directions and accepts 100–3600000 ms (up to 1 hour). This is the extension's total request deadline, including model thinking time; provider or gateway timeouts may still be shorter. Esc and session shutdown still cancel immediately. `maxTokens` accepts 64–131072 and is capped by the model's output limit.

**Upgrading from 0.1.0:** explicit saved values are respected. If your configuration contains `"timeoutMs": 60000`, change it to `600000` and run `/reload`; upgrading the package alone does not replace an explicit timeout.

For advanced edits, use Pi's `/reload` to apply the file. Unknown keys or invalid values are errors, not silent defaults. The file contains no credentials. Selecting a model reloads local model definitions without a network catalog refresh or a paid test request.

### Custom endpoints

Configure endpoints in Pi's `models.json`, not in this extension. For an OpenAI Chat Completions-compatible API:

```json
{
  "providers": {
    "translation-api": {
      "baseUrl": "https://your-gateway.example/v1",
      "api": "openai-completions",
      "apiKey": "${TRANSLATE_API_KEY}",
      "models": [{ "id": "your-model-id" }]
    }
  }
}
```

Merge into the existing file rather than replacing other providers. Supply `TRANSLATE_API_KEY` to the process starting Pi. Then choose the model inside `/translate`. An entry in the available list means credentials are configured, not that the remote service is guaranteed to work.

## Boundaries

Input uses the switch and model snapshot at submission. Output uses the snapshot taken at task start until `agent_settled`. Turning off while a task runs does not remove that task's final translation; turning on does not translate a task that started off.

Retries, compaction continuations, steering and follow-up queues can all be part of one Pi activity. Each new input uses its submission snapshot, while only the last eligible answer at settlement is translated. A message ending is not a task ending. Aborts, errors, length stops, tool calls, tool results and empty answers do not fall back to previous text.

The status is `译 on` / `译 off`, plus one animated braille character while translating. A differing task policy is shown as `本任务 on/off`. The extension disposes animation and its requests on session replacement, tree navigation or shutdown; late results are discarded.

## Data isolation and fidelity

A translation request contains only fixed rules and the current text, with recognized literals masked by random placeholders. It contains no chat history, main system prompt, tool definitions/results, attachments or project files. References such as “the second option above” are translated without resolving them.

The main model receives one transformed input. Original assistant answers remain unchanged. Input backups, failures and translated output are custom session entries, not messages; `buildSessionContext()` excludes them. The synthetic assistant object used by the renderer is only a visual component, never a conversation message.

Recognized code fences, inline code, paths, URLs, common identifiers, numbers, formulas and quoted literals are protected. Missing, duplicate or damaged placeholders fail closed. English inputs are unchanged; Chinese outputs with no English prose to translate produce no duplicate answer. Existing Han text and mixed-input English terms are protected.

Literal detection is not a complete programming-language or Markdown parser. Use backticks or code fences for commands and exact strings. Quoted text is conservatively kept literal in both directions. Translation quality cannot be proved by these checks; review negations, warnings and uncertainties with the model you actually choose.

## Recovery and display

- Input failures block submission; they do not silently submit Chinese or retry. The original is persisted before the request. An empty editor is restored automatically; a newer draft is not overwritten. Explicit recovery is available inside `/translate`.
- Output failures leave the completed task and original answer intact. The main task is not rerun.
- Image data stays with the original input backup, but Pi has no public API for restoring image attachments to the editor. Reattach images after restoring text.
- Native commands, skill/template invocations and `!` shell inputs keep their original semantics. RPC, JSON, print and other extensions' inputs bypass translation.
- Pi's native assistant renderer provides Markdown and spacing. The extension follows saved `outputPad` / `markdown.codeBlockIndent`, with project-trust rules. It adds no heading or label.
- Other extensions' Markdown transformers are not applied to custom entries. Copy-last-assistant still targets the original answer. Output translation usage is retained in custom entries, not added through fake context messages to the main-model totals. Each translated input has one original-text backup; its English text already lives in the real user message.
- Opening an old session only redraws existing translations. It never translates history.

## Development

```bash
npm ci --ignore-scripts
npm run verify
```

`verify` runs formatting, strict TypeScript (including unused-code checks), behavioral tests and an actual tarball load in Pi. `format` applies the shared formatter. CI runs the same checks on Node 22.19.0 and 24. The package check uses `tar`, cleans up its temporary archive and excludes tests, scripts and maintainer docs from publication.

Tests cover real Pi session events, context isolation, failures, native rendering, the one-overlay settings lifecycle, fixed panel dimensions, focus, cancellation, deferred model loading, save rollback and spinner disposal. Tests use fake providers and temporary directories; real model quality needs separate [manual checks](https://github.com/LinYS77/pi-translate/blob/main/docs/acceptance.md). Release steps: [releasing.md](https://github.com/LinYS77/pi-translate/blob/main/docs/releasing.md).

Files:

- `src/index.ts`: entry point, version gate and renderers.
- `src/extension.ts`: translation lifecycle, task snapshots, status and persisted settings.
- `src/settings-pane.ts`: one Pi-managed settings interaction with internal submenus.
- `src/model-picker.ts`: model search using Pi's input and selection components.
- `src/translator.ts`: current-text requests, literal protection, deadline and cancellation.
- `src/output-view.ts`: native assistant layout, display only.
- `src/config.ts`: validation and atomic configuration writes.

The development API is pinned to Pi 0.99.2. Its published shrinkwrap contains a `brace-expansion` audit warning that ordinary npm updates and a root override do not resolve. `npm audit --omit=dev` reports no vulnerabilities; the extension does not bundle Pi or that dependency. Runtime host security also depends on the Pi version you install.
