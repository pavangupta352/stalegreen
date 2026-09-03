/**
 * A small POSIX shell reader. It splits a command line into segments on the
 * control operators `&&`, `||`, `;`, `|`, `&` and newline outside quotes and
 * substitutions, tokenises each segment into words and redirects, and reports
 * the constructs the rewrite refuses to touch (heredocs, process substitution,
 * grouping, anything it could not read with confidence).
 */

export type Operator = "start" | "&&" | "||" | ";" | "|" | "&" | "newline";

export interface Redirect {
  fd: number | null;
  op: string;
  target: string;
}

export interface Segment {
  /** Raw text of the segment, trimmed, including any heredoc body. */
  text: string;
  /** The command part only: the raw text without heredoc bodies. */
  head: string;
  start: number;
  end: number;
  /** Operator that precedes this segment. */
  op: Operator;
  /** Unquoted words, redirects removed, leading `!` removed. */
  words: string[];
  /** Leading VAR=value assignments removed from `words`. */
  env: string[];
  redirects: Redirect[];
  /** True when the segment is followed by a single `&`. */
  background: boolean;
  negated: boolean;
}

export interface ParsedCommand {
  source: string;
  segments: Segment[];
  heredoc: boolean;
  processSubstitution: boolean;
  grouping: boolean;
  confident: boolean;
  reasons: string[];
}

const WORD_BREAK = new Set([" ", "\t", "\n", "\r"]);

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && WORD_BREAK.has(ch);
}

/** Index just after the single-quoted string starting at `i` (which is a quote). */
function skipSingle(src: string, i: number): number {
  const j = src.indexOf("'", i + 1);
  return j < 0 ? -1 : j + 1;
}

function skipBacktick(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return j + 1;
    j++;
  }
  return -1;
}

/** Index just after `$( ... )` or `( ... )` starting at the opening paren index. */
function skipParens(src: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      j = skipSingle(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === '"') {
      j = skipDouble(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === "`") {
      j = skipBacktick(src, j);
      if (j < 0) return -1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

function skipDouble(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === "$" && src[j + 1] === "(") {
      j = skipParens(src, j + 1);
      if (j < 0) return -1;
      continue;
    }
    if (c === "`") {
      j = skipBacktick(src, j);
      if (j < 0) return -1;
      continue;
    }
    j++;
  }
  return -1;
}

/** Reads a heredoc delimiter word starting at `i` (after `<<` or `<<-`). */
function readDelimiter(src: string, i: number): { delimiter: string; next: number } | null {
  let j = i;
  while (isSpace(src[j]) && src[j] !== "\n") j++;
  let out = "";
  while (j < src.length && !isSpace(src[j]) && src[j] !== ";" && src[j] !== "|" && src[j] !== "&" && src[j] !== ")") {
    const c = src[j];
    if (c === "'") {
      const k = skipSingle(src, j);
      if (k < 0) return null;
      out += src.slice(j + 1, k - 1);
      j = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(src, j);
      if (k < 0) return null;
      out += src.slice(j + 1, k - 1);
      j = k;
      continue;
    }
    if (c === "\\") {
      out += src[j + 1] ?? "";
      j += 2;
      continue;
    }
    out += c;
    j++;
  }
  if (!out) return null;
  return { delimiter: out, next: j };
}

/** Consumes heredoc bodies that start at `i` (just after a newline). Returns the index after the last terminator line. */
function skipHeredocBodies(src: string, i: number, pending: { delimiter: string; stripTabs: boolean }[]): number {
  let j = i;
  for (const h of pending) {
    for (;;) {
      if (j >= src.length) return src.length;
      let eol = src.indexOf("\n", j);
      if (eol < 0) eol = src.length;
      let line = src.slice(j, eol);
      if (h.stripTabs) line = line.replace(/^\t+/, "");
      j = eol + 1;
      if (line.trimEnd() === h.delimiter) break;
    }
  }
  return Math.min(j, src.length);
}

/** Tokenises the command part of a segment into words and redirects. */
function tokenize(head: string): { words: string[]; redirects: Redirect[]; ok: boolean } {
  const words: string[] = [];
  const redirects: Redirect[] = [];
  let ok = true;
  let word = "";
  let hasWord = false;
  let i = 0;
  const n = head.length;

  const flush = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };

  const readTarget = (): string => {
    while (i < n && isSpace(head[i])) i++;
    let out = "";
    while (i < n && !isSpace(head[i]) && head[i] !== ">" && head[i] !== "<") {
      const c = head[i] as string;
      if (c === "'") {
        const k = skipSingle(head, i);
        if (k < 0) {
          ok = false;
          return out + head.slice(i + 1);
        }
        out += head.slice(i + 1, k - 1);
        i = k;
        continue;
      }
      if (c === '"') {
        const k = skipDouble(head, i);
        if (k < 0) {
          ok = false;
          return out + head.slice(i + 1);
        }
        out += head.slice(i + 1, k - 1);
        i = k;
        continue;
      }
      if (c === "\\") {
        out += head[i + 1] ?? "";
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };

  while (i < n) {
    const c = head[i] as string;
    if (isSpace(c)) {
      flush();
      i++;
      continue;
    }
    if (c === "\\") {
      if (head[i + 1] === "\n") {
        flush();
        i += 2;
        continue;
      }
      word += head[i + 1] ?? "";
      hasWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(head, i);
      if (k < 0) {
        ok = false;
        word += head.slice(i + 1);
        hasWord = true;
        break;
      }
      word += head.slice(i + 1, k - 1);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(head, i);
      if (k < 0) {
        ok = false;
        word += head.slice(i + 1);
        hasWord = true;
        break;
      }
      word += head.slice(i + 1, k - 1).replace(/\\(["\\$`\n])/g, "$1");
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "`") {
      const k = skipBacktick(head, i);
      if (k < 0) {
        ok = false;
        break;
      }
      word += head.slice(i, k);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "$" && head[i + 1] === "(") {
      const k = skipParens(head, i + 1);
      if (k < 0) {
        ok = false;
        break;
      }
      word += head.slice(i, k);
      hasWord = true;
      i = k;
      continue;
    }
    if (c === "&" && (head[i + 1] === ">" || head[i + 1] === "<")) {
      // &> file  (bash) or &>> file
      flush();
      let op = "&>";
      i += 2;
      if (head[i] === ">") {
        op = "&>>";
        i++;
      }
      redirects.push({ fd: null, op, target: readTarget() });
      continue;
    }
    if (c === ">" || c === "<") {
      let fd: number | null = null;
      if (hasWord && /^\d+$/.test(word)) {
        fd = Number(word);
        word = "";
        hasWord = false;
      } else {
        flush();
      }
      let op = c;
      i++;
      if (head[i] === c) {
        op += c;
        i++;
        if (c === "<" && head[i] === "<") {
          op += "<";
          i++;
        }
      }
      if (head[i] === "&") {
        op += "&";
        i++;
      }
      if (op === "<<" && head[i] === "-") {
        op = "<<-";
        i++;
      }
      if (head[i] === "|" && op === ">") {
        op = ">|";
        i++;
      }
      redirects.push({ fd, op, target: readTarget() });
      continue;
    }
    word += c;
    hasWord = true;
    i++;
  }
  flush();
  return { words, redirects, ok };
}

/** Splits a command line into segments and tokenises each one. */
export function parseCommand(src: string): ParsedCommand {
  const segments: Segment[] = [];
  const reasons: string[] = [];
  let heredoc = false;
  let processSubstitution = false;
  let grouping = false;
  let confident = true;

  const n = src.length;
  let i = 0;
  let segStart = 0;
  let op: Operator = "start";
  let pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  const bodyRanges: [number, number][] = [];
  let parenDepth = 0;

  const endSegment = (end: number, nextOp: Operator, background: boolean) => {
    const rawEnd = end;
    let text = src.slice(segStart, rawEnd);
    // Remove heredoc bodies from the head used for tokenisation.
    let head = "";
    let cursor = segStart;
    for (const [a, b] of bodyRanges) {
      if (a < segStart || a > rawEnd) continue;
      head += src.slice(cursor, a);
      cursor = Math.max(cursor, b);
    }
    head += src.slice(cursor, rawEnd);
    text = text.trim();
    head = head.trim();
    if (text.length > 0) {
      const tok = tokenize(head);
      if (!tok.ok) {
        confident = false;
        reasons.push("unbalanced quotes");
      }
      let words = tok.words;
      let negated = false;
      if (words[0] === "!") {
        negated = true;
        words = words.slice(1);
      }
      const env: string[] = [];
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) {
        env.push(words.shift() as string);
      }
      segments.push({ text, head, start: segStart, end: rawEnd, op, words, env, redirects: tok.redirects, background, negated });
    } else if (nextOp !== "newline" && nextOp !== "start" && segments.length === 0 && text.length === 0) {
      // A leading operator such as `; foo` is unusual; keep reading.
    }
    op = nextOp;
  };

  while (i < n) {
    const c = src[i] as string;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced single quote");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced double quote");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "`") {
      const k = skipBacktick(src, i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced backtick");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const k = skipParens(src, i + 1);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced command substitution");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      const k = src.indexOf("}", i);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced parameter expansion");
        i = n;
        break;
      }
      i = k + 1;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      processSubstitution = true;
      const k = skipParens(src, i + 1);
      if (k < 0) {
        confident = false;
        reasons.push("unbalanced process substitution");
        i = n;
        break;
      }
      i = k;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (src[j] === "-") {
        stripTabs = true;
        j++;
      }
      const d = readDelimiter(src, j);
      if (!d) {
        confident = false;
        reasons.push("unreadable heredoc delimiter");
        i = j;
        continue;
      }
      heredoc = true;
      pendingHeredocs.push({ delimiter: d.delimiter, stripTabs });
      i = d.next;
      continue;
    }
    if (c === "#" && (i === 0 || isSpace(src[i - 1]))) {
      let eol = src.indexOf("\n", i);
      if (eol < 0) eol = n;
      // Comments are dropped from the segment text by treating them as whitespace.
      const before = src.slice(segStart, i);
      src = src.slice(0, i) + " ".repeat(eol - i) + src.slice(eol);
      void before;
      i = eol;
      continue;
    }
    if (c === "(") {
      grouping = true;
      parenDepth++;
      i++;
      continue;
    }
    if (c === ")") {
      parenDepth--;
      if (parenDepth < 0) {
        confident = false;
        reasons.push("unbalanced parenthesis");
        parenDepth = 0;
      }
      i++;
      continue;
    }
    if (c === "{" && (i === 0 || isSpace(src[i - 1]) || src[i - 1] === ";" || src[i - 1] === "&" || src[i - 1] === "|" || src[i - 1] === "(") && isSpace(src[i + 1])) {
      grouping = true;
      i++;
      continue;
    }
    if (c === "\n") {
      const segEnd = i;
      i++;
      if (pendingHeredocs.length > 0) {
        const bodyStart = i;
        i = skipHeredocBodies(src, i, pendingHeredocs);
        bodyRanges.push([bodyStart, i]);
        pendingHeredocs = [];
        endSegment(i, "newline", false);
        segStart = i;
        continue;
      }
      endSegment(segEnd, "newline", false);
      segStart = i;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") {
      endSegment(i, "&&", false);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "|" && src[i + 1] === "|") {
      endSegment(i, "||", false);
      i += 2;
      segStart = i;
      continue;
    }
    if (c === "|") {
      const isPipeBoth = src[i + 1] === "&";
      endSegment(i, "|", false);
      i += isPipeBoth ? 2 : 1;
      segStart = i;
      continue;
    }
    if (c === ";") {
      if (src[i + 1] === ";") {
        confident = false;
        reasons.push("case terminator");
        i += 2;
        continue;
      }
      endSegment(i, ";", false);
      i += 1;
      segStart = i;
      continue;
    }
    if (c === "&") {
      const prev = src[i - 1];
      const next = src[i + 1];
      if (prev === ">" || prev === "<" || next === ">" || next === "<") {
        i++;
        continue;
      }
      endSegment(i, "&", true);
      i += 1;
      segStart = i;
      continue;
    }
    i++;
  }
  if (pendingHeredocs.length > 0) {
    // Heredoc operator with no body on a following line.
    confident = false;
    reasons.push("heredoc without body");
  }
  endSegment(n, "start", false);
  if (parenDepth !== 0) {
    confident = false;
    reasons.push("unbalanced parenthesis");
  }
  return { source: src, segments, heredoc, processSubstitution, grouping, confident, reasons };
}

/** Removes a single layer of grouping punctuation from a word list, for detection only. */
export function stripGroupingWords(words: string[]): string[] {
  const out = [...words];
  while (out.length > 0 && (out[0] === "(" || out[0] === "{")) out.shift();
  while (out.length > 0 && (out[out.length - 1] === ")" || out[out.length - 1] === "}")) out.pop();
  if (out.length > 0) {
    const first = out[0] as string;
    if (first.length > 1 && (first.startsWith("(") || first.startsWith("{"))) out[0] = first.slice(1);
    const last = out[out.length - 1] as string;
    if (last.length > 1 && (last.endsWith(")") || last.endsWith("}"))) out[out.length - 1] = last.slice(0, -1);
  }
  return out.filter((w) => w.length > 0);
}

/** Quotes a string for POSIX sh. */
export function shQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
