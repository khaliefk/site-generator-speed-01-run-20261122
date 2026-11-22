// A faster drop-in for makefun-site 1.0.0: run(input) returns byte for byte
// what makefun-site 1.0.0's build returns for the same input. Same rules,
// same order, same reports; only the work is cheaper. No dependency, no
// network, no file, no clock: the answer is a function of the input alone.
//
// Where the speed comes from: the Markdown inline pass escapes whole plain
// runs at once instead of one character at a time; slugs are cached per case
// and skip Unicode normalisation for plain ASCII; front matter is walked line
// by line without splitting the body; templates render into one shared array
// instead of building a string per node; cards, word counts and tag views are
// worked out once per source instead of once per render.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped. One regex pass over the whole string. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
/** The slug of `text`, exactly as makefun-site's slugify: NFKD, combining
 * marks dropped, A-Z lowered, each run of other characters one "-", none at
 * either end, at most 64 characters, "untitled" when nothing is left. */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  // Plain ASCII normalises to itself and holds no combining mark, so the
  // Unicode pass can be skipped for it.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

/** A slug, cached for this case (titles, tag names and headings repeat). */
function slugify(text, st) {
  const hit = st.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = slugifyRaw(text);
  st.slugCache.set(text, s);
  return s;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether a code unit is whitespace in JavaScript's \s sense. */
function isWS(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 133 || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) ||
    code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 128) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      let prevDash = true; // a slug may not open on "-"
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else if (c === 45 && !prevDash) prevDash = true;
        else ok = false;
      }
      if (ok && prevDash) ok = false; // may not close on "-"
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** One front matter line (not blank, not a comment) checked against `data`. */
function fmLine(line, num, data) {
  let blank = true;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) { blank = false; break; }
  }
  if (blank) return null;
  if (line.charCodeAt(0) === 35) return null; // a comment opens on "#"
  let j = 0;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || j >= line.length || line.charCodeAt(j) !== 58) return `line ${num} is not "key: value"`;
  const key = line.slice(0, j);
  let raw;
  if (j + 1 === line.length) raw = '';
  else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
  else return `line ${num} is not "key: value"`;
  let e = raw.length;
  while (e > 0) {
    const c = raw.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  raw = raw.slice(0, e);
  if (!KEYS.has(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. Walks the front matter's lines only; the body
 * is one slice, never split.
 */
function parseFrontMatter(text) {
  let e = text.indexOf('\n');
  const first = e === -1 ? text : text.slice(0, e);
  if (first !== '---') return { error: 'no front matter' };
  let p = e === -1 ? text.length : e + 1;
  const data = {};
  let idx = 1; // 0-based line index of the line starting at p
  while (true) {
    if (p >= text.length) return { error: 'the front matter is not closed' };
    e = text.indexOf('\n', p);
    const line = e === -1 ? text.slice(p) : text.slice(p, e);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: e === -1 ? '' : text.slice(e + 1) };
    }
    const err = fmLine(line, idx + 1, data);
    if (err !== null) return { error: err };
    p = e === -1 ? text.length : e + 1;
    idx++;
  }
}

// ---------------------------------------------------------------- markdown

/** Spaces and tabs at either end dropped. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45
  );
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const n = line.length;
  while (j < n && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < n) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6 || j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(line.slice(j));
  if (text === '') return null;
  return { depth: j, text };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A bullet item's text when `line` opens one, else null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text when `line` opens one, else null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), rest: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function continuedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWS(line.charCodeAt(j));
}

// ---------------------------------------------------------------- inline

const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
/** Whether a backslash escapes `code`: \ ` * _ [ ] ( ) # + - . ! > */
function isEsc(code) {
  return code < 128 && ESCAPABLE[code] === 1;
}

const WS_RE = /\s/;

/** The first index from `from` where `s` holds "**" outside an escape, or -1. */
function findStrong(s, from) {
  for (let j = from; j + 1 < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEsc(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds "]" outside an escape, or -1. */
function findBracket(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEsc(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEsc(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme (https:, mailto: ...). */
function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/**
 * A link target's href, or null when it names nothing built: the page built
 * from the source it names, or <base>/<path> of a static file. Resolutions
 * are cached per case per source directory: the same targets recur.
 */
function resolveLink(st, dir, target) {
  let byDir = st.linkCache.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    st.linkCache.set(dir, byDir);
  }
  let r = byDir.get(target);
  if (r === undefined) {
    r = null;
    if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) r = target;
    else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const u = st.byUrl.get(path);
        if (u !== undefined) r = u + frag;
        else if (st.staticPaths.has(path)) r = `${st.base}/${path}${frag}`;
      }
    }
    byDir.set(target, r);
  }
  return r;
}

/** The characters that can start inline markup or need escaping. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline. The scan jumps from one markup character to the next
 * with one native regex pass, and plain runs are pushed whole: only the
 * characters the escape table names are ever escaped, and a run holds none
 * of them. The shared regex's lastIndex is set from `i` before every exec,
 * so the recursive calls for strong, emphasis and links cannot disturb it.
 */
function inlineStr(s, st, srcPath, dir) {
  const parts = [];
  const n = s.length;
  let i = 0;
  let start = 0;
  let m;
  for (;;) {
    SPECIAL_RE.lastIndex = i;
    m = SPECIAL_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && isEsc(s.charCodeAt(j + 1))) {
        if (j > start) parts.push(s.slice(start, j));
        parts.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) parts.push(s.slice(start, j));
        parts.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findStrong(s, j + 2);
        if (k > j + 2) {
          if (j > start) parts.push(s.slice(start, j));
          parts.push('<strong>', inlineStr(s.slice(j + 2, k), st, srcPath, dir), '</strong>');
          i = k + 2;
          start = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) parts.push(s.slice(start, j));
        parts.push('<em>', inlineStr(s.slice(j + 1, k), st, srcPath, dir), '</em>');
        i = k + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (c === 91) {
      const k = findBracket(s, j + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > start) parts.push(s.slice(start, j));
        let href = resolveLink(st, dir, target);
        if (href === null) {
          st.broken.add(`broken-link ${srcPath} -> ${target}`);
          href = target;
        }
        parts.push('<a href="', esc(href), '">', inlineStr(s.slice(j + 1, k), st, srcPath, dir), '</a>');
        i = m + 1;
        start = i;
      } else i = j + 1;
      continue;
    }
    if (j > start) parts.push(s.slice(start, j));
    parts.push(ESCAPES[s[j]]);
    i = j + 1;
    start = i;
  }
  if (n > start) parts.push(s.slice(start, n));
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents and its excerpt (the first paragraph's inline
 * HTML, or ""). Lexing and rendering run in one pass over the lines, so no
 * token objects are built.
 */
function renderMarkdown(src, st, srcPath, dir) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const buf = [];
      i++;
      while (i < L && !fenceClose(lines[i])) buf.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      // The lines' "\n" separators are untouched by escaping, so the whole
      // block escapes in one pass instead of one per line.
      blocks.push(`<pre><code${cls}>${buf.length === 0 ? '' : `${esc(buf.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, st), ids);
      const html = inlineStr(heading.text, st, srcPath, dir);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const qlines = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        qlines.push(trimST(l));
        i++;
      }
      const kept = qlines.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), st, srcPath, dir)}</p>\n</blockquote>`);
      continue;
    }
    const bRest = bulletOf(line);
    const oM = bRest === null ? orderedOf(line) : null;
    if (bRest !== null || oM !== null) {
      const isOrdered = oM !== null;
      const start = isOrdered ? oM.num : 1;
      const items = [];
      while (i < L) {
        const cur = lines[i];
        if (isOrdered) {
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimST(m.rest)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(cur);
          if (m !== null) {
            items.push([trimST(m)]);
            i++;
            continue;
          }
        }
        if (continuedOf(cur)) {
          items[items.length - 1].push(trimST(cur));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inlineStr(parts.join('\n'), st, srcPath, dir)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inlineStr(body.join('\n'), st, srcPath, dir);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** A path's next segment: an own property of `v`, or undefined. */
function own(v, seg) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, seg) ? v[seg] : undefined;
}

/**
 * `nodes` rendered into `out` in `scope` ({ vars, parent }). `ctx` holds the
 * parsed templates, the HTML escape and the include depth. The fallback
 * renderer, used only when a template cannot be compiled (a sandbox that
 * refuses the Function constructor, say); the compiled form below is the
 * one that normally runs.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template compilation

/**
 * A template's node tree compiled to a function (env, out, cx, depth): the
 * same walk the tree renderer does, as native control flow. Scopes are
 * objects chained by prototype, all rooted at a null-prototype object, so a
 * first name reads from the nearest scope holding it exactly as the
 * tree walker's hasOwn walk does, and no Object.prototype member (toString,
 * __proto__ and the like) can ever leak in as a value. Later path segments
 * go through cx.own, the own-property check. A template that cannot be
 * compiled (a sandbox refusing the Function constructor) falls back to the
 * tree renderer above, so compilation never changes an answer.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const pathCode = (path, envVar) => {
    let code = `${envVar}.${path[0]}`;
    for (let k = 1; k < path.length; k++) code = `cx.own(${code}, ${JSON.stringify(path[k])})`;
    return code;
  };
  const gen = (ns, envVar) => {
    let code = '';
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          code += `out.push(${JSON.stringify(n.text)});`;
          break;
        case 'var':
          code += `out.push(cx.esc(cx.textOf(${pathCode(n.path, envVar)})));`;
          break;
        case 'raw':
          code += `out.push(cx.textOf(${pathCode(n.path, envVar)}));`;
          break;
        case 'if': {
          const cond = `cx.truthy(${pathCode(n.path, envVar)})`;
          code += n.not ? `if(!(${cond})){` : `if(${cond}){`;
          code += gen(n.then, envVar);
          if (n.else !== null) {
            code += `}else{`;
            code += gen(n.else, envVar);
          }
          code += `}`;
          break;
        }
        case 'for': {
          const id = ++uid;
          const e2 = `e${id}`;
          const xs = `x${id}`;
          const k = `k${id}`;
          code += `{const ${xs}=${pathCode(n.path, envVar)};if(Array.isArray(${xs})){for(let ${k}=0;${k}<${xs}.length;${k}++){const ${e2}=Object.create(${envVar});${e2}[${JSON.stringify(n.name)}]=${xs}[${k}];${e2}.loop={index:${k}+1,first:${k}===0,last:${k}===${xs}.length-1,length:${xs}.length};`;
          code += gen(n.body, e2);
          code += `}}}`;
          break;
        }
        case 'include': {
          const id = ++uid;
          code += `{const f${id}=cx.fns.get(${JSON.stringify(n.name)});if(f${id}!==undefined&&depth<8)f${id}(${envVar},out,cx,depth+1);}`;
          break;
        }
      }
    }
    return code;
  };
  return new Function('env', 'out', 'cx', 'depth', gen(nodes, 'env'));
}

/** Every parsed template compiled, or null when compilation is refused. */
function compileTemplates(templates) {
  try {
    const fns = new Map();
    for (const [name, nodes] of templates) fns.set(name, compileTemplate(nodes));
    return fns;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. Worked out once per source. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const st = {
    base: input.site.base_url.replace(/\/+$/, ''),
    slugCache: new Map(),
    linkCache: new Map(),
    broken: new Set(),
    byUrl: new Map(),
    staticPaths: new Set(),
  };

  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }
  for (const f of statics) st.staticPaths.add(f.path);

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, st), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${st.base}/${s.outDir}/`;
    st.byUrl.set(s.path, s.url);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files.
  for (const s of kept) {
    const md = renderMarkdown(s.body, st, s.path, dirOf(s.path));
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  });
  for (const s of kept) {
    if (!s.post) {
      s.newerLink = null;
      s.olderLink = null;
    }
  }

  // 6. The tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, st);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, st);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${st.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, st);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  for (const t of tags) t.view = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: null };

  // Cards, table-of-contents views and page records, each worked out once.
  for (const s of kept) {
    s.card = cardOf(s);
    s.tocView = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  }
  // tag views need the cards, so they are built after them.
  for (const t of tags) t.view.posts = t.posts.map((p) => p.card);
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.tocView,
    newer: s.newerLink,
    older: s.olderLink,
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: st.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const fns = compileTemplates(templates);
  const cx = { fns, esc, textOf, truthy, own };
  const ctx = { templates, escape: esc };
  // One scope object per case, its bindings reassigned per render: the
  // compiled templates only ever read it, never write to it, and a binding
  // left undefined reads exactly as an absent one.
  const env = Object.create(null);
  env.site = site;
  env.tags = allTags;
  env.recent = recent;
  const render = (name, vars) => {
    const out = [];
    if (fns !== null) {
      const fn = fns.get(name);
      if (fn === undefined) return null;
      env.page = vars.page;
      env.posts = vars.posts;
      env.pager = vars.pager;
      env.tag = vars.tag;
      fn(env, out, cx, 0);
      return out.join('');
    }
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${st.base}/` : `${st.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: t.view });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...st.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
