# Configuration and behavior

## Settings

`/translate` is the only extension command and accepts no arguments. `Alt+T` is the quick switch; `Ctrl+Alt+T` restores the latest available original input. Configuration stays in a single Pi-managed overlay (`ctx.ui.custom`); returning from search or changing a value does not replace the input editor or reopen the panel. It does not integrate with Pi's `/settings`.

The menu stays in one overlay, including model search and the custom timeout editor. It shows all available settings when the panel has room; shorter windows scroll around the selected item without resetting selection on resize:

| Setting | Behavior |
| --- | --- |
| Translation model | Search Pi's available chat models by name, provider or ID. Enter saves the selection; Esc returns without selecting. |
| Current switch | Temporary runtime on/off. Off cancels unfinished translations immediately; on enables the current unfinished answer and future submissions. Same effect as Alt+T. |
| New-session default | Saved on/off for new sessions, restarts and reloads; does not change the current switch. |
| Translation timeout | 1, 5, 10, 20, 30 or 60 minutes, or custom seconds (0.1–3600, up to three decimal places). Existing values are displayed without rounding. |
| Decision route | Local rules (default), or Jev classification. |
| Classifier model | Visible under Jev; independently choose an authenticated Jev classifier, not a chat model. The selection is kept when switching back to local rules. |

Changes are saved immediately, not on close. A failed save leaves the old value intact and shows an inline error. **Restore input** appears only when extension-owned recovery data is available. It fills an empty editor, closes the panel and never submits. `Ctrl+Alt+T` uses the same recovery logic without opening the panel, even when translation is off. Missing recovery data or an occupied editor produces a short notice; even whitespace-only drafts are preserved. The shortcut does not change the translation switch or submit a task. If a terminal or OS intercepts the key, use the menu instead.

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

`decisionMode` accepts `local` or `jev`. Old configurations default to `local` without being rewritten on read. Jev additionally uses the optional pair `classifierProvider` / `classifierModel` (for example `typesafe` / `jev-latest`). Both must be supplied together. Missing or unavailable classifiers silently fall back to local rules; this does not change the saved decision route. No classifier key, endpoint or SDK is configured here; use Pi's existing providers.

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

The current switch is the only on/off decision. Input checks it at submission; the current answer checks it at `agent_settled`. Turning off cancels unfinished input/output translation immediately. Turning on before the current answer finishes enables its final translation, including when the task started with translation off. Turning on after settlement does not replay an answer or restart a canceled translation. Native commands and extension-generated tasks remain excluded.

Input translation still fixes its model, route and timeout at submission. Output keeps the originating task's model/route/timeout settings; the captured enabled flag does not override the live switch. Changing the saved new-session default does not toggle the current session.

Retries, compaction continuations, steering and follow-up queues can all be part of one Pi activity. Each new input uses its submission snapshot, while only the last eligible answer at settlement is translated. A message ending is not a task ending. Aborts, errors, length stops, tool calls, tool results and empty answers do not fall back to previous text. A raw Esc key alone does not mark a main task as aborted: Pi may have used it to close a picker. Esc cancels active translation jobs; main-task eligibility follows Pi's outcome and abort signal.

The status is `译 on` / `译 off`, plus one animated braille character while translating. There is no second task-specific on/off indicator. Final-answer translation runs as a background display job; it does not hold Pi's settlement event or delay the next prompt. Starting new input or a new task cancels the older pending display job so its result cannot appear under the new answer. The original answer remains visible. The extension disposes animation and its requests on session replacement, tree navigation or shutdown; late results and cleanup cannot overwrite a newer job.

## Data isolation and fidelity

A translation request contains only fixed rules and a selected fragment of the current text, with remaining inline literals masked by random placeholders. Whole code blocks and identified task-material blocks stay local. Small inline task objects use placeholders so their surrounding instruction can be translated as one sentence. A classifier request contains the direction, operation policy, readable ambiguous candidates, their role/structure, lead-in, following clause and relevant paragraph from the current text. Known preserved material is omitted or redacted from that context; ambiguous material must be readable to Jev to judge its role. Neither stage reads history or external context. Neither request contains the main system prompt, tool definitions/results, attachments or project files. References such as “the second option above” are translated without resolving them.

The main model receives one transformed input. Original assistant answers remain unchanged. Input backups, failures and translated output are custom session entries, not messages; `buildSessionContext()` excludes them. The synthetic assistant object used by the renderer is only a visual component, never a conversation message.

The source-position scanner keeps fenced/indented code and Markdown structure local rather than reserializing the document. It selects paragraphs, mixed-language sentence fragments, list items and table cells. Replacements preserve surrounding whitespace, CRLF, separators and unchanged source ranges. Inline code, paths, URLs, identifiers, numbers, formulas and recognizable literal labels remain protected. Missing, duplicate, unknown or damaged placeholders get at most one recovery attempt for that fragment, then fail closed; nothing is guessed back into place. Incomplete provider replies are not retried as literal-repair attempts.

### Input: describe the task, preserve its objects

The main model receives **English task instructions plus original-language material**, not a guarantee that every Chinese character disappears. The extension must not perform the main model's task first.

| Current input | Treatment |
| --- | --- |
| Ask to investigate, with constraints | Translate the instruction and constraints. |
| Ask to analyze an error, polish a passage, compare versions, or translate quoted/source text | Translate the request; preserve its original task object for the main model. |
| Code, blockquoted material, explicit preservation scope, recognizable literal label | Preserve; Jev cannot override it. |
| Quote or introduced passage whose role is unclear | Keep by default; Jev may authorize translation only when confident that it is ordinary prose rather than a task object. |

Source positions, quotes, fences, blockquotes and paragraph structure establish ranges. Local role evidence includes text-processing requests, artifact labels (such as 原文 / 报错 / Raw log), observations of returned errors, and explicit preservation instructions—not only one fixed “do not translate” phrase. Unknown lead-ins become role questions rather than automatically treating the following material as task instructions. Quoted examples cannot impose a preservation policy on surrounding text.

A plain introduced paragraph is preserved. Subsequent unquoted continuation paragraphs are uncertain and conservatively retained until a clear new request; quotes or fences are preferable for long multi-paragraph material. A following reference such as “analyze the text above” can also identify a preceding quote as a task object within the current message. Historical references are still translated literally, never resolved from conversation history. A terminal unclosed quote can use the end of the input as its extent; a dangling quote spanning multiple paragraphs with unclear scope blocks submission with a request to clarify the range rather than swallowing further instructions.

Known input task instructions are not put to a classifier vote. Only ambiguous input roles are sent to Jev. Its Choice question distinguishes ordinary prose, task material, and uncertainty using the framing clauses and structure; missing, invalid or low-confidence answers silently preserve the candidate as original material. This is distinct from output language judgment.

### Output: translate explanatory prose for reading

Output does not obey embedded “do not translate” instructions as extension controls. Local language rules distinguish embedded English terms from prose using the surrounding paragraph, word forms and function/warning words. English-only input and Chinese-only output pass through without a model call. Already-Chinese answers containing Docker/PyTorch or short technical phrases normally stay unchanged; short English warnings still need translation. In Jev mode, clear English prose is decided locally and cannot be voted away by the classifier. After protecting literals, English-only candidates with function/warning words or at least three words take this local route. Chinese inside protected code or labels does not create a language ambiguity. Short labels and mixed-language candidates still carry their paragraph context to a translate / keep / uncertain Choice question. A service failure stops further classification batches; uncertain output judgments silently use local language rules.

Judgment units are not necessarily request units: adjacent selected spans of the same role and paragraph are merged, up to the fragment-size limit. They never merge across preserved material, target-language text, table cells or unrelated paragraphs. This retains sentence context and reduces request amplification without asking a model to reconstruct arbitrary batch IDs.

Jev is not a translator. TypeSafe documents lower accuracy on CJK than English; local rules remain the default. Choice probability must be at least 0.8 and confidence at least 0.5, with a valid normalized distribution. These are conservative gates, not calibrated correctness probabilities or a claim of general superiority. Real role-classification checks still produced low-confidence answers on Chinese examples; the conservative material-preservation policy is deliberate, not evidence that Jev understood every case.

Classification batches are packed against the complete serialized state and questions plus the answer allowance. If adding a candidate exceeds model capacity, the current batch is submitted first; only a candidate that cannot fit by itself falls back for capacity. Context is not silently truncated. Optional internal evaluation diagnostics distinguish missing/invalid answers, malformed distributions, low probability, low confidence, explicit uncertainty, capacity and service failures. They emit reason/count pairs only, contain no source text or raw provider errors, and are not enabled or persisted by the normal translation UI. Observer failures cannot affect routing.

Internal limits bound request amplification: at most 8 questions / 12,000 UTF-8 bytes of candidate text per classifier batch, an 8-second classifier request cap, sequential fragment requests, at most **2,048 requests** and a **4,194,304-token operation budget**, shared by classification, translation and repair. These are per-operation safeguards, not prepaid usage or the model's context window. Both ceilings are 32 times the original v0.2.0 limits; longer operations can cost more and remain subject to the saved total timeout. Each in-flight request reserves input bytes plus its output allowance. On completion, the reservation is settled using reported total usage; when usage is absent or zero, input and actual response bytes provide a conservative estimate. Unused `maxTokens` allowance is not repeatedly charged as consumption. Requests with unknown consumption after an exception/timeout retain their reservation. Over-capacity fragments are never silently truncated. Budget exhaustion identifies the request-count or cumulative-token ceiling and follows the same input-blocking / partial-output policy as other failures. Usage sums all completed classifier, translation and repair responses; reported cost depends on Pi's catalog and may not include a price for direct TypeSafe calls.

This is not a complete natural-language, programming-language or Markdown parser. Role evidence remains heuristic and some informal/unstructured task descriptions can be misclassified; the default favors preserving possible source material rather than rewriting it. Use backticks or fences for commands/exact strings and clear quotation for long source passages. Quoted narrative may be translated when its role permits it; labels and task objects stay literal. Deeply nested indentation, unusual Markdown/HTML and ambiguous terms remain limitations. Checks cannot prove semantic fidelity; review negations, warnings and uncertainties with the model you actually choose.

## Recovery and display

- Input requires every selected fragment to finish safely. Failures block the entire submission; they never submit unprocessed input or an incomplete translation. A local literal-repair request may happen once, but the main task is never retried. The original is persisted before the request. An empty editor is restored automatically; a newer draft is not overwritten. Explicit recovery is available with `Ctrl+Alt+T` or inside `/translate`. Canceling input translation with Esc or Alt+T blocks submission and restores the original to an empty editor; a newer draft is preserved. Cancellation produces a short notice rather than a translation-failure entry. Re-enabling translation does not silently resubmit the canceled input.
- Output failures leave the completed task and original answer intact. If some fragments succeed, the result combines them with failed fragments in their original positions, with an explicit partial-translation warning. If none succeed, only a failure is shown, not a duplicate original answer. A deadline may preserve already completed fragments; user cancellation discards the pending display entirely. The main task is not rerun.
- Jev fallback creates no notification or session notice; confidence thresholds and local preservation rules stay unchanged. Actual partial-output warnings are stored as `pi-translate.notice` custom entries and excluded from model context. Warnings and failures each use one visible channel: the rendered entry, or a notification if the entry could not be saved—not both. Normal translated output still has no extra heading. Old output entries without diagnostic fields continue to render.
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
