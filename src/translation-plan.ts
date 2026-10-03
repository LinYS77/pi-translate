import { randomUUID } from "node:crypto";

export type Direction = "en" | "zh";
export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  local: "translate" | "keep";
}

const han = /\p{Script=Han}/u;
const proseWords =
  /\b(?:do|not|no|never|warning|danger|error|failed|stop|retry|is|are|the|must|should|can|will|please|use|run|check|avoid|without|don't|cannot)\b/i;

/** Only local literals travel as placeholders. Whole immutable blocks never reach a model. */
export function protect(text: string, direction: Direction) {
  const prefix = `PI_KEEP_${randomUUID().replaceAll("-", "")}_`;
  const spans = new Map<string, string>();
  const pattern = new RegExp(
    [
      "^ {0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?(?:^ {0,3}\\1[\\t ]*(?:\\n|$)|(?![\\s\\S]))",
      "^(?: {4}|\\t)[^\\n]*(?:\\n|$)",
      "(`+)[^`]*?\\2",
      "\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\n]+\\$|\\\\\\([\\s\\S]*?\\\\\\)|\\\\\\[[\\s\\S]*?\\\\\\]",
      "(?<=\\]\\()[^\\n]*?(?=\\))",
      "https?://[^\\s<>\"'）。，；]+",
      "(?<![A-Za-z0-9_])[+-]?\\d+(?:[.,]\\d+)*(?:%|\\b)",
      "(?:[A-Za-z]:\\\\|(?:~|\\.\\.?)?/)[\\w./\\\\@+-]+",
      "\\b[\\w-]+(?:[./\\\\][\\w-]+)+\\b",
      "\\b[A-Za-z]+(?:_[A-Za-z0-9]+)+\\b|\\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\\b|\\b(?!(?:STOP|WARNING|DANGER|ERROR|FAILED|NEVER|DO|NOT|NO)\\b)[A-Z][A-Z0-9_]+\\b",
      "“[^”\\n]*”|「[^」\\n]*」|『[^』\\n]*』|\"(?:\\\\.|[^\"\\\\\\n])*\"|(?<![A-Za-z])'[^'\\n]+'(?![A-Za-z])",
      ...(direction === "zh"
        ? ["[\\p{Script=Han}]+"]
        : ["\\b[A-Za-z][A-Za-z0-9]*(?:[ \\t]+[A-Za-z][A-Za-z0-9]*)*\\b"]),
    ].join("|"),
    "gmu",
  );
  const replaceSpan = (span: string, ...args: unknown[]): string => {
    const offset = args.at(-2) as number;
    // Quotes around prose are not automatically literals. Labels and ambiguous short quotes are.
    if (/^[“「『"']/.test(span)) {
      const nearby = text.slice(Math.max(0, offset - 60), offset);
      const explicit =
        /(?:label|button|literal|named|set .* to|keep|replace|字符串|标签|文字|改成|原样|保留)/i.test(
          nearby,
        );
      const prose =
        /\s/.test(span.slice(1, -1)) || /[。！？.!?]/.test(span.slice(1, -1));
      if (!explicit && prose)
        return (
          span[0] +
          span.slice(1, -1).replace(pattern, replaceSpan) +
          span.at(-1)
        );
    }
    const token = `${prefix}${spans.size}_END`;
    spans.set(token, span);
    return token;
  };
  const masked = text.replace(pattern, replaceSpan);
  const tokenPattern = new RegExp(`${prefix}\\d+_END`, "g");
  const prose = masked.replace(tokenPattern, "");
  return {
    masked,
    prose,
    needsTranslation:
      direction === "en" ? han.test(prose) : /[A-Za-z]/.test(prose),
    restore(translated: string): string {
      if (/PI_KEEP_/i.test(translated.replace(tokenPattern, "")))
        throw new Error("译文含有未知或损坏的占位符；已拒绝使用");
      const remaining = new Set(spans.keys());
      const restored = translated.replace(tokenPattern, (token) => {
        if (!remaining.delete(token))
          throw new Error("译文重复或破坏了受保护内容；已拒绝使用");
        return spans.get(token)!;
      });
      if (remaining.size) throw new Error("译文遗漏了受保护内容；已拒绝使用");
      if (restored.includes(prefix))
        throw new Error("译文含有损坏的占位符；已拒绝使用");
      return restored;
    },
  };
}

function localDecision(
  text: string,
  direction: Direction,
): "translate" | "keep" {
  const p = protect(text, direction);
  if (!p.needsTranslation) return "keep";
  if (direction === "en" || !han.test(text)) return "translate";
  // Function words / warnings are evidence of English prose, not a brand dictionary.
  return proseWords.test(p.prose) ||
    /\b[a-z]+(?:[ \t]+[a-z]+){2,}\b/i.test(p.prose)
    ? "translate"
    : "keep";
}

// A narrow, explicit INPUT-only delimiter convention, not instructions executed by a model.
// Unquoted prose and directives inside code/quoted examples remain ordinary translation data.
const keepFollowing =
  /^[ \t]{0,3}(?:(?:下面|以下)(?:这段|的?内容|的?文本|这部分)(?:请)?不要翻译|(?:请)?不要翻译(?:下面|以下)(?:这段|的?内容|的?文本|这部分)?|do not translate the following(?: (?:text|passage|block))?)[ \t]*[:：]/i;
const quotePairs: Record<string, string> = {
  "“": "”",
  "「": "」",
  "『": "』",
  '"': '"',
};

/** Find an explicit quote's matching end without counting delimiters inside code. */
function quoteEnd(text: string, start: number): number | undefined {
  const open = text[start];
  const close = quotePairs[open];
  if (!close) return;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "`" || (char === "~" && text.slice(i).startsWith("~~~"))) {
      let length = 1;
      while (text[i + length] === char) length++;
      const fenced =
        length >= 3 &&
        /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
      const closing = fenced
        ? new RegExp(`^[ \\t]*${char}{${length},}[ \\t]*\\r?$`, "gm")
        : new RegExp(`(?<!${char})${char}{${length}}(?!${char})`, "g");
      closing.lastIndex = i + length;
      const match = closing.exec(text);
      if (!match) return;
      i = match.index + match[0].length - 1;
      continue;
    }
    if (char === close) {
      if (--depth === 0) return i + 1;
    } else if (char === open) depth++;
  }
}

/** UTF-16 source ranges; immutable syntax and whitespace are copied, never reserialized. */
export function createTranslationPlan(text: string, direction: Direction) {
  const segments: Segment[] = [];
  const add = (start: number, end: number) => {
    const raw = text.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    start += leading;
    end = start + raw.trim().length;
    if (start >= end) return;
    const value = text.slice(start, end);
    if (!protect(value, direction).needsTranslation) return;
    segments.push({
      id: `s${segments.length}`,
      start,
      end,
      text: value,
      local: localDecision(value, direction),
    });
  };
  // Keep sentence context; only split at sentence boundaries or bounded whitespace.
  const paragraph = (start: number, end: number) => {
    const value = text.slice(start, end);
    // Sentence boundaries inside inline code/quotes/links must not break protected syntax.
    const opaque =
      /(`+)[\s\S]*?\1|“[^”]*”|"(?:\\.|[^"\\])*"|\$[^$\n]+\$|\[[^\]]*\]\([^\n]*?\)/g;
    const covered: [number, number][] = [...value.matchAll(opaque)].map((m) => [
      m.index!,
      m.index! + m[0].length,
    ]);
    let begin = 0;
    for (const match of value.matchAll(/[。！？]+|[.!?]+(?=\s|$)|\s+/gu)) {
      const at = match.index!;
      if (covered.some(([a, b]) => at >= a && at < b)) continue;
      const boundary = at + match[0].length;
      const sentence = !/^\s/.test(match[0]);
      // Whole single-language paragraphs stay together. Mixed sentences can remain local.
      if (
        (sentence && han.test(value) && /[A-Za-z]/.test(value)) ||
        boundary - begin >= 1600
      ) {
        add(start + begin, start + boundary);
        begin = boundary;
      }
    }
    add(start + begin, end);
  };
  let pending: { start: number; end: number } | undefined;
  const flush = () => {
    if (pending) paragraph(pending.start, pending.end);
    pending = undefined;
  };
  let fence: { char: string; length: number } | undefined;
  let keepUntil = 0;
  let quotedDataUntil = 0;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    let start = line.index!;
    let raw = line[0].replace(/\r?\n$/, "");
    const lineEnd = start + raw.length;
    if (start < keepUntil) {
      start = keepUntil;
      if (start >= lineEnd) continue;
      raw = text.slice(start, lineEnd);
    }
    const container = raw.replace(/^\s*(?:>\s*)+/, "");
    const marker = container.match(/^\s*(?:[-*+]\s+)?(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      flush();
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    if (direction === "en" && start >= quotedDataUntil) {
      const directive = raw.match(keepFollowing);
      if (directive) {
        const after = start + directive[0].length;
        const following = text.slice(after).search(/\S/u);
        const quoteStart = after + following;
        if (following >= 0 && quotePairs[text[quoteStart]]) {
          const end = quoteEnd(text, quoteStart);
          if (end === undefined)
            throw new Error(
              "不翻译的引用块未闭合；请补齐引号或使用代码围栏，原文未提交",
            );
          flush();
          paragraph(start, after); // Translate the instruction, never the delimited material.
          keepUntil = end;
          if (end >= lineEnd) continue;
          start = end;
          raw = text.slice(start, lineEnd);
        }
      }
      const quoteStart = start + raw.length - raw.trimStart().length;
      if (quotePairs[text[quoteStart]])
        quotedDataUntil = quoteEnd(text, quoteStart) ?? text.length;
    }
    if (
      !raw.trim() ||
      (/^(?: {4}|\t)/.test(raw) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(raw)) ||
      /^\s*(?:[-*_]\s*){3,}$/.test(raw) ||
      /^\s*\[[^\]]+\]:/.test(raw) ||
      /^\s*\|?[\s:|-]+\|?\s*$/.test(raw)
    ) {
      flush();
      continue;
    }
    const prefix = raw.match(
      /^(?:[ \t]*>[ \t]*)*(?:[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?))?/u,
    )![0];
    if (prefix || /(?<!\\)\|/.test(raw)) {
      flush();
      const bodyStart = start + prefix.length;
      const body = text.slice(bodyStart, start + raw.length);
      // Split table cells only outside inline code and escaped delimiters.
      let cell = 0;
      let ticks = "";
      for (const m of body.matchAll(
        /\$[^$\n]+\$|\[[^\]]*\]\([^\n]*?\)|`+|\\.|\|/g,
      )) {
        if (m[0].startsWith("`")) {
          if (!ticks) ticks = m[0];
          else if (ticks === m[0]) ticks = "";
        } else if (m[0] === "|" && !ticks) {
          paragraph(bodyStart + cell, bodyStart + m.index!);
          cell = m.index! + 1;
        }
      }
      paragraph(bodyStart + cell, start + raw.length);
    } else if (pending) pending.end = start + raw.length;
    else pending = { start, end: start + raw.length };
  }
  flush();
  return {
    segments,
    assemble(replacements: ReadonlyMap<string, string>): string {
      let result = "";
      let cursor = 0;
      for (const segment of segments) {
        result +=
          text.slice(cursor, segment.start) +
          (replacements.get(segment.id) ?? segment.text);
        cursor = segment.end;
      }
      return result + text.slice(cursor);
    },
  };
}
