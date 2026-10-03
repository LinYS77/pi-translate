# Configuration and behavior

## Settings

`/translate` is the only extension command and accepts no arguments. `Alt+T` is the quick switch. Configuration stays in a single Pi-managed overlay (`ctx.ui.custom`); returning from search or changing a value does not replace the input editor or reopen the panel. It does not integrate with Pi's `/settings`.

The menu stays in one overlay, including model search and the custom timeout editor:

| Setting | Behavior |
| --- | --- |
| Translation model | Search Pi's available chat models by name, provider or ID. Enter saves the selection; Esc returns without selecting. |
| Current switch | Temporary on/off for future submissions. Same effect as Alt+T. |
| New-session default | Saved on/off for new sessions, restarts and reloads; does not change the current switch. |
| Translation timeout | 1, 5, 10, 20, 30 or 60 minutes, or custom seconds (0.1–3600, up to three decimal places). Existing values are displayed without rounding. |
| Decision route | Local rules (default), or Jev classification. |
| Classifier model | Visible under Jev; independently choose an authenticated Jev classifier, not a chat model. The selection is kept when switching back to local rules. |

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
  "maxTokens": 8192,
  "decisionMode": "local"
}
```

The example model must be available in your own Pi setup; no provider or credentials are bundled. `enabled` is the saved startup policy. `timeoutMs` defaults to **600000 ms (10 minutes)** for both directions and accepts 100–3600000 ms (up to 1 hour). This is one total operation deadline, including classification, all fragment requests, model thinking and recovery; provider or gateway timeouts may still be shorter. Esc and session shutdown still cancel immediately. `maxTokens` accepts 64–131072 and is capped by the model's output limit for each request.

`decisionMode` accepts `local` or `jev`. Old configurations default to `local` without being rewritten on read. Jev additionally uses the optional pair `classifierProvider` / `classifierModel` (for example `typesafe` / `jev-latest`). Both must be supplied together. Missing or unavailable classifiers visibly fall back to local rules. No classifier key, endpoint or SDK is configured here; use Pi's existing providers.

**Upgrading:** explicit saved values are respected. If your configuration contains `"timeoutMs": 60000`, choose a longer deadline in `/translate`; upgrading alone does not change it. Before downgrading to v0.1.x, remove `decisionMode`, `classifierProvider` and `classifierModel` or restore a configuration backup: the older strict parser rejects these new fields.

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

Input uses the switch, models, route and timeout snapshot at submission. Output uses the snapshot taken at task start until `agent_settled`. Turning off while a task runs does not remove that task's final translation; turning on does not translate a task that started off.

Retries, compaction continuations, steering and follow-up queues can all be part of one Pi activity. Each new input uses its submission snapshot, while only the last eligible answer at settlement is translated. A message ending is not a task ending. Aborts, errors, length stops, tool calls, tool results and empty answers do not fall back to previous text.

The status is `译 on` / `译 off`, plus one animated braille character while translating. A differing task policy is shown as `本任务 on/off`. The extension disposes animation and its requests on session replacement, tree navigation or shutdown; late results are discarded.

## Data isolation and fidelity

A translation request contains only fixed rules and a selected fragment of the current text, with remaining inline literals masked by random placeholders. Whole code blocks and unchanged paragraphs stay local. A classifier request contains the direction and readable candidates from the current text, never history or external context. Neither request contains the main system prompt, tool definitions/results, attachments or project files. References such as “the second option above” are translated without resolving them.

The main model receives one transformed input. Original assistant answers remain unchanged. Input backups, failures and translated output are custom session entries, not messages; `buildSessionContext()` excludes them. The synthetic assistant object used by the renderer is only a visual component, never a conversation message.

The source-position scanner keeps fenced/indented code and Markdown structure local rather than reserializing the document. It selects paragraphs, mixed-language sentence fragments, list items and table cells. Replacements preserve surrounding whitespace, CRLF, separators and unchanged source ranges. Inline code, paths, URLs, identifiers, numbers, formulas and recognizable literal labels remain protected. Missing, duplicate, unknown or damaged placeholders get at most one recovery attempt for that fragment, then fail closed; nothing is guessed back into place. Incomplete provider replies are not retried as literal-repair attempts.

Input can explicitly preserve a quoted block with a standalone marker such as `下面这段不要翻译:` or `Do not translate the following text:`, immediately followed by a paired `“…”`, `「…」`, `『…』` or double-quoted block. The marker is translated, but the entire block (including nested labels and code) stays local and is copied byte-for-byte. Text after the closing quote is processed normally. An unclosed marked quote blocks input with an actionable error, rather than guessing its extent. This is a narrow delimiter convention, not general understanding of arbitrary “do not translate” wording. Code fences remain the simplest way to preserve literal material. Markers inside code/quoted examples, or in assistant output, cannot control this input-only behavior.

Local rules distinguish embedded English terms from prose using neighboring language, word forms and function/warning words. English input and Chinese-only output pass through without a call. Chinese containing Docker/PyTorch or short technical phrases normally stays unchanged; short English warnings still need translation. Jev sees ambiguous candidates before the local heuristic filters them. It uses typed Choice questions, validates all answers, and falls back locally for uncertain, low-confidence or missing answers. A service failure stops further classification batches and uses local rules for the remaining candidates. One visible warning per operation explains classifier fallback, including when later translation fails.

Jev is not a translator. TypeSafe documents lower accuracy on CJK than English; local rules remain the default. Choice probability must be at least 0.8 and confidence at least 0.5, with a valid normalized distribution. These are initial conservative gates checked against the small synthetic evaluation, not calibrated correctness probabilities or a claim of general superiority.

Internal limits bound request amplification: at most 8 questions / 12,000 UTF-8 bytes of candidate text per classifier batch, an 8-second classifier request cap, sequential fragment requests, at most 64 requests and a 131,072-token operation budget. Each in-flight request reserves input bytes plus its output allowance. On completion, the reservation is settled using reported total usage; when usage is absent or zero, input and actual response bytes provide a conservative estimate. Unused `maxTokens` allowance is not repeatedly charged as consumption. Requests with unknown consumption after an exception/timeout retain their reservation. Over-capacity fragments are never silently truncated. Budget exhaustion follows the same input-blocking / partial-output policy as other failures. Usage sums all completed classifier, translation and repair responses; reported cost depends on Pi's catalog and may not include a price for direct TypeSafe calls.

This is not a complete programming-language or Markdown parser. Use backticks or fences for commands and exact strings. Quoted sentence prose may be translated, while explicit labels and ambiguous short quotes stay literal. Deeply nested indentation, unusual Markdown/HTML and ambiguous terms can still be misclassified. Checks cannot prove semantic fidelity; review negations, warnings and uncertainties with the model you actually choose.

## Recovery and display

- Input requires every selected fragment to finish safely. Failures block the entire submission; they never submit Chinese or a partial prompt. A local literal-repair request may happen once, but the main task is never retried. The original is persisted before the request. An empty editor is restored automatically; a newer draft is not overwritten. Explicit recovery is available inside `/translate`.
- Output failures leave the completed task and original answer intact. If some fragments succeed, the result combines them with failed fragments in their original positions, with an explicit partial-translation warning. If none succeed, only a failure is shown, not a duplicate original answer. A deadline may preserve already completed fragments; user cancellation discards the pending display entirely. The main task is not rerun.
- Fallback and partial-output warnings are stored as `pi-translate.notice` custom entries and excluded from model context. Warnings and failures each use one visible channel: the rendered entry, or a notification if the entry could not be saved—not both. Normal translated output still has no extra heading. Old output entries without diagnostic fields continue to render.
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

CI verifies Pi 0.99.2 and 1.0.0 on Node 22.19.0 and 24. Regression tests cover task boundaries, context isolation, translation fidelity checks, failures, cancellation, settings and native rendering. They use fake providers and temporary directories, not paid model calls or user credentials. Real-model quality still needs manual review.

The development API is pinned to Pi 0.99.2. Its published shrinkwrap contains a `brace-expansion` audit warning that ordinary npm updates and a root override do not resolve. `npm audit --omit=dev` reports no vulnerabilities; the extension does not bundle Pi or that dependency. Runtime host security also depends on the Pi version you install.
