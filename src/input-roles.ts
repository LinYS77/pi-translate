export interface SourceRange {
  start: number;
  end: number;
}
export interface InputRegion extends SourceRange {
  role: "material" | "uncertain";
  kind: "quote" | "introduced" | "blockquote";
  leadIn: string;
  followUp: string;
  /** Small inline task objects stay in their sentence as opaque literals. */
  inline: boolean;
}

const pairs: Record<string, string> = {
  "“": "”",
  "「": "」",
  "『": "』",
  '"': '"',
};
const action =
  /分析|检查|解释|诊断|润色|改写|翻译|总结|摘要|比较|对比|校对|审阅|修正|修改|analy[sz]e|inspect|diagnose|debug|explain|polish|rewrite|translate|summari[sz]e|compare|proofread|review/i;
const object =
  /原文|译文|报错|错误|日志|文本|文字|这段|内容|资料|记录|输出|段落|句子|文章|邮件|消息|代码|提示词|error|log|text|passage|paragraph|sentence|article|message|output|transcript|prompt|code/i;
const following = /下面|以下|下列|后面|如下|\b(?:following|below)\b/i;
const observation =
  /遇到|收到|出现|提示|显示|输出|\b(?:returned|received|encountered|reported|printed|shows)\b/i;
const preservation =
  /(?:不要|无需|勿|不必).{0,6}翻译|原样保留|保留原文|维持原文|(?:do not|don't) translate|keep (?:this|the following|it|them) unchanged|verbatim/i;
const literalLabel =
  /按钮|标签|字符串|变量名|字面|label|button|string literal|identifier/i;
const requestStart =
  /^(?:请|然后请|最后请|另外请|接下来请|再请|please\b|next,? please\b|finally,? please\b)/i;

const taskHeading =
  /任务|要求|约束|指令|操作步骤|requirements|constraints|instructions|task/i;
const materialLabel =
  /^(?:(?:原始|实际|完整)?(?:原文|译文|报错|错误|日志|文本|代码)(?:信息|输出|内容)?|(?:(?:raw|original|translated|error)\s+)?(?:text|log|output|message|code|transcript|error))\s*[:：]$/i;

function introducesMaterial(lead: string) {
  if (taskHeading.test(lead) && !action.test(lead) && !preservation.test(lead))
    return false;
  return (
    preservation.test(lead) ||
    materialLabel.test(lead) ||
    (observation.test(lead) && object.test(lead)) ||
    (action.test(lead) && (object.test(lead) || following.test(lead))) ||
    (following.test(lead) && object.test(lead))
  );
}

/** Paired quotes, with nested labels and code ignored while looking for the close. */
function quotedEnd(text: string, start: number): number | undefined {
  const open = text[start],
    close = pairs[open];
  if (!close) return;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "`" || (char === "~" && text.startsWith("~~~", i))) {
      let length = 1;
      while (text[i + length] === char) length++;
      const fenced =
        length >= 3 &&
        /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
      const pattern = fenced
        ? new RegExp(`^[ \\t]*${char}{${length},}[ \\t]*\\r?$`, "gm")
        : new RegExp(`(?<!${char})${char}{${length}}(?!${char})`, "g");
      pattern.lastIndex = i + length;
      const match = pattern.exec(text);
      if (!match) return;
      i = match.index + match[0].length - 1;
      continue;
    }
    if (char === close) {
      if (--depth === 0) return i + 1;
    } else if (char === open) depth++;
  }
}

/** Labels and their following quote form one material block, including nested labels.
 * This is structural grouping only: text inside the material never controls the extension. */
function materialQuoteStart(text: string, start: number): number | undefined {
  let cursor = start;
  while (cursor < text.length) {
    const offset = text.slice(cursor).search(/\S/u);
    if (offset < 0) return;
    cursor += offset;
    if (pairs[text[cursor]]) return cursor;
    if (
      text[cursor] === ">" ||
      text[cursor] === "`" ||
      text.startsWith("~~~", cursor)
    )
      return;
    const newline = text.indexOf("\n", cursor);
    const line = text.slice(cursor, newline < 0 ? text.length : newline);
    const colon = line.search(/[:：]/);
    if (colon <= 0 || /[。！？.!?]/.test(line.slice(0, colon))) return;
    cursor += colon + 1;
  }
}

/** Quoted examples and inline code are data, not evidence of the enclosing task's intent. */
function visibleLead(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (pairs[text[i]]) {
      const end = quotedEnd(text, i);
      result += "[quoted material]";
      if (end === undefined) break;
      i = end - 1;
    } else if (text[i] === "`") {
      const run = text.slice(i).match(/^`+/)![0];
      const end = text.indexOf(run, i + run.length);
      result += "[inline code]";
      if (end < 0) break;
      i = end + run.length - 1;
    } else result += text[i];
  }
  return result;
}

/**
 * Structure establishes scope; a small role vocabulary supplies local evidence, not
 * a claim of arbitrary language understanding. Known task objects stay local. Other
 * quotes / continuation paragraphs are explicitly uncertain, with their lead-in.
 */
export function inputRegions(text: string): InputRegion[] {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((m) => m[0])
    .map((m) => ({
      start: m.index!,
      end: m.index! + m[0].replace(/\r?\n$/, "").length,
      body: m[0].replace(/\r?\n$/, ""),
    }));
  const regions: InputRegion[] = [];
  let coveredUntil = 0;
  let fence: { char: string; length: number } | undefined;
  let leadIn = "";
  let expectMaterial = false;
  let expectedRole: InputRegion["role"] = "material";
  let continuation = false;
  let previous = "";
  const paragraphEnd = (lineIndex: number) => {
    let end = lines[lineIndex].end;
    for (let i = lineIndex + 1; i < lines.length; i++) {
      if (
        !lines[i].body.trim() ||
        /^\s*(?:#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i].body)
      )
        break;
      end = lines[i].end;
    }
    return end;
  };
  const add = (
    start: number,
    end: number,
    role: InputRegion["role"],
    kind: InputRegion["kind"],
    lead: string,
    inline = false,
    followUp = "",
  ) => {
    regions.push({ start, end, role, kind, leadIn: lead, followUp, inline });
    coveredUntil = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.end <= coveredUntil) continue;
    let start = Math.max(line.start, coveredUntil);
    let body = text.slice(start, line.end);
    const marker = body.match(/^\s*(?:>\s*)*(?:[-*+]\s+)?(`{3,}|~{3,})(.*)$/);
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
      fence = { char: marker[1][0], length: marker[1].length };
      expectMaterial = false;
      continuation = false;
      continue;
    }
    if (!body.trim()) continue;
    if (/^(?: {4}|\t)/.test(body) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(body))
      continue;
    if (continuation && requestStart.test(body.trimStart())) {
      // Only an explicit new request ends an unquoted material continuation.
      leadIn = "";
      continuation = false;
    }
    const colon = body.search(/[:：]/);
    const lead = visibleLead(
      colon >= 0 ? body.slice(0, colon + 1).trim() : body.trim(),
    );
    const knownMaterial = introducesMaterial(lead);
    const ambiguousLead =
      colon >= 0 &&
      !taskHeading.test(lead) &&
      !/\[(?:quoted material|inline code)\]/.test(lead) &&
      (!requestStart.test(lead) || action.test(lead));
    if (
      !expectMaterial &&
      ((knownMaterial && (colon >= 0 || following.test(lead))) || ambiguousLead)
    ) {
      leadIn = lead;
      expectMaterial = true;
      expectedRole = knownMaterial ? "material" : "uncertain";
      continuation = false;
      if (colon < 0) {
        previous = lead;
        continue;
      }
      start += colon + 1;
      body = text.slice(start, line.end);
      if (!body.trim()) {
        previous = lead;
        continue;
      }
    }
    start += body.length - body.trimStart().length;
    body = text.slice(start, line.end);
    if (expectMaterial) {
      const quoteStart = materialQuoteStart(text, start);
      if (quoteStart !== undefined) {
        const end = quotedEnd(text, quoteStart);
        if (end === undefined) {
          // A single terminal paragraph has an unambiguous EOF extent. Multiple
          // paragraphs may hide further instructions; do not silently swallow them.
          if (/\n[ \t]*\r?\n/.test(text.slice(quoteStart)))
            throw new Error(
              "无法确定原始材料的结束位置；请用引用块或代码围栏明确范围，原文未提交",
            );
          add(start, text.length, expectedRole, "quote", leadIn);
        } else add(start, end, expectedRole, "quote", leadIn);
        expectMaterial = false;
        continuation = false;
        // Process any instructions after the closing quote on this same line.
        if (coveredUntil < line.end) {
          i--;
        }
      } else if (body.startsWith(">")) {
        let end = line.end;
        while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1].body))
          end = lines[++i].end;
        add(start, end, "material", "blockquote", leadIn);
        expectMaterial = false;
        continuation = false;
      } else {
        add(start, paragraphEnd(i), expectedRole, "introduced", leadIn);
        expectMaterial = false;
        continuation = true;
      }
      previous = leadIn;
      continue;
    }
    if (continuation) {
      add(start, paragraphEnd(i), "uncertain", "introduced", leadIn);
      continue;
    }
    if (body.startsWith(">")) {
      let end = line.end;
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1].body))
        end = lines[++i].end;
      add(start, end, "material", "blockquote", previous);
      continue;
    }
    // Quoted task objects may be inline: keep the surrounding task as one sentence.
    for (let at = start; at < line.end; at++) {
      if (text[at] === "\\") {
        at++;
        continue;
      }
      if (text[at] === "`") {
        const run = text.slice(at).match(/^`+/)![0];
        const close = text.indexOf(run, at + run.length);
        if (close < 0) break;
        at = close + run.length - 1;
        continue;
      }
      if (!pairs[text[at]]) continue;
      const end = quotedEnd(text, at);
      if (end === undefined) continue;
      const prefix = visibleLead(text.slice(start, at).trim());
      const suffix = visibleLead(text.slice(end, line.end).trim());
      const known =
        action.test(prefix) ||
        action.test(suffix) ||
        preservation.test(prefix) ||
        literalLabel.test(prefix);
      const inline =
        end <= line.end &&
        (prefix.length > 0 || text.slice(end, line.end).trim().length > 0);
      add(
        at,
        end,
        known ? "material" : "uncertain",
        "quote",
        prefix || previous,
        inline && known,
        suffix,
      );
      at = end - 1;
    }
    previous = visibleLead(body.trim());
  }
  for (const region of regions) {
    if (region.role !== "uncertain" || region.kind !== "quote") continue;
    if (!region.followUp) {
      const offset = text.slice(region.end).search(/\S/u);
      if (offset >= 0) {
        const start = region.end + offset;
        const next = lines.find(
          (line) => start >= line.start && start < line.end,
        );
        if (
          next &&
          !regions.some((r) => r.start <= start && start < r.end) &&
          !/^(?: {4}|\t)/.test(next.body) &&
          !/^\s*(?:`{3,}|~{3,}|>)/.test(next.body)
        ) {
          region.followUp = visibleLead(text.slice(start, next.end));
        }
      }
    }
    if (
      action.test(region.followUp) &&
      /上面|上述|前面|这段|该段|\b(?:above|preceding|this (?:quote|text|passage))\b/i.test(
        region.followUp,
      )
    ) {
      region.role = "material";
    }
  }
  return regions;
}
