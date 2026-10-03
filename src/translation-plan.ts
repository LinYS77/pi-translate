import { randomUUID } from "node:crypto";
import {
  inputRegions,
  type SourceRange,
  type InputRegion,
} from "./input-roles.ts";

export type Direction = "en" | "zh";
export interface Segment {
  id: string;
  start: number;
  end: number;
  text: string;
  local: "translate" | "keep";
  judgment: "local" | "jev";
  role: "instruction" | "prose" | "uncertain";
  context: {
    kind: "paragraph" | "quote" | "introduced";
    leadIn: string;
    followUp: string;
    paragraph: string;
  };
  literals: SourceRange[];
  group: number;
}

const han = /\p{Script=Han}/u;
const proseWords =
  /\b(?:do|not|no|never|warning|danger|error|failed|stop|retry|is|are|the|must|should|can|will|please|use|run|check|avoid|without|don't|cannot)\b/i;

/** Only local literals travel as placeholders. Whole immutable blocks never reach a model. */
export function protect(
  text: string,
  direction: Direction,
  literals: readonly SourceRange[] = [],
) {
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
          span[0] + replaceWithin(span.slice(1, -1), offset + 1) + span.at(-1)
        );
    }
    const token = `${prefix}${spans.size}_END`;
    spans.set(token, span);
    return token;
  };
  const replaceWithin = (value: string, base: number): string =>
    value.replace(pattern, (span: string, ...args: unknown[]) => {
      args[args.length - 2] = Number(args[args.length - 2]) + base;
      return replaceSpan(span, ...args);
    });
  let masked = "";
  let cursor = 0;
  for (const range of literals) {
    masked += replaceWithin(text.slice(cursor, range.start), cursor);
    const token = `${prefix}${spans.size}_END`;
    spans.set(token, text.slice(range.start, range.end));
    masked += token;
    cursor = range.end;
  }
  masked += replaceWithin(text.slice(cursor), cursor);
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
  literals: readonly SourceRange[] = [],
): "translate" | "keep" {
  const p = protect(text, direction, literals);
  if (!p.needsTranslation) return "keep";
  if (direction === "en" || !han.test(text)) return "translate";
  // Function words / warnings are evidence of English prose, not a brand dictionary.
  return proseWords.test(p.prose) ||
    /\b[a-z]+(?:[ \t]+[a-z]+){2,}\b/i.test(p.prose)
    ? "translate"
    : "keep";
}

/** Roles precede language selection; ranges always refer to the untouched UTF-16 source. */
export function createTranslationPlan(text: string, direction: Direction) {
  const regions = direction === "en" ? inputRegions(text) : [];
  const segments: Segment[] = [];
  let group = 0;
  // Mask for STRUCTURAL scanning only, keeping offsets/newlines. Preserved data cannot
  // open a fence/table or make an embedded instruction control the enclosing message.
  let scanText = "",
    cursor = 0;
  for (const region of regions) {
    scanText +=
      text.slice(cursor, region.start) +
      text
        .slice(region.start, region.end)
        .replace(/[^\r\n]/g, region.inline ? "x" : " ");
    cursor = region.end;
  }
  scanText += text.slice(cursor);
  const literalRanges = (start: number, end: number) =>
    regions
      .filter((r) => r.inline && r.start >= start && r.end <= end)
      .map((r) => ({ start: r.start - start, end: r.end - start }));
  const safeContext = (start: number, end: number) => {
    let result = "",
      cursor = start;
    for (const r of regions) {
      if (r.end <= start || r.start >= end) continue;
      result +=
        text.slice(cursor, Math.max(cursor, r.start)) + "[preserved material]";
      cursor = Math.min(end, r.end);
    }
    return result + text.slice(cursor, end);
  };
  const add = (
    start: number,
    end: number,
    groupId: number,
    paragraph: string,
    region?: InputRegion,
  ) => {
    const raw = text.slice(start, end);
    start += raw.length - raw.trimStart().length;
    end = start + raw.trim().length;
    if (start >= end) return;
    const value = text.slice(start, end);
    const literals = literalRanges(start, end);
    const protectedValue = protect(value, direction, literals);
    if (!protectedValue.needsTranslation) return;
    // Only clear source-language prose is pinned. Short labels and mixed-language
    // terms still need semantic judgment; protected literals are not evidence.
    const clearOutput =
      direction === "zh" &&
      (!han.test(value) || !han.test(protect(value, "en", literals).prose)) &&
      (proseWords.test(protectedValue.prose) ||
        (protectedValue.prose.match(/\b[A-Za-z]+\b/g)?.length ?? 0) >= 3);
    segments.push({
      id: "",
      start,
      end,
      text: value,
      literals,
      group: groupId,
      local: region ? "keep" : localDecision(value, direction, literals),
      judgment:
        region || (direction === "zh" && !clearOutput) ? "jev" : "local",
      role: region ? "uncertain" : direction === "en" ? "instruction" : "prose",
      context: {
        kind:
          region?.kind === "blockquote"
            ? "quote"
            : (region?.kind ?? "paragraph"),
        leadIn: region?.leadIn ?? "",
        followUp: region?.followUp ?? "",
        paragraph,
      },
    });
  };
  const prose = (start: number, end: number) => {
    if (start >= end) return;
    const value = text.slice(start, end);
    const groupId = group++;
    const paragraph = safeContext(start, end);
    const opaque =
      /(`+)[\s\S]*?\1|“[^”]*”|"(?:\\.|[^"\\])*"|\$[^$\n]+\$|\[[^\]]*\]\([^\n]*?\)/g;
    const covered: [number, number][] = [...value.matchAll(opaque)].map((m) => [
      m.index!,
      m.index! + m[0].length,
    ]);
    for (const r of literalRanges(start, end)) covered.push([r.start, r.end]);
    let begin = 0;
    for (const match of value.matchAll(/[。！？]+|[.!?]+(?=\s|$)|\s+/gu)) {
      const at = match.index!;
      if (covered.some(([a, b]) => at >= a && at < b)) continue;
      const boundary = at + match[0].length;
      const sentence = !/^\s/.test(match[0]);
      if (
        (sentence && han.test(value) && /[A-Za-z]/.test(value)) ||
        boundary - begin >= 1600
      ) {
        add(start + begin, start + boundary, groupId, paragraph);
        begin = boundary;
      }
    }
    add(start + begin, end, groupId, paragraph);
  };
  const paragraph = (start: number, end: number) => {
    let cursor = start;
    for (const r of regions) {
      if (r.inline || r.end <= cursor || r.start >= end) continue;
      prose(cursor, Math.min(end, r.start));
      cursor = Math.min(end, r.end);
    }
    prose(cursor, end);
  };
  let pending: { start: number; end: number } | undefined;
  const flush = () => {
    if (pending) paragraph(pending.start, pending.end);
    pending = undefined;
  };
  let fence: { char: string; length: number } | undefined;
  for (const line of scanText.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const start = line.index!;
    const raw = line[0].replace(/\r?\n$/, "");
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
    if (
      !raw.trim() ||
      (/^(?: {4}|\t)/.test(text.slice(start, start + raw.length)) &&
        !/^\s*(?:[-*+]|\d+[.)])\s/.test(raw)) ||
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
      const body = scanText.slice(bodyStart, start + raw.length);
      let cell = 0,
        ticks = "";
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
  for (const r of regions)
    if (r.role === "uncertain") add(r.start, r.end, group++, "", r);
  segments.sort((a, b) => a.start - b.start);
  segments.forEach((s, i) => {
    s.id = `s${i}`;
  });
  const resultFor = (ranges: Segment[]) => ({
    segments: ranges,
    assemble(replacements: ReadonlyMap<string, string>): string {
      let result = "",
        cursor = 0;
      for (const s of ranges) {
        if (s.start < cursor) throw new Error("翻译范围重叠，已拒绝组装");
        result +=
          text.slice(cursor, s.start) + (replacements.get(s.id) ?? s.text);
        cursor = s.end;
      }
      return result + text.slice(cursor);
    },
  });
  return {
    ...resultFor(segments),
    select(decisions: ReadonlyMap<string, "translate" | "keep">) {
      const units: Segment[] = [];
      for (const s of segments) {
        const decision =
          s.judgment === "local" ? s.local : (decisions.get(s.id) ?? s.local);
        if (decision !== "translate") continue;
        const previous = units.at(-1);
        if (
          previous &&
          previous.group === s.group &&
          previous.role === s.role &&
          /^\s*$/.test(text.slice(previous.end, s.start)) &&
          s.end - previous.start <= 1600
        ) {
          previous.end = s.end;
          previous.text = text.slice(previous.start, s.end);
          previous.literals = literalRanges(previous.start, s.end);
        } else units.push({ ...s });
      }
      return resultFor(units);
    },
  };
}
