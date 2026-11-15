'use strict';
/*
 * Library Reader: a keyboard-first reader for a vault that is a library of PDFs.
 *
 *  - Library view (left sidebar): instant catalogue search, Folders, Pinned, Recent, Noted.
 *  - Book notes view (right sidebar): one '<book>.notes.md' per book under a notes folder
 *    outside the vault (default: a 'Notes' folder beside it).
 *  - Text search view: find a phrase in this book or the whole library, 20 words each side.
 *  - Reference desk (main tab): newest and recently opened books, recent annotations,
 *    books needing fixes, and a running list of requests.
 *
 * Plain CommonJS so it needs no build step. Desktop only (uses Node's fs).
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, Menu, setIcon } = obsidian;
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const VIEW_LIBRARY = 'library-reader-list';
const VIEW_NOTES = 'library-reader-notes';
const VIEW_SEARCH = 'library-reader-search';
const VIEW_DESK = 'library-reader-desk';
const NOTE_SUFFIX = '.notes.md';
const LIMIT = 400;
const RECENT_MAX = 200;

const DEFAULT_SETTINGS = {
  // library
  notesFolder: '',            // empty = LIBRARY_NOTES, else the 'Notes' folder beside the vault
  excludeFolders: '',         // vault folders that are not part of the library (one per line)
  listCap: 400,               // rows shown outside Folders view
  recentMax: 200,             // books kept in Recent
  recentOnEmpty: 50,          // recent books shown under an empty search box
  openPanelsOnStart: true,    // put Library and Book notes in the sidebars if they are missing
  // notes
  mono: false,
  autosaveMs: 1000,
  pageRef: 'p. {page} ',      // Alt+G; {page} is the viewer's current page
  // text search
  searchCap: 500,
  contextWords: 20,
  maxIndexMB: 400,
  indexing: false,            // the library-wide index build was running when Obsidian closed
  // reference desk
  deskOnStart: true,          // open the Reference desk tab if none is open
  requestsFile: 'New requests.md',   // running list of books to get (vault path)
  fixesFile: 'Library fixes.md',     // where "Export fixes" writes (vault path)
  largeMB: 100,               // books bigger than this are listed as "Too large"
  // web reference (Alt+R): a web page kept in the right sidebar
  rogettaUrl: 'https://gmleuning.github.io/Rogetta/',
  // appearance (empty = follow the Obsidian theme / built-in default)
  titleFont: 'Georgia, "Iowan Old Style", serif',
  uiFont: '',
  notesFont: 'Georgia, "Iowan Old Style", serif',
  monoFont: '',
  titleSize: 14.5,
  metaSize: 12,
  notesSize: 14.5,
  notesLineHeight: 1.55,
  rowSpacing: 'normal',       // compact | normal | roomy
  accentColor: '',
  pinColor: '',
  hitColor: '',
  notesBackground: '',
};
const STYLE_VARS = ['--lr-title-font', '--lr-ui-font', '--lr-notes-font', '--lr-mono-font', '--lr-title-size', '--lr-meta-size',
  '--lr-notes-size', '--lr-notes-lh', '--lr-row-pad', '--lr-accent', '--lr-pin', '--lr-hit', '--lr-notes-bg'];
const ROW_PAD = { compact: '2px 12px 3px', normal: '5px 12px 6px', roomy: '9px 12px 10px' };

// ================================================================ filename parsing (server.py)
const SKIP_NAME = /^(desktop\.ini|thumbs\.db|\.ds_store)$|\.(partial|gdoc|gsheet|gslides|crdownload|tmp|xcf)$/i;
const SKIP_ABBR = new Set(['vol', 'vols', 'no', 'nos', 'pp', 'ed', 'eds', 'trans', 'tr', 'st', 'dr', 'mr', 'mrs', 'jr', 'sr', 'vs', 'ch', 'cf']);
const DOC_EXT = new Set(['pdf', 'epub', 'djvu', 'mobi', 'doc', 'docx', 'rtf', 'odt', 'txt', 'md', 'lit', 'prc', 'azw3', 'pages', 'html', 'htm']);
const YEAR_LEAD = /^[eE]?(\d{4})(?:-\d{2,4})?(?:\)\s*|\s+)/;
const SURNAME_FIRST = /^([^,.]+, [A-Z][\p{L}\p{N}_\-]+) ((?:\d|[A-Z]{1,3}\d).*)$/u;

const rstripChars = (s, chars) => { let i = s.length; while (i > 0 && chars.includes(s[i - 1])) i--; return s.slice(0, i); };

/** 'Author, First. Title (Ed.)' -> [author, title, year]. Same rules as parse_name in server.py. */
function parseName(stem) {
  let author = null, title = null;
  const re = /\. /g;
  let m;
  while ((m = re.exec(stem))) {
    const head = stem.slice(0, m.index);
    const last = head ? head.split(/[\s,]+/).pop() : '';
    const words = head.split(/\s+/).filter(Boolean);
    // "West C. Title" is surname + initial; "J. D. Salinger" is not an author/title break
    const initialOk = last.length === 1 && words.length >= 2 && rstripChars(words[0], ',.').length > 1;
    if (head.length >= 3 && (last.length > 1 || initialOk) && !SKIP_ABBR.has(last.toLowerCase())) {
      author = head; title = stem.slice(m.index + 2);
      break;
    }
  }
  if (author === null && stem.includes(' - ')) {
    const i = stem.indexOf(' - ');
    author = stem.slice(0, i); title = stem.slice(i + 3);
  }
  if (author === null) {  // "Heidegger, Martin GA34 ..." / "Nietzsche, Friedrich 1883 ..."
    const s = SURNAME_FIRST.exec(stem);
    if (s) { author = s[1]; title = s[2]; }
  }
  if (author === null) { author = ''; title = stem; }
  let year = '';
  const y = YEAR_LEAD.exec(title);
  if (y) { year = y[1]; title = title.slice(y[0].length); }
  return [author.trim(), title.trim() || stem, year];
}

// ================================================================ small helpers
const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = b => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const pad = n => String(n).padStart(2, '0');
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function makeItem(file) {
  const p = file.path;
  const e = (file.extension || '').toLowerCase();
  const [a, t, y] = DOC_EXT.has(e) ? parseName(file.basename) : ['', file.basename, ''];
  const slash = p.lastIndexOf('/');
  const f = slash < 0 ? '' : p.slice(0, slash);
  return { p, a, t, y, e, s: file.stat.size, m: file.stat.mtime, c: file.stat.ctime || file.stat.mtime, f, file,
           an: norm(a), at: norm(a + ' ' + t), h: norm(a + ' ' + t + ' ' + p) };
}

function searchCatalog(catalog, q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  const hits = [];
  for (const it of catalog) {
    let ok = true;
    for (const t of toks) if (!it.h.includes(t)) { ok = false; break; }
    if (!ok) continue;
    // rank: all words in author+title first; within that, more words in the author first
    let miss = 0, auth = 0;
    for (const t of toks) { if (!it.at.includes(t)) miss++; if (it.an.includes(t)) auth++; }
    hits.push([miss * 100 - auth, it]);
  }
  hits.sort((x, y) => x[0] - y[0]);  // stable: keeps author/title order within each tier
  return hits.map(h => h[1]);
}

function matcher(q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  return it => toks.every(t => it.h.includes(t));
}

// ================================================================ notes file format (server.py)
function splitNote(text) {
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 3);
    if (end >= 0) return [text.slice(4, end).split('\n').filter(Boolean), text.slice(end + 5).replace(/^\n+/, '')];
  }
  return [[], text];
}
function fmGet(lines, key) {
  for (const ln of lines) {
    const i = ln.indexOf(':');
    if (i < 0 || ln.slice(0, i).trim() !== key) continue;
    const v = ln.slice(i + 1).trim();
    if (v.startsWith('"')) { try { return JSON.parse(v); } catch (_) { return v; } }
    return v;
  }
  return null;
}
function fmSet(lines, key, value) {  // change one key in place; other keys (Obsidian tags) are left alone
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].split(':')[0].trim() === key) { lines[i] = `${key}: ${value}`; return; }
  }
  lines.push(`${key}: ${value}`);
}
const joinNote = (lines, body) => '---\n' + lines.join('\n') + '\n---\n\n' + body;

function readText(p) {  // universal newlines, BOM dropped, like Python's encoding='utf-8-sig'
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
function mtimeOf(p) { return fs.statSync(p, { bigint: true }).mtimeNs.toString(); }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

/** Write beside the target, then swap it in, so a crash never leaves half a file. */
function writeAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), '.' + path.basename(p) + '.tmp');  // dot: Obsidian ignores it
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, p); return; }
    catch (e) {
      // another program reading the file can briefly block the swap on Windows
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const until = Date.now() + 100; while (Date.now() < until) { /* wait */ }
    }
  }
}

class NotesStore {
  constructor(plugin) { this.plugin = plugin; this.hashCache = new Map(); }
  get root() { return this.plugin.notesRoot(); }
  get lib() { return this.plugin.libRoot(); }

  static inside(base, full) {
    const b = path.resolve(base).toLowerCase(), r = path.resolve(full).toLowerCase();
    return r === b || r.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  }
  static clean(rel) {
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(p => p === '.' || p === '..')) return null;
    return parts;
  }
  /** Catalogue path -> its notes file under the notes folder, refusing anything outside it. */
  noteFile(rel) {
    const parts = NotesStore.clean(rel);
    if (!parts) return null;
    const full = path.join(this.root, ...parts.slice(0, -1), parts[parts.length - 1] + NOTE_SUFFIX);
    return NotesStore.inside(this.root, full) ? full : null;
  }
  libFile(rel) {
    const parts = NotesStore.clean(rel);
    if (!parts) return null;
    const full = path.join(this.lib, ...parts);
    return NotesStore.inside(this.lib, full) ? full : null;
  }
  /** [size, sha1 of the first 1 MiB]. Survives renames, so a renamed book can find its notes. */
  bookId(full) {
    const st = fs.statSync(full, { bigint: true });
    const key = full + '|' + st.size + '|' + st.mtimeNs;
    if (!this.hashCache.has(key)) {
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(1 << 20, Number(st.size)));
        let got = 0;
        while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, got); if (!n) break; got += n; }
        this.hashCache.set(key, crypto.createHash('sha1').update(buf.subarray(0, got)).digest('hex'));
      } finally { fs.closeSync(fd); }
    }
    return [Number(st.size), this.hashCache.get(key)];
  }
  /** Catalogue paths of books that have a notes file, most recently written first. */
  listNoted() {
    const out = [];
    const walk = (dir, relDir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, relDir ? relDir + '/' + e.name : e.name);
        else if (e.name.endsWith(NOTE_SUFFIX)) {
          let m; try { m = fs.statSync(full).mtimeMs; } catch (_) { continue; }
          const book = e.name.slice(0, -NOTE_SUFFIX.length);
          out.push([m, relDir ? relDir + '/' + book : book]);
        }
      }
    };
    walk(this.root, '');
    out.sort((a, b) => b[0] - a[0]);
    return out.map(x => x[1]);
  }
  /** A notes file whose book no longer exists but whose size and hash match this book. */
  findMoved(full) {
    const [size, digest] = this.bookId(full);
    for (const old of this.listNoted()) {
      const lf = this.libFile(old);
      if (!lf || fs.existsSync(lf)) continue;
      try {
        const lines = splitNote(readText(this.noteFile(old)))[0];
        if (fmGet(lines, 'size') === String(size) && fmGet(lines, 'hash') === digest) return old;
      } catch (_) { /* unreadable: skip */ }
    }
    return null;
  }
  getNote(rel) {
    const nf = this.noteFile(rel), full = this.libFile(rel);
    if (!nf || !full) throw new Error('Not a library path: ' + rel);
    if (isFile(nf)) return { exists: true, text: splitNote(readText(nf))[1], mtime: mtimeOf(nf), file: nf };
    let moved = null;
    try { moved = this.findMoved(full); } catch (_) { /* book unreadable */ }
    return { exists: false, text: '', mtime: null, file: nf, moved };
  }
  /** mtime is what the editor last saw (null for no file). A mismatch means the file was
   *  changed elsewhere, e.g. in Obsidian, and it is not overwritten unless forced. */
  saveNote(rel, text, mtime, force) {
    const nf = this.noteFile(rel), full = this.libFile(rel);
    if (!nf || !full) throw new Error('Not a library path: ' + rel);
    const exists = isFile(nf);
    const cur = exists ? mtimeOf(nf) : null;
    if (cur !== mtime && !force) {
      return { conflict: true, exists, mtime: cur, text: exists ? splitNote(readText(nf))[1] : '' };
    }
    if (!exists && !text.trim()) return { exists: false, mtime: null };  // don't create empty files
    const lines = exists ? splitNote(readText(nf))[0] : [];
    const [size, digest] = this.bookId(full);
    fmSet(lines, 'pdf', JSON.stringify(rel));
    fmSet(lines, 'size', size);
    fmSet(lines, 'hash', digest);
    if (fmGet(lines, 'created') === null) fmSet(lines, 'created', day());
    writeAtomic(nf, joinNote(lines, text.trimEnd() + '\n'));
    return { exists: true, mtime: mtimeOf(nf), file: nf };
  }
  /** Move the notes of a renamed book to the book's new name. */
  relinkNote(rel, old) {
    const src = this.noteFile(old), dst = this.noteFile(rel), full = this.libFile(rel);
    if (!src || !dst || !full || !isFile(src) || fs.existsSync(dst)) return false;
    if (this.findMoved(full) !== old) return false;
    const [lines, body] = splitNote(readText(src));
    fmSet(lines, 'pdf', JSON.stringify(rel));
    writeAtomic(dst, joinNote(lines, body));
    fs.unlinkSync(src);
    return true;
  }
}

// ================================================================ full-text search helpers
const fold = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const isAscii = s => /^[\x00-\x7f]*$/.test(s);
/** Folded text plus, for each folded index, the index in the original string. */
function foldMap(s) {
  const out = [], map = [];
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i), ch = String.fromCodePoint(cp);
    const d = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let k = 0; k < d.length; k++) map.push(i);
    out.push(d);
    i += ch.length;
  }
  map.push(s.length);
  return { f: out.join(''), map };
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

function buildMatcher(q, opts) {
  q = q.trim().replace(/\s+/g, ' ');
  if (!q) return null;
  let src = opts.regex ? q.normalize('NFD').replace(/\p{M}/gu, '') : escapeRe(fold(q));
  if (opts.word) src = '(?<![\\p{L}\\p{N}_])(?:' + src + ')(?![\\p{L}\\p{N}_])';
  return new RegExp(src, 'giu');
}

/** Exact hits on one page: [[start, end], ...] in the original text. */
function findInPage(text, re) {
  const scan = f => {
    const hits = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(f))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      hits.push([m.index, m.index + m[0].length]);
    }
    return hits;
  };
  if (isAscii(text)) return scan(text.toLowerCase());
  if (!scan(fold(text)).length) return [];   // cheap pre-check, then the exact mapped pass
  const { f, map } = foldMap(text);
  return scan(f).map(([s, e]) => [map[s], map[e]]);
}

/** 20 whitespace-separated words either side of [s, e), within the page. */
function windowAround(text, s, e, n = 20) {
  const lo = Math.max(0, s - 1500), hi = Math.min(text.length, e + 1500);
  const bt = text.slice(lo, s).split(' ');
  const partial = bt.pop();
  const bw = bt.filter(Boolean);
  if (lo > 0) bw.shift();
  const at = text.slice(e, hi).split(' ');
  const tail = at.shift();
  const aw = at.filter(Boolean);
  if (hi < text.length) aw.pop();
  const before = bw.slice(-n), after = aw.slice(0, n);
  return {
    pre: (bw.length > n || lo > 0 ? '…' : '') + (before.length ? before.join(' ') + ' ' : '') + partial,
    hit: text.slice(s, e),
    post: tail + (after.length ? ' ' + after.join(' ') : '') + (aw.length > n || hi < text.length ? '…' : ''),
  };
}

const SPACING_ACCENT = { '¨': '̈', 'ˆ': '̂', '˜': '̃', 'ˇ': '̌' };
/** pdf.js text items -> one line of words: lines joined, end-of-line hyphenation rejoined. */
function pageText(items) {
  let out = '', prev = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    if (prev && it.transform && prev.transform) {
      const h = Math.abs(prev.transform[3]) || Math.abs(prev.transform[0]) || 10;
      const sameLine = Math.abs(it.transform[5] - prev.transform[5]) < h * 0.5;
      if (!sameLine) out += '\n';
      else {
        const gap = it.transform[4] - (prev.transform[4] + (prev.width || 0));
        if (gap > h * 0.15 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
      }
    }
    out += it.str;
    if (it.hasEOL) { out += '\n'; prev = null; } else if (it.str) prev = it;
  }
  return out
    .replace(/(\p{L})[-\u00AD\u2010]\s*\n\s*(\p{Ll})/gu, '$1$2')   // phenom-\nenology -> phenomenology
    // loose spacing accents from TeX-made PDFs: 'F\u00A8ursichsein' -> 'F\u00FCrsichsein'
    .replace(/([\u00A8\u02C6\u02DC\u02C7])\s?(\p{L})/gu, (_, a, l) => (l + SPACING_ACCENT[a]).normalize('NFC'))
    .replace(/\u00B4\s?([aeiouyAEIOUY])/g, (_, l) => (l + '\u0301').normalize('NFC'))
    .replace(/\u00AD/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const idbReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
async function gzip(s) {
  return new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
async function gunzip(buf) {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out')), ms); })])
    .finally(() => clearTimeout(t));
}

/** Per-page text of every PDF, kept in IndexedDB keyed by path, checked against size + mtime. */
class TextIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.db = null;
    this.meta = null;          // Map path -> { size, mtime, pages, chars, noText, error }
    this.building = false;
    this.stopFlag = false;
    this.current = '';
    this.listeners = new Set();
    this.memo = new Map();     // small in-memory cache of decoded books
  }
  onChange(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() { for (const cb of this.listeners) { try { cb(); } catch (e) { console.error(e); } } }

  async open() {
    if (this.db) return this.db;
    const r = indexedDB.open('library-reader-text-' + this.plugin.app.appId, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('text'); };
    this.db = await idbReq(r);
    return this.db;
  }
  async loadMeta() {
    if (this.meta) return this.meta;
    const db = await this.open();
    const tx = db.transaction('meta', 'readonly'), st = tx.objectStore('meta');
    const [keys, vals] = await Promise.all([idbReq(st.getAllKeys()), idbReq(st.getAll())]);
    this.meta = new Map(keys.map((k, i) => [k, vals[i]]));
    return this.meta;
  }
  fresh(it) {
    const m = this.meta && this.meta.get(it.p);
    return !!m && m.size === it.s && m.mtime === it.m;
  }
  stats() {
    const pdfs = this.plugin.catalog.filter(it => it.e === 'pdf');
    let done = 0, noText = 0, errors = 0;
    for (const it of pdfs) {
      if (!this.fresh(it)) continue;
      done++;
      const m = this.meta.get(it.p);
      if (m.error) errors++; else if (m.noText) noText++;
    }
    return { total: pdfs.length, done, noText, errors };
  }

  async extract(it, onPage) {
    const full = this.plugin.notes.libFile(it.p);
    if (it.s > this.plugin.settings.maxIndexMB * 1048576) throw new Error(`larger than ${this.plugin.settings.maxIndexMB} MB`);
    const pdfjs = await obsidian.loadPdfJs();
    const buf = await fsp.readFile(full);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
    const task = pdfjs.getDocument({ data, disableFontFace: true, isEvalSupported: false, verbosity: 0, stopAtErrors: false });
    let doc;
    try {
      doc = await withTimeout(task.promise, 90000, 'Opening the PDF');
      const pages = [];
      for (let i = 1; i <= doc.numPages; i++) {
        let txt = '';
        try {
          const page = await doc.getPage(i);
          const tc = await withTimeout(page.getTextContent(), 30000, 'Page ' + i);
          txt = pageText(tc.items);
          page.cleanup();
        } catch (e) { txt = ''; }
        pages.push(txt);
        if (onPage) onPage(i, doc.numPages);
      }
      return pages;
    } finally {
      try { await task.destroy(); } catch (_) { /* ignore */ }
    }
  }
  async store(it, pages, error) {
    const db = await this.open();
    await this.loadMeta();
    const chars = pages ? pages.reduce((n, p) => n + p.replace(/\s/g, '').length, 0) : 0;
    const meta = { size: it.s, mtime: it.m, pages: pages ? pages.length : 0, chars,
                   noText: !error && (!pages || chars < Math.max(1, pages.length) * 15), error: error || null };
    const blob = pages ? await gzip(JSON.stringify(pages)) : null;
    const tx = db.transaction(['meta', 'text'], 'readwrite');
    tx.objectStore('meta').put(meta, it.p);
    if (blob) tx.objectStore('text').put(blob, it.p); else tx.objectStore('text').delete(it.p);
    await idbDone(tx);
    this.meta.set(it.p, meta);
    return meta;
  }
  /** Page texts of one book, reading the PDF if the index has nothing current for it. */
  async pages(it, onPage) {
    await this.loadMeta();
    const key = it.p + '|' + it.s + '|' + it.m;
    if (this.memo.has(key)) return this.memo.get(key);
    let pages = null;
    if (this.fresh(it)) {
      const m = this.meta.get(it.p);
      if (m.error) throw new Error(m.error);
      const db = await this.open();
      const buf = await idbReq(db.transaction('text', 'readonly').objectStore('text').get(it.p));
      pages = buf ? JSON.parse(await gunzip(buf)) : [];
    } else {
      try { pages = await this.extract(it, onPage); }
      catch (e) { await this.store(it, null, String(e.message || e)); this.emit(); throw e; }
      await this.store(it, pages);
      this.emit();
    }
    this.memo.set(key, pages);
    if (this.memo.size > 4) this.memo.delete(this.memo.keys().next().value);
    return pages;
  }

  /** Background build of the whole library; resumable because every book is stored as it is done. */
  async build() {
    if (this.building) return;
    this.building = true; this.stopFlag = false;
    this.plugin.settings.indexing = true; this.plugin.saveState();
    this.emit();
    try {
      await this.loadMeta();
      const pl = this.plugin;
      const first = new Set([...Object.keys(pl.pins), ...pl.recent.map(r => r[0]), ...pl.noted]);
      const todo = pl.catalog.filter(it => it.e === 'pdf' && !this.fresh(it));
      todo.sort((a, b) => (first.has(b.p) ? 1 : 0) - (first.has(a.p) ? 1 : 0));
      for (const it of todo) {
        if (this.stopFlag) break;
        if (!pl.byPath.has(it.p) || this.fresh(it)) continue;
        this.current = it.p; this.emit();
        try { await this.store(it, await this.extract(it)); }
        catch (e) { try { await this.store(it, null, String(e.message || e)); } catch (_) { /* ignore */ } }
        this.emit();
        await sleep(15);  // let the interface breathe between books
      }
    } catch (e) {
      console.error('Library Reader: index build failed', e);
      new Notice('Library index build stopped: ' + (e.message || e));
    } finally {
      this.building = false; this.current = '';
      if (!this.stopFlag) { this.plugin.settings.indexing = false; this.plugin.saveState(); }
      this.emit();
    }
  }
  stop(remember = true) {
    this.stopFlag = true;
    if (remember) { this.plugin.settings.indexing = false; this.plugin.saveState(); }
    this.emit();
  }
  async clear() {
    this.stop();
    const db = await this.open();
    const tx = db.transaction(['meta', 'text'], 'readwrite');
    tx.objectStore('meta').clear(); tx.objectStore('text').clear();
    await idbDone(tx);
    this.meta = new Map(); this.memo.clear();
    this.emit();
  }
}

// ================================================================ PDF viewer access (Obsidian internals, used defensively)
function pdfParts(leaf) {
  try {
    const child = leaf && leaf.view && leaf.view.viewer && leaf.view.viewer.child;
    const app = child && child.pdfViewer;               // Obsidian's wrapper around pdf.js
    const viewer = app && (app.pdfViewer || app);        // pdf.js PDFViewer
    const bus = (app && app.eventBus) || (viewer && viewer.eventBus);
    return { viewer, bus };
  } catch (_) { return {}; }
}
function pdfPage(leaf) {
  const { viewer } = pdfParts(leaf);
  const n = viewer && viewer.currentPageNumber;
  return typeof n === 'number' && n > 0 ? n : null;
}

// ================================================================ Library view
class LibraryView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    const ui = plugin.ui || {};
    this.mode = ui.view || 'search';
    this.cwd = ui.cwd || '';
    this.items = []; this.sel = 0; this.qTimer = 0;
  }
  getViewType() { return VIEW_LIBRARY; }
  getDisplayText() { return 'Library'; }
  getIcon() { return 'library'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('lr-library');
    const header = root.createDiv('lr-header');
    this.q = header.createEl('input', { type: 'search', cls: 'lr-q', attr: { placeholder: 'Search titles, authors, folders', spellcheck: 'false', autocomplete: 'off' } });
    const nav = header.createDiv('lr-nav');
    this.navButtons = {};
    [['search', 'Search'], ['folders', 'Folders'], ['pinned', 'Pinned'], ['recent', 'Recent'], ['noted', 'Noted']].forEach(([v, label], i) => {
      const b = nav.createEl('button', { text: label, attr: { title: `${label} (Alt+${i + 1})` } });
      b.addEventListener('click', () => this.setMode(v));
      this.navButtons[v] = b;
    });
    nav.createSpan('lr-sp');
    const rescan = nav.createEl('button', { cls: 'lr-icon', attr: { title: 'Rescan the library folder', 'aria-label': 'Rescan' } });
    setIcon(rescan, 'refresh-cw');
    rescan.addEventListener('click', () => { this.plugin.buildCatalog(); this.plugin.refreshNoted(); });
    this.crumbs = root.createDiv('lr-crumbs');
    this.list = root.createDiv('lr-list');
    const footer = root.createDiv('lr-footer');
    this.status = footer.createSpan();
    footer.createSpan('lr-sp');
    footer.createSpan({ cls: 'lr-hint' }).innerHTML = '<kbd>/</kbd> search · <kbd>Alt</kbd>+<kbd>1–5</kbd> views · <kbd>Alt</kbd>+<kbd>N</kbd> notes';

    this.q.addEventListener('input', () => {
      clearTimeout(this.qTimer); this.sel = 0;
      this.qTimer = window.setTimeout(() => this.build(), this.plugin.catalog.length > 20000 ? 60 : 0);
    });
    this.list.addEventListener('click', e => {
      const r = e.target.closest('.lr-row'); if (!r) return;
      this.sel = +r.dataset.i; this.mark(false);
      this.activate(this.sel, e.shiftKey || e.ctrlKey || e.metaKey);
    });
    this.list.addEventListener('contextmenu', e => {
      const r = e.target.closest('.lr-row'); if (!r) return;
      const x = this.items[+r.dataset.i]; if (!x || x.k !== 'file') return;
      e.preventDefault();
      this.plugin.itemMenu(x.it).showAtMouseEvent(e);
    });
    this.crumbs.addEventListener('click', e => { const a = e.target.closest('a'); if (a) this.cd(a.dataset.c); });
    root.addEventListener('keydown', e => this.onKey(e));
    root.addEventListener('mouseup', () => { if (!window.getSelection().toString()) this.q.focus(); });

    this.setMode(this.mode, false);
    this.updateStatus();
  }

  focusSearch() { this.q.focus(); this.q.select(); }
  updateStatus() {
    if (!this.status) return;
    const p = this.plugin;
    if (!p.catalog.length && !p.scannedAt) { this.status.setText('Loading…'); return; }
    const when = p.scannedAt ? p.scannedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    this.status.setText(`${p.catalog.length.toLocaleString()} items · scanned ${when}`);
  }
  setMode(v, focus = true) {
    this.mode = v; this.sel = 0;
    for (const [k, b] of Object.entries(this.navButtons)) b.toggleClass('lr-on', k === v);
    this.q.value = '';
    this.q.placeholder = { search: 'Search titles, authors, folders', folders: 'Filter this folder', pinned: 'Filter pinned', recent: 'Filter recent', noted: 'Filter noted' }[v];
    this.build();
    this.plugin.saveUi({ view: this.mode, cwd: this.cwd });
    if (focus) this.q.focus();
  }
  cd(p) { this.cwd = p; this.sel = 0; this.q.value = ''; this.build(); this.plugin.saveUi({ view: this.mode, cwd: this.cwd }); }
  up() {
    if (this.mode !== 'folders' || !this.cwd) return;
    const name = this.cwd.split('/').pop();
    this.cd(this.cwd.includes('/') ? this.cwd.slice(0, this.cwd.lastIndexOf('/')) : '');
    const i = this.items.findIndex(x => x.k === 'dir' && x.name === name);
    if (i >= 0) { this.sel = i; this.mark(); }
  }

  build(keepScroll = false) {
    if (!this.list) return;
    const top = this.list.scrollTop;
    const p = this.plugin, q = this.q.value.trim(), m = matcher(q);
    this.crumbs.toggle(this.mode === 'folders');
    const files = arr => arr.map(x => p.byPath.get(x)).filter(Boolean).filter(it => !m || m(it)).map(it => ({ k: 'file', it }));
    let note = '';
    if (this.mode === 'search') {
      if (q) this.items = searchCatalog(p.catalog, q).map(it => ({ k: 'file', it }));
      else {
        this.items = files(p.recent.map(r => r[0])).slice(0, Math.max(0, p.settings.recentOnEmpty));
        note = this.items.length ? 'Recently opened' : '';
      }
    } else if (this.mode === 'pinned') {
      this.items = files(Object.entries(p.pins).sort((a, b) => b[1] - a[1]).map(x => x[0]));
      if (!this.items.length) note = q ? 'No pinned items match.' : 'Nothing pinned yet. Press Alt+P on a selected item.';
    } else if (this.mode === 'recent') {
      this.items = files(p.recent.map(r => r[0]));
      if (!this.items.length) note = 'Nothing opened yet.';
    } else if (this.mode === 'noted') {
      this.items = files(p.noted);
      if (!this.items.length) note = q ? 'No noted items match.' : 'No notes yet. Open a book and press Alt+N.';
    } else {
      let node = p.nodeAt(this.cwd);
      if (!node) { this.cwd = ''; node = p.tree(); }
      const dirs = [...node.dirs.keys()].sort(collator.compare)
        .filter(d => !q || norm(d).includes(norm(q)))
        .map(d => ({ k: 'dir', name: d, path: this.cwd ? this.cwd + '/' + d : d, n: node.dirs.get(d).n }));
      const fl = node.files.filter(it => !m || m(it)).sort((x, y) => collator.compare(x.p, y.p)).map(it => ({ k: 'file', it }));
      this.items = (this.cwd ? [{ k: 'up' }] : []).concat(dirs, fl);
      const parts = this.cwd ? this.cwd.split('/') : [];
      this.crumbs.innerHTML = '<a data-c="">Library</a>' + parts.map((x, i) =>
        ' / <a data-c="' + esc(parts.slice(0, i + 1).join('/')) + '">' + esc(x) + '</a>').join('');
    }
    this.sel = Math.min(this.sel, Math.max(this.items.length - 1, 0));
    this.render(note, q);
    if (keepScroll) this.list.scrollTop = top;
  }
  cap() { return Math.max(1, this.plugin.settings.listCap || LIMIT); }
  shown() { return this.mode === 'folders' ? this.items.length : Math.min(this.items.length, this.cap()); }
  rowHTML(x, i) {
    if (x.k === 'up') return `<div class="lr-row lr-dir lr-up" data-i="${i}"><div class="lr-t">..</div></div>`;
    if (x.k === 'dir') return `<div class="lr-row lr-dir" data-i="${i}"><div class="lr-t">${esc(x.name)}</div><div class="lr-m">${x.n.toLocaleString()} items</div></div>`;
    const it = x.it, p = this.plugin;
    const meta = [it.a, it.y].filter(Boolean).join(' · ');
    const nf = norm(it.f);
    const showDir = this.mode !== 'folders' && it.f && !(it.an && (it.an.includes(nf) || nf.includes(it.an)));
    const where = showDir ? (meta ? ' · ' : '') + esc(it.f) : '';
    const cls = (p.pins[it.p] ? ' lr-pin' : '') + (p.notedSet.has(it.p) ? ' lr-noted' : '') + (p.currentBook === it.p ? ' lr-current' : '');
    return `<div class="lr-row${cls}" data-i="${i}" title="${esc(it.p)}"><div class="lr-t">${esc(it.t)}</div>` +
      `<div class="lr-m">${esc(meta)}${where} · ${fmtSize(it.s)}${it.e !== 'pdf' ? `<span class="lr-x">${esc(it.e)}</span>` : ''}</div></div>`;
  }
  render(note, q) {
    const n = this.shown();
    let h = note ? `<div class="lr-note">${esc(note)}</div>` : '';
    for (let i = 0; i < n; i++) h += this.rowHTML(this.items[i], i);
    if (n < this.items.length) h += `<div class="lr-note">${(this.items.length - n).toLocaleString()} more — keep typing to narrow it down</div>`;
    if (!this.items.length && this.mode === 'search' && q) h += '<div class="lr-note">No matches.</div>';
    this.list.innerHTML = h;
    this.mark(false);
  }
  mark(scroll = true) {
    for (const el of this.list.querySelectorAll('.lr-row.lr-sel')) el.removeClass('lr-sel');
    const el = this.list.querySelector(`.lr-row[data-i="${this.sel}"]`);
    if (el) { el.addClass('lr-sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
  }
  move(d) {
    const n = this.shown(); if (!n) return;
    this.sel = Math.max(0, Math.min(n - 1, this.sel + d));
    this.mark();
  }
  selectedFile() { const x = this.items[this.sel]; return x && x.k === 'file' ? x.it : null; }
  activate(i, newTab) {
    const x = this.items[i]; if (!x) return;
    if (x.k === 'up') return this.up();
    if (x.k === 'dir') return this.cd(x.path);
    this.plugin.openItem(x.it, newTab).then(() => { if (!newTab) this.q.focus(); });
  }
  onKey(e) {
    const q = this.q, inQ = e.target === q, empty = !q.value, k = e.key;
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.altKey && /^[1-5]$/.test(k)) { done(); return this.setMode(['search', 'folders', 'pinned', 'recent', 'noted'][+k - 1]); }
    if (e.altKey && k.toLowerCase() === 'p') { done(); return this.plugin.togglePin(this.selectedFile() || this.plugin.currentItem()); }
    if (k === '/' && !inQ) { done(); return this.focusSearch(); }
    if (k === 'Escape') { done(); if (inQ && q.value) { q.value = ''; this.build(); } q.focus(); return; }
    if (k === 'ArrowDown') { done(); return this.move(1); }
    if (k === 'ArrowUp') { done(); return this.move(-1); }
    if (k === 'PageDown') { done(); return this.move(12); }
    if (k === 'PageUp') { done(); return this.move(-12); }
    if (k === 'Enter') { done(); return this.activate(this.sel, e.shiftKey); }
    if (this.mode === 'folders' && empty) {
      if (k === 'Backspace' || k === 'ArrowLeft') { done(); return this.up(); }
      if (k === 'ArrowRight') { const x = this.items[this.sel]; if (x && x.k === 'dir') { done(); this.cd(x.path); } }
    }
  }
}

// ================================================================ Book notes view (web/notes.js)
class NotesView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.doc = null;   // { rel, mtime, dirty, blocked }
    this.timer = 0;
  }
  getViewType() { return VIEW_NOTES; }
  getDisplayText() { return 'Book notes'; }
  getIcon() { return 'pencil'; }

  draftKey(rel) { return 'library-reader:' + this.app.appId + ':notes-draft:' + rel; }
  draftGet(rel) { try { return JSON.parse(localStorage.getItem(this.draftKey(rel))); } catch (_) { return null; } }
  draftSet(rel, v) { try { localStorage.setItem(this.draftKey(rel), JSON.stringify(v)); } catch (_) { /* ignore */ } }
  draftDel(rel) { try { localStorage.removeItem(this.draftKey(rel)); } catch (_) { /* ignore */ } }

  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('lr-notes');
    const head = root.createDiv('lr-nhead');
    this.title = head.createDiv('lr-ntitle');
    this.statusEl = head.createSpan('lr-nstatus');
    this.pinBtn = head.createEl('button', { attr: { title: 'Pin or unpin this book' } });
    this.pinBtn.addEventListener('click', () => this.doc && this.plugin.togglePin(this.plugin.byPath.get(this.doc.rel)));
    const ext = head.createEl('button', { text: '↗', attr: { title: 'Open in the default Windows program' } });
    ext.addEventListener('click', () => this.doc && this.plugin.openExternal(this.doc.rel));
    const mono = head.createEl('button', { text: 'Aa', attr: { title: 'Serif or monospace (Alt+M)' } });
    mono.addEventListener('click', () => { this.toggleMono(); this.ta.focus(); });
    this.bar = root.createDiv('lr-nbar'); this.bar.hide();
    this.ta = root.createEl('textarea', { cls: 'lr-ntext', attr: { spellcheck: 'true',
      placeholder: 'Open a book in the library, then write as you read. Alt+G inserts a page reference. Alt+N goes back to the book.' } });
    this.ta.readOnly = true;
    this.toggleMono(!!this.plugin.settings.mono);

    // First writing of the day at the end of the notes gets a date header. Typing inside
    // older text (correcting yesterday's notes) does not.
    this.ta.addEventListener('beforeinput', e => { if (e.inputType.startsWith('insert')) this.ensureHeader(); });
    this.ta.addEventListener('input', () => {
      if (!this.doc) return;
      this.doc.dirty = true;
      if (!this.doc.blocked) this.status('Editing…');
      this.draftSet(this.doc.rel, { text: this.ta.value, base: this.doc.mtime });
      clearTimeout(this.timer); this.timer = window.setTimeout(() => this.save(), Math.max(200, this.plugin.settings.autosaveMs || 1000));
    });
    this.ta.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      if (e.altKey && k === 'g') {
        e.preventDefault(); e.stopPropagation();
        if (!this.doc || this.ta.readOnly) return;
        const pg = this.plugin.currentPage(this.doc.rel);
        this.ensureHeader();
        const tpl = this.plugin.settings.pageRef || 'p. {page} ';
        // no page known: keep the text up to {page}, ready to type the number
        document.execCommand('insertText', false, pg ? tpl.replace(/\{page\}/g, pg) : tpl.split('{page}')[0]);
      } else if (e.altKey && k === 'm') { e.preventDefault(); e.stopPropagation(); this.toggleMono(); }
    });
    this.registerDomEvent(this.ta, 'blur', () => this.save());
    if (this.plugin.currentBook) this.load(this.plugin.currentBook);
    else this.showEmpty();
  }
  async onClose() { this.save(); }

  status(msg, warn = false) { this.statusEl.setText(msg); this.statusEl.toggleClass('lr-warn', warn); }
  setBar(build) {
    this.bar.empty();
    if (!build) { this.bar.hide(); this.ta.readOnly = !this.doc; return; }
    build(this.bar); this.bar.show(); this.ta.readOnly = true;
  }
  showEmpty() {
    this.title.setText('No book open'); this.title.title = '';
    this.ta.value = ''; this.ta.readOnly = true; this.status('');
    this.pinBtn.setText('☆');
  }
  syncPin() {
    if (!this.pinBtn) return;
    const on = this.doc && this.plugin.pins[this.doc.rel];
    this.pinBtn.setText(on ? '★' : '☆');
    this.pinBtn.toggleClass('lr-on', !!on);
  }
  toggleMono(on = !this.contentEl.hasClass('lr-mono')) {
    this.contentEl.toggleClass('lr-mono', on);
    if (this.plugin.settings.mono !== on) { this.plugin.settings.mono = on; this.plugin.saveState(); }
  }
  ensureHeader() {
    const ta = this.ta;
    if (!this.doc || ta.readOnly) return;
    const end = ta.value.length;
    if (ta.selectionStart !== end || ta.selectionEnd !== end) return;
    if (new RegExp('^## ' + day() + '\\b', 'm').test(ta.value)) return;
    const body = ta.value.replace(/\s+$/, '');
    ta.value = (body ? body + '\n\n' : '') + '## ' + day() + ' ' + clock() + '\n';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }
  focusEnd() {
    this.ta.focus();
    this.ta.selectionStart = this.ta.selectionEnd = this.ta.value.length;
    this.ta.scrollTop = this.ta.scrollHeight;
  }

  load(rel, opts = {}) {
    if (!this.ta) return;   // not drawn yet (Obsidian opens sidebar views lazily); onOpen loads the current book
    if (!opts.force && this.doc && this.doc.rel === rel) { if (opts.focus) this.focusEnd(); return; }
    if (this.doc) this.save();   // flush the book we are leaving
    clearTimeout(this.timer);
    this.doc = null; this.setBar(null);
    const it = this.plugin.byPath.get(rel);
    this.title.setText(it ? it.t : rel.split('/').pop().replace(/\.[^.]+$/, ''));
    this.title.title = rel;
    let j;
    try { j = this.plugin.notes.getNote(rel); }
    catch (e) {
      this.ta.value = ''; this.status('Notes folder not reachable', true);
      this.setBar(b => {
        b.createSpan({ text: `Cannot read the notes folder (${this.plugin.notesRoot()}): ${e.message}` });
        b.createEl('button', { text: 'Retry' }).addEventListener('click', () => this.load(rel, { force: true, focus: true }));
      });
      return;
    }
    const draft = this.draftGet(rel);
    this.doc = { rel, mtime: j.mtime, dirty: false, blocked: false };
    this.ta.readOnly = false;
    this.ta.value = j.text;
    this.status(j.exists ? '' : 'No notes yet');
    this.syncPin();
    if (draft && draft.text === j.text) this.draftDel(rel);
    else if (draft && draft.base === j.mtime) { this.ta.value = draft.text; this.doc.dirty = true; this.save(); }  // unsaved writing from last time
    else if (draft) { this.ta.value = draft.text; this.doc.dirty = true; this.conflict(j); }
    else if (j.moved) this.offerRelink(rel, j.moved);
    this.ta.selectionStart = this.ta.selectionEnd = this.ta.value.length;
    this.ta.scrollTop = this.ta.scrollHeight;
    if (opts.focus) this.focusEnd();
  }
  /** Coming back to Obsidian: pick up writing done meanwhile elsewhere. */
  refresh() {
    if (!this.ta) return;
    const d = this.doc;
    if (!d || d.dirty || d.blocked) return;
    let j; try { j = this.plugin.notes.getNote(d.rel); } catch (_) { return; }
    if (j.mtime !== d.mtime) {
      d.mtime = j.mtime; this.ta.value = j.text;
      this.ta.selectionStart = this.ta.selectionEnd = this.ta.value.length; this.ta.scrollTop = this.ta.scrollHeight;
    }
  }
  conflict(j) {
    const d = this.doc;
    d.blocked = true;
    this.status('Changed elsewhere', true);
    this.setBar(b => {
      b.createSpan({ text: `This notes file was ${j.exists ? 'changed' : 'deleted'} elsewhere after it was loaded here.` });
      b.createEl('button', { text: "Use the file's version" }).addEventListener('click', () => {
        this.draftDel(d.rel);
        Object.assign(d, { mtime: j.mtime, dirty: false, blocked: false });
        this.setBar(null); this.ta.value = j.text; this.status('Loaded the file'); this.focusEnd();
      });
      b.createEl('button', { text: "Keep what's here" }).addEventListener('click', () => {
        d.blocked = false; d.dirty = true; this.setBar(null); this.save(true); this.ta.focus();
      });
    });
  }
  offerRelink(rel, old) {
    this.setBar(b => {
      b.createSpan().innerHTML = `Notes exist for this book under its old name: <i>${esc(old)}</i>`;
      b.createEl('button', { text: 'Move them to this book' }).addEventListener('click', () => {
        let ok = false;
        try { ok = this.plugin.notes.relinkNote(rel, old); } catch (e) { console.error(e); }
        if (ok) { this.plugin.refreshNoted(); this.load(rel, { force: true, focus: true }); }
        else this.status('Could not move the notes', true);
      });
      b.createEl('button', { text: 'Start new notes' }).addEventListener('click', () => { this.setBar(null); this.ta.focus(); });
    });
  }
  save(force = false) {
    clearTimeout(this.timer);
    if (!this.ta) return;
    const d = this.doc;
    if (!d || !d.dirty || d.blocked) return;
    const text = this.ta.value;
    d.dirty = false;
    let r;
    try { r = this.plugin.notes.saveNote(d.rel, text, d.mtime, force); }
    catch (e) {
      console.error('Library Reader: saving notes failed', e);
      d.dirty = true;  // the draft in local storage still holds the text
      if (this.doc === d) { this.status('Could not write the file; kept a draft, retrying', true); this.timer = window.setTimeout(() => this.save(), 5000); }
      return;
    }
    if (r.conflict) { d.dirty = true; if (this.doc === d) this.conflict(r); return; }
    const wasNoted = this.plugin.notedSet.has(d.rel);
    d.mtime = r.mtime;
    this.draftDel(d.rel);
    if (this.doc === d) this.status(r.exists ? 'Saved ' + clock() : 'No notes yet');
    if (r.exists && !wasNoted) this.plugin.refreshNoted();
  }
}

// ================================================================ Text search view
class TextSearchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.scope = 'book';
    this.run = 0;        // cancels older searches
    this.hits = [];      // flat list for keyboard navigation
    this.sel = -1;
    this.timer = 0;
  }
  getViewType() { return VIEW_SEARCH; }
  getDisplayText() { return 'Text search'; }
  getIcon() { return 'text-search'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('lr-search');
    const head = root.createDiv('lr-shead');
    this.q = head.createEl('input', { type: 'search', cls: 'lr-q', attr: { placeholder: 'Find in this book', spellcheck: 'false' } });
    const opts = head.createDiv('lr-sopts');
    const seg = opts.createDiv('lr-seg');
    this.scopeBtns = {
      book: seg.createEl('button', { text: 'This book' }),
      library: seg.createEl('button', { text: 'Whole library' }),
    };
    for (const [k, b] of Object.entries(this.scopeBtns)) b.addEventListener('click', () => this.setScope(k));
    const chk = (label, title) => {
      const l = opts.createEl('label', { attr: { title } });
      const c = l.createEl('input', { type: 'checkbox' });
      l.appendText(' ' + label);
      c.addEventListener('change', () => this.schedule(true));
      return c;
    };
    this.word = chk('Whole word', 'Match whole words only');
    this.regex = chk('Regex', 'Regular expression (applied to accent-folded text, case-insensitive)');
    this.info = head.createDiv('lr-sinfo');
    this.indexLine = head.createDiv('lr-sindex');
    this.results = root.createDiv('lr-sresults');

    this.q.addEventListener('input', () => this.schedule(false));
    this.q.addEventListener('keydown', e => this.onKey(e));
    this.results.addEventListener('keydown', e => this.onKey(e));
    this.results.addEventListener('click', e => {
      const r = e.target.closest('.lr-hit'); if (!r) return;
      this.select(+r.dataset.i, false); this.openHit(this.hits[this.sel]);
    });
    this.unsub = this.plugin.textIndex.onChange(() => this.renderIndexLine());
    this.setScope('book', false);
  }
  async onClose() { this.run++; if (this.unsub) this.unsub(); }

  focusInput() { this.q.focus(); this.q.select(); }
  setScope(s, focus = true) {
    this.scope = s;
    for (const [k, b] of Object.entries(this.scopeBtns)) b.toggleClass('lr-on', k === s);
    this.q.placeholder = s === 'book' ? 'Find in this book' : 'Find in the whole library (Enter)';
    this.renderIndexLine();
    this.run++; this.clearResults();
    if (this.q.value.trim() && s === 'book') this.search();
    else this.info.setText(s === 'library' && this.q.value.trim() ? 'Press Enter to search the library.' : '');
    if (focus) this.q.focus();
  }
  schedule(now) {
    clearTimeout(this.timer);
    if (this.scope === 'library' && !now) { this.info.setText(this.q.value.trim() ? 'Press Enter to search the library.' : ''); return; }
    this.timer = window.setTimeout(() => this.search(), now ? 0 : 250);
  }
  clearResults() { this.results.empty(); this.hits = []; this.sel = -1; }

  async renderIndexLine() {
    const el = this.indexLine;
    if (!el) return;
    const ti = this.plugin.textIndex;
    el.empty();
    if (this.scope !== 'library') { el.hide(); return; }
    el.show();
    await ti.loadMeta();
    const s = ti.stats();
    const txt = el.createSpan();
    txt.setText(`Indexed ${s.done.toLocaleString()} of ${s.total.toLocaleString()} PDFs` +
      (s.noText ? ` · ${s.noText.toLocaleString()} without text` : '') + (s.errors ? ` · ${s.errors.toLocaleString()} unreadable` : '') +
      (ti.building && ti.current ? ` · reading ${ti.current.split('/').pop()}` : ''));
    const btn = el.createEl('button', { text: ti.building ? 'Pause' : (s.done < s.total ? (s.done ? 'Resume indexing' : 'Build index') : 'Up to date') });
    btn.disabled = !ti.building && s.done >= s.total;
    btn.addEventListener('click', () => { if (ti.building) ti.stop(); else ti.build(); });
  }

  key() { return [this.scope, this.q.value.trim(), this.word.checked, this.regex.checked, this.plugin.currentBook].join('\u0000'); }
  async search() {
    const token = ++this.run;
    this.searchedKey = this.key();
    this.clearResults();
    const q = this.q.value;
    if (!q.trim()) { this.info.setText(''); return; }
    let re;
    try { re = buildMatcher(q, { word: this.word.checked, regex: this.regex.checked }); }
    catch (e) { this.info.setText('Invalid regular expression: ' + e.message); return; }
    const cap = Math.max(1, this.plugin.settings.searchCap || 500);
    const ctx = { token, re, cap, shown: 0, total: 0, books: 0 };
    if (this.scope === 'book') {
      const it = this.plugin.currentItem();
      if (!it) { this.info.setText('Open a book first.'); return; }
      if (it.e !== 'pdf') { this.info.setText('Text search works on PDFs; this is a .' + it.e + ' file.'); return; }
      let pages;
      try {
        pages = await this.plugin.textIndex.pages(it, (i, n) => { if (token === this.run) this.info.setText(`Reading page ${i} of ${n}…`); });
      } catch (e) { if (token === this.run) this.info.setText('Could not read this PDF: ' + (e.message || e)); return; }
      if (token !== this.run) return;
      const m = this.plugin.textIndex.meta.get(it.p);
      if (m && m.noText) { this.noTextNote(this.results, it); this.info.setText('No text layer.'); return; }
      this.searchBook(it, pages, ctx, false);
      this.info.setText(ctx.total ? `${ctx.total.toLocaleString()} hit${ctx.total === 1 ? '' : 's'}` + (ctx.total > ctx.shown ? ` · showing ${ctx.shown}, ${(ctx.total - ctx.shown).toLocaleString()} more` : '') : 'No matches in this book.');
      if (this.hits.length) this.select(0, false);
      return;
    }
    // whole library: stream through indexed books
    const ti = this.plugin.textIndex;
    await ti.loadMeta();
    const books = this.plugin.catalog.filter(it => it.e === 'pdf' && ti.fresh(it));
    const notIndexed = this.plugin.catalog.filter(it => it.e === 'pdf').length - books.length;
    const stopBtn = createEl('button', { text: 'Stop' });
    stopBtn.addEventListener('click', () => { this.run++; stopBtn.remove(); this.info.firstChild && this.info.firstChild.appendText(' (stopped)'); });
    let searched = 0, last = 0;
    const progress = (final) => {
      this.info.empty();
      this.info.createSpan({ text: `${ctx.total.toLocaleString()} hit${ctx.total === 1 ? '' : 's'} in ${ctx.books.toLocaleString()} book${ctx.books === 1 ? '' : 's'} · searched ${searched.toLocaleString()} of ${books.length.toLocaleString()}` +
        (ctx.total > ctx.shown ? ` · ${(ctx.total - ctx.shown).toLocaleString()} more not shown` : '') +
        (notIndexed ? ` · ${notIndexed.toLocaleString()} not indexed yet` : '') + (final ? '' : '…') });
      if (!final) this.info.appendChild(stopBtn);
    };
    progress(false);
    for (const it of books) {
      if (token !== this.run) return;
      const m = ti.meta.get(it.p);
      searched++;
      if (m.error || m.noText) continue;
      let pages;
      try { pages = await ti.pages(it); } catch (_) { continue; }
      if (token !== this.run) return;
      this.searchBook(it, pages, ctx, true);
      if (Date.now() - last > 150) { last = Date.now(); progress(false); await sleep(0); }
    }
    if (token !== this.run) return;
    progress(true);
    if (!ctx.total) this.results.createDiv({ cls: 'lr-note', text: 'No matches in the indexed books.' });
    if (this.hits.length && this.sel < 0) this.select(0, false);
  }
  searchBook(it, pages, ctx, grouped) {
    let group = null, count = 0, countEl = null;
    for (let i = 0; i < pages.length; i++) {
      const found = findInPage(pages[i], ctx.re);
      if (!found.length) continue;
      if (!count) {
        ctx.books++;
        if (grouped) {
          group = this.results.createDiv('lr-sgroup');
          const h = group.createDiv({ cls: 'lr-sbook', attr: { title: it.p } });
          h.createSpan({ cls: 'lr-sbook-t', text: [it.a, it.t].filter(Boolean).join(' — ') });
          countEl = h.createSpan('lr-sbook-n');
        }
      }
      for (const [s, e] of found) {
        count++; ctx.total++;
        if (ctx.shown >= ctx.cap) continue;
        ctx.shown++;
        const w = windowAround(pages[i], s, e, Math.max(1, this.plugin.settings.contextWords || 20));
        const row = (group || this.results).createDiv({ cls: 'lr-hit', attr: { 'data-i': String(this.hits.length), tabindex: '-1' } });
        row.createSpan({ cls: 'lr-hpage', text: 'p. ' + (i + 1) });
        const snip = row.createSpan('lr-hsnip');
        snip.appendText(w.pre); snip.createEl('mark', { text: w.hit }); snip.appendText(w.post);
        this.hits.push({ rel: it.p, page: i + 1, term: w.hit, el: row });
      }
    }
    if (countEl) countEl.setText(String(count));
  }
  noTextNote(parent, it) {
    parent.createDiv({ cls: 'lr-note lr-warn', text: `“${it.t}” has no text layer (a scan), so it cannot be searched. Run OCR on it to add a text layer.` });
  }
  select(i, scroll = true) {
    if (!this.hits.length) return;
    i = Math.max(0, Math.min(this.hits.length - 1, i));
    if (this.sel >= 0 && this.hits[this.sel]) this.hits[this.sel].el.removeClass('lr-sel');
    this.sel = i;
    const el = this.hits[i].el;
    el.addClass('lr-sel');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }
  onKey(e) {
    const done = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { done(); this.select(this.sel + 1); }
    else if (e.key === 'ArrowUp') { done(); this.select(this.sel - 1); }
    else if (e.key === 'Enter') {
      done();
      // in the box: Enter runs a library search, or opens the selected hit in this book
      if (e.target === this.q && (this.sel < 0 || this.searchedKey !== this.key())) {
        clearTimeout(this.timer);
        return this.search();
      }
      if (this.sel >= 0) this.openHit(this.hits[this.sel]);
    } else if (e.key === 'Escape') { done(); this.plugin.focusBook(); }
  }
  openHit(h) { if (h) this.plugin.openAt(h.rel, h.page, h.term, this.word.checked); }
}

// ================================================================ Reference desk (a front page modelled on AAAARG)
const DESK_ROWS = 6;
const FIX_LABELS = {
  ocr: ['Needs OCR', 'PDFs with no text layer (scans): they cannot be searched or quoted.'],
  large: ['Too large', 'Files over the size limit set in settings.'],
  info: ['Missing author', 'No author could be read from the file name.'],
  broken: ["Won't open", 'PDFs the text reader could not open.'],
};

function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: today.getFullYear() === d.getFullYear() ? undefined : 'numeric' });
}

class ReferenceDeskView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.renderTimer = 0; this.seq = 0; }
  getViewType() { return VIEW_DESK; }
  getDisplayText() { return 'Reference desk'; }
  getIcon() { return 'book-open-text'; }

  async onOpen() {
    const root = this.contentEl, p = this.plugin;
    root.empty(); root.addClass('lr-desk');
    const bar = root.createDiv('lr-desk-bar');
    bar.createDiv({ cls: 'lr-desk-ghost', text: 'REFERENCE' });
    const brand = bar.createDiv('lr-desk-brand');
    setIcon(brand, 'book-open-text');
    const nav = bar.createDiv('lr-desk-nav');
    const link = (text, fn) => { const a = nav.createEl('a', { text }); a.addEventListener('click', fn); return a; };
    link('Library', () => p.focusLibrary());
    link('Text search', () => p.openTextSearch());
    link('Noted', () => p.focusLibrary('noted'));
    const form = bar.createDiv('lr-desk-search');
    this.q = form.createEl('input', { type: 'search', attr: { placeholder: 'Search the catalogue', spellcheck: 'false' } });
    const go = form.createEl('button', { attr: { 'aria-label': 'Search' } });
    setIcon(go, 'search');
    const run = () => { const q = this.q.value.trim(); if (q) p.searchLibrary(q); };
    this.q.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    go.addEventListener('click', run);
    bar.createDiv('lr-sp');
    this.count = bar.createDiv('lr-desk-count');

    const cols = root.createDiv('lr-desk-cols');
    this.main = cols.createDiv('lr-desk-main');
    const side = cols.createDiv('lr-desk-side');
    const links = side.createDiv('lr-desk-links');
    const hl = (text, fn) => { const a = links.createEl('a', { cls: 'lr-desk-hl', text }); a.addEventListener('click', fn); return a; };
    hl('new requests', () => p.openRequests());
    links.appendText(' | ');
    hl('export fixes', () => p.exportFixes());
    const add = side.createDiv('lr-desk-add');
    this.req = add.createEl('input', { type: 'text', attr: { placeholder: 'Request a book: author, title…' } });
    this.req.addEventListener('keydown', async e => {
      if (e.key !== 'Enter' || !this.req.value.trim()) return;
      e.preventDefault();
      await p.addRequest(this.req.value.trim());
      this.req.value = '';
    });
    this.sideBody = side.createDiv();
    this.unsub = p.textIndex.onChange(() => this.schedule(3000));
    this.render();
  }
  async onClose() { clearTimeout(this.renderTimer); if (this.unsub) this.unsub(); }

  schedule(ms = 300) {
    if (this.renderTimer) return;
    this.renderTimer = window.setTimeout(() => { this.renderTimer = 0; this.render(); }, ms);
  }

  entry(parent, it, when) {
    const p = this.plugin;
    const row = parent.createDiv('lr-desk-entry');
    const head = row.createDiv('lr-desk-head');
    const t = head.createEl('a', { cls: 'lr-desk-title', text: it.t, attr: { title: it.p } });
    if (p.notedSet.has(it.p)) t.addClass('lr-noted');
    if (p.pins[it.p]) t.addClass('lr-pin');
    t.addEventListener('click', e => p.openItem(it, e.shiftKey || e.ctrlKey || e.metaKey));
    t.addEventListener('contextmenu', e => { e.preventDefault(); p.itemMenu(it).showAtMouseEvent(e); });
    const by = [it.a, it.y].filter(Boolean).join(', ');
    if (by) head.createSpan({ cls: 'lr-desk-by', text: ' ' + by });
    const desc = row.createDiv('lr-desk-desc');
    const meta = [it.f, fmtSize(it.s), it.e !== 'pdf' ? it.e.toUpperCase() : '', when].filter(Boolean).join(' · ');
    desc.setText(meta); desc.addClass('lr-desk-meta');
    p.describe(it).then(d => {
      if (!d || !desc.isConnected) return;
      desc.removeClass('lr-desk-meta'); desc.setText(d); desc.title = meta;
    });
  }
  section(parent, label, items, stampOf) {
    parent.createDiv({ cls: 'lr-desk-dots', text: '.....' });
    parent.createDiv({ cls: 'lr-desk-section', text: label });
    if (!items.length) { parent.createDiv({ cls: 'lr-note', text: 'Nothing yet.' }); return; }
    let last = '';
    for (const [it, ts] of items) {
      const lab = dayLabel(ts);
      if (lab !== last) { parent.createDiv({ cls: 'lr-desk-day', text: lab }); last = lab; }
      this.entry(parent, it, stampOf ? stampOf(ts) : '');
    }
  }

  async render() {
    if (!this.main) return;
    const p = this.plugin, seq = ++this.seq;
    const top = this.contentEl.scrollTop;
    this.count.setText(p.catalog.length ? `${p.catalog.length.toLocaleString()} items` : 'Loading…');

    // left: newest added, then last opened
    const main = createDiv();
    const newest = p.catalog.filter(it => DOC_EXT.has(it.e)).sort((a, b) => b.c - a.c).slice(0, DESK_ROWS).map(it => [it, it.c]);
    this.section(main, 'newest', newest);
    const opened = p.recent.map(([rel, ts]) => [p.byPath.get(rel), ts]).filter(x => x[0]).slice(0, DESK_ROWS);
    this.section(main, 'recently opened', opened, ts => 'opened ' + clock(new Date(ts)));

    // right: last annotations, then books needing fixes
    const side = createDiv();
    const reqs = await p.openRequests(true);
    if (seq !== this.seq) return;
    if (reqs.length) {
      const box = side.createDiv('lr-desk-box');
      box.createDiv({ cls: 'lr-desk-boxhead', text: `Requests (${reqs.length})` });
      for (const r of reqs.slice(0, 5)) box.createDiv({ cls: 'lr-desk-item lr-desk-small', text: r });
      if (reqs.length > 5) box.createDiv({ cls: 'lr-desk-more', text: `${reqs.length - 5} more in the requests file` });
    }

    side.createDiv({ cls: 'lr-desk-label', text: 'Recent annotations' });
    const notes = side.createDiv('lr-desk-box');
    const anns = p.recentAnnotations(3);
    if (!anns.length) notes.createDiv({ cls: 'lr-desk-item lr-desk-small', text: 'No notes yet. Open a book and press Alt+N.' });
    for (const a of anns) {
      const it = p.byPath.get(a.rel);
      const el = notes.createDiv('lr-desk-item lr-desk-click');
      el.createDiv({ cls: 'lr-desk-ann-t', text: it ? it.t : a.rel.split('/').pop() });
      el.createDiv({ cls: 'lr-desk-small', text: (a.when ? a.when + ' · ' : '') + a.text });
      el.addEventListener('click', async () => { if (it) { await p.openItem(it, false); p.toggleNotes(true); } });
    }

    const fixes = await p.problems();
    if (seq !== this.seq) return;
    const label = side.createDiv('lr-desk-label');
    label.setText('Needs fixing');
    const exp = label.createEl('button', { text: 'Export', attr: { title: 'Write every book needing a fix to one Markdown file' } });
    exp.addEventListener('click', () => p.exportFixes());
    const fixBox = side.createDiv('lr-desk-box');
    let any = false;
    for (const [key, [name]] of Object.entries(FIX_LABELS)) {
      const list = fixes.cats[key];
      if (!list.length) continue;
      any = true;
      const grp = fixBox.createDiv('lr-desk-item');
      grp.createDiv({ cls: 'lr-desk-fixhead', text: `${name} (${list.length.toLocaleString()})` });
      for (const it of list.slice(0, 6)) {
        const a = grp.createEl('a', { cls: 'lr-desk-fix', text: it.a ? `${it.t} — ${it.a}` : it.t, attr: { title: it.p + ' · ' + fmtSize(it.s) } });
        a.addEventListener('click', () => p.openItem(it, false));
        a.addEventListener('contextmenu', e => { e.preventDefault(); p.itemMenu(it).showAtMouseEvent(e); });
      }
      if (list.length > 6) grp.createDiv({ cls: 'lr-desk-more', text: `${(list.length - 6).toLocaleString()} more — export for the full list` });
    }
    if (!any) fixBox.createDiv({ cls: 'lr-desk-item lr-desk-small', text: 'Nothing flagged.' });
    if (fixes.unchecked) fixBox.createDiv({ cls: 'lr-desk-item lr-desk-small', text:
      `${fixes.unchecked.toLocaleString()} PDFs not yet checked for a text layer. Build the text index (Text search → Whole library) to check them.` });

    if (seq !== this.seq) return;
    this.main.replaceChildren(...main.childNodes);
    this.sideBody.replaceChildren(...side.childNodes);
    this.contentEl.scrollTop = top;
  }
}

// ================================================================ settings
class LibrarySettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  /** A number box that saves only valid values in [min, max]. */
  num(el, name, desc, key, min, max, after) {
    const p = this.plugin;
    return new Setting(el).setName(name).setDesc(desc).addText(t => {
      t.inputEl.type = 'number'; t.inputEl.addClass('lr-num');
      t.setPlaceholder(String(DEFAULT_SETTINGS[key])).setValue(String(p.settings[key])).onChange(async v => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < min || n > max) return;
        p.settings[key] = n; await p.saveState(); if (after) after();
      });
    });
  }
  /** A text box with a reset button back to the default. */
  text(el, name, desc, key, after) {
    const p = this.plugin;
    let input;
    return new Setting(el).setName(name).setDesc(desc)
      .addText(t => { input = t; t.setPlaceholder(DEFAULT_SETTINGS[key] || 'Theme default').setValue(p.settings[key]).onChange(async v => {
        p.settings[key] = v; await p.saveState(); if (after) after();
      }); })
      .addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Reset').onClick(async () => {
        p.settings[key] = DEFAULT_SETTINGS[key]; input.setValue(p.settings[key]); await p.saveState(); if (after) after();
      }));
  }
  /** A colour picker; reset means "follow the Obsidian theme". */
  color(el, name, desc, key) {
    const p = this.plugin;
    const s = new Setting(el).setName(name).setDesc(desc + (p.settings[key] ? '' : ' Now following the theme.'));
    s.addColorPicker(c => c.setValue(p.settings[key] || p.themeColor(key)).onChange(async v => {
      p.settings[key] = v; await p.saveState(); p.applyStyle();
    }));
    s.addExtraButton(b => b.setIcon('rotate-ccw').setTooltip('Follow the theme').onClick(async () => {
      p.settings[key] = ''; await p.saveState(); p.applyStyle(); this.display();
    }));
    return s;
  }
  display() {
    const { containerEl } = this, p = this.plugin;
    const style = () => p.applyStyle();
    const lists = () => p.refreshLists();
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Library' });
    new Setting(containerEl).setName('Notes folder')
      .setDesc(`Where '<book>.notes.md' files live, mirroring the library's folders. Empty uses LIBRARY_NOTES or the 'Notes' folder beside the vault. Now: ${p.notesRoot()}`)
      .addText(t => t.setPlaceholder(p.defaultNotesRoot()).setValue(p.settings.notesFolder).onChange(async v => {
        p.settings.notesFolder = v.trim(); await p.saveState(); p.refreshNoted();
      }));
    new Setting(containerEl).setName('Folders left out of the library')
      .setDesc('Vault folders that are not books, one per line.')
      .addTextArea(t => t.setValue(p.settings.excludeFolders).onChange(async v => {
        p.settings.excludeFolders = v; await p.saveState(); p.buildCatalog();
      }));
    this.num(containerEl, 'Rows shown', 'Search, Pinned, Recent and Noted show at most this many (Folders shows everything).', 'listCap', 10, 100000, lists);
    this.num(containerEl, 'Books kept in Recent', 'Older ones drop off the list.', 'recentMax', 10, 5000);
    this.num(containerEl, 'Recent books under an empty search', '0 shows nothing until you type.', 'recentOnEmpty', 0, 1000, lists);
    new Setting(containerEl).setName('Open the panels on start')
      .setDesc('Put Library in the left sidebar and Book notes in the right if they were closed.')
      .addToggle(t => t.setValue(p.settings.openPanelsOnStart).onChange(async v => { p.settings.openPanelsOnStart = v; await p.saveState(); }));

    containerEl.createEl('h3', { text: 'Notes' });
    this.num(containerEl, 'Autosave delay (ms)', 'Save this long after typing stops.', 'autosaveMs', 200, 60000);
    this.text(containerEl, 'Page reference (Alt+G)', 'Inserted text; {page} becomes the current page. With no page known, only the part before {page} is inserted.', 'pageRef');
    new Setting(containerEl).setName('Monospace notes')
      .setDesc('Same as the Aa button or Alt+M in the notes pane.')
      .addToggle(t => t.setValue(p.settings.mono).onChange(async v => {
        p.settings.mono = v; await p.saveState(); p.notesView()?.toggleMono(v);
      }));

    containerEl.createEl('h3', { text: 'Text search' });
    this.num(containerEl, 'Result cap', 'Hits listed; the rest are counted as "N more".', 'searchCap', 1, 100000);
    this.num(containerEl, 'Words of context', 'Words shown on each side of a hit.', 'contextWords', 1, 200);
    this.num(containerEl, 'Largest PDF to index (MB)', 'Bigger files are skipped by the text index (they are usually scans).', 'maxIndexMB', 1, 100000);
    const stat = new Setting(containerEl).setName('Library text index');
    p.textIndex.loadMeta().then(() => {
      const s = p.textIndex.stats();
      stat.setDesc(`${s.done.toLocaleString()} of ${s.total.toLocaleString()} PDFs indexed, ${s.noText} without text, ${s.errors} unreadable.`);
    });
    stat.addButton(b => b.setButtonText(p.textIndex.building ? 'Pause' : 'Build / resume').onClick(() => {
      if (p.textIndex.building) p.textIndex.stop(); else p.textIndex.build();
      this.display();
    }));
    stat.addButton(b => b.setButtonText('Clear index').setWarning().onClick(async () => {
      await p.textIndex.clear(); this.display();
    }));

    containerEl.createEl('h3', { text: 'Reference desk' });
    new Setting(containerEl).setName('Open the reference desk on start')
      .setDesc('Opens the desk as a tab when Obsidian starts, if none is open. Alt+D opens it any time.')
      .addToggle(t => t.setValue(p.settings.deskOnStart).onChange(async v => { p.settings.deskOnStart = v; await p.saveState(); }));
    this.text(containerEl, 'Requests file', 'Vault path of the running list of books to get. It is left out of the catalogue.', 'requestsFile', () => { p.buildCatalog(); });
    this.text(containerEl, 'Fixes file', 'Vault path that "Export fixes" writes (replaced on each export). It is left out of the catalogue.', 'fixesFile', () => { p.buildCatalog(); });
    this.num(containerEl, 'Too large above (MB)', 'Books bigger than this are listed as needing a fix.', 'largeMB', 1, 100000, () => p.refreshDesk());

    containerEl.createEl('h3', { text: 'Web reference' });
    this.text(containerEl, 'Web reference address', 'A web page the "Open Rogetta" command (Alt+R) shows in the right sidebar. Rogetta by default; any dictionary, thesaurus or translation page works. An open web tab at this address is reused.', 'rogettaUrl');

    containerEl.createEl('h3', { text: 'Appearance' });
    containerEl.createEl('p', { cls: 'setting-item-description', text: 'Fonts take any CSS font list, e.g. "Gowun Dodum", Georgia, serif. Reset (↺) returns a setting to its default; colours reset to follow the Obsidian theme.' });
    this.text(containerEl, 'Book title font', 'Titles in the library list, notes header and search groups.', 'titleFont', style);
    this.text(containerEl, 'Interface font', 'Authors, folders, buttons and counts. Empty = Obsidian\'s interface font.', 'uiFont', style);
    this.text(containerEl, 'Notes font', 'The notes editor in serif mode.', 'notesFont', style);
    this.text(containerEl, 'Notes monospace font', 'The notes editor in monospace mode. Empty = Obsidian\'s monospace font.', 'monoFont', style);
    this.num(containerEl, 'Book title size (px)', '', 'titleSize', 8, 40, style);
    this.num(containerEl, 'Details size (px)', 'Author, year, folder and size under each title.', 'metaSize', 8, 30, style);
    this.num(containerEl, 'Notes text size (px)', '', 'notesSize', 8, 40, style);
    this.num(containerEl, 'Notes line height', 'e.g. 1.55', 'notesLineHeight', 1, 3, style);
    new Setting(containerEl).setName('Row spacing')
      .addDropdown(d => d.addOptions({ compact: 'Compact', normal: 'Normal', roomy: 'Roomy' }).setValue(p.settings.rowSpacing).onChange(async v => {
        p.settings.rowSpacing = v; await p.saveState(); style();
      }));
    this.color(containerEl, 'Accent colour', 'Selected row, active tab, ✎ marks, page numbers.', 'accentColor');
    this.color(containerEl, 'Pin colour', 'The ★ on pinned books.', 'pinColor');
    this.color(containerEl, 'Search highlight', 'Behind the matched words in text search.', 'hitColor');
    this.color(containerEl, 'Notes background', 'Paper colour of the notes editor.', 'notesBackground');
    new Setting(containerEl).setName('Reset all appearance settings')
      .addButton(b => b.setButtonText('Reset').onClick(async () => {
        for (const k of ['titleFont', 'uiFont', 'notesFont', 'monoFont', 'titleSize', 'metaSize', 'notesSize', 'notesLineHeight', 'rowSpacing', 'accentColor', 'pinColor', 'hitColor', 'notesBackground'])
          p.settings[k] = DEFAULT_SETTINGS[k];
        await p.saveState(); style(); this.display();
      }));
  }
}

// ================================================================ plugin
module.exports = class LibraryReader extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    this.pins = data.pins || {};             // path -> added (ms)
    this.recent = data.recent || [];         // [[path, opened ms], ...] newest first
    this.ui = data.ui || {};
    this.currentBook = data.currentBook || null;
    this.descCache = data.descCache || {};   // path -> { s, m, d } descriptions read from PDF metadata
    this.catalog = []; this.byPath = new Map(); this._tree = null; this.scannedAt = null;
    this.noted = []; this.notedSet = new Set();
    this.readerLeaf = null;

    this.notes = new NotesStore(this);
    this.textIndex = new TextIndex(this);
    this.applyStyle();

    this.registerView(VIEW_LIBRARY, leaf => new LibraryView(leaf, this));
    this.registerView(VIEW_NOTES, leaf => new NotesView(leaf, this));
    this.registerView(VIEW_SEARCH, leaf => new TextSearchView(leaf, this));
    this.registerView(VIEW_DESK, leaf => new ReferenceDeskView(leaf, this));
    this.addSettingTab(new LibrarySettingTab(this.app, this));
    this.addRibbonIcon('library', 'Library', () => this.focusLibrary());
    this.addRibbonIcon('book-open-text', 'Reference desk', () => this.openDesk());
    this.addCommand({ id: 'open-desk', name: 'Open the reference desk', hotkeys: [{ modifiers: ['Alt'], key: 'd' }], callback: () => this.openDesk() });
    this.addCommand({ id: 'export-fixes', name: 'Export the list of books needing fixes', callback: () => this.exportFixes() });
    this.addCommand({ id: 'open-requests', name: 'Open the book requests list', callback: () => this.openRequests() });

    this.addCommand({ id: 'focus-library', name: 'Focus the library search', hotkeys: [{ modifiers: ['Alt'], key: 'l' }], callback: () => this.focusLibrary() });
    this.addCommand({ id: 'toggle-notes', name: 'Swap between the book and its notes', hotkeys: [{ modifiers: ['Alt'], key: 'n' }], callback: () => this.toggleNotes() });
    this.addCommand({ id: 'text-search', name: 'Text search in this book or the library', hotkeys: [{ modifiers: ['Alt'], key: 'f' }], callback: () => this.openTextSearch() });
    this.addCommand({ id: 'open-rogetta', name: 'Open Rogetta (web reference)', hotkeys: [{ modifiers: ['Alt'], key: 'r' }], callback: () => this.toggleRogetta() });
    this.addCommand({ id: 'toggle-pin', name: 'Pin or unpin the current book', callback: () => this.togglePin(this.currentItem()) });
    this.addCommand({ id: 'open-external', name: 'Open the current book in the default program', callback: () => this.currentBook && this.openExternal(this.currentBook) });
    this.addCommand({ id: 'rescan', name: 'Rescan the library', callback: () => { this.buildCatalog(); this.refreshNoted(); } });
    this.addCommand({ id: 'build-index', name: 'Build or resume the library text index', callback: () => this.textIndex.build() });
    this.addCommand({ id: 'pause-index', name: 'Pause the library text index build', callback: () => this.textIndex.stop() });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const it = file && this.byPath.get(file.path);
      if (!it) return;
      menu.addItem(i => i.setTitle(this.pins[it.p] ? 'Unpin from library' : 'Pin in library').setIcon('star').onClick(() => this.togglePin(it)));
      menu.addItem(i => i.setTitle('Book notes').setIcon('pencil').onClick(async () => { await this.openItem(it, false); this.toggleNotes(true); }));
    }));
    this.registerEvent(this.app.workspace.on('file-open', file => { if (file && this.byPath.has(file.path)) this.bookOpened(file.path); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      const f = leaf && leaf.view && leaf.view.file;
      if (f && this.byPath.has(f.path) && leaf.getRoot() === this.app.workspace.rootSplit) { this.readerLeaf = leaf; this.setCurrentBook(f.path); }
    }));
    // Notes may be written elsewhere (Obsidian, another copy): refresh ✎ marks and the editor on focus.
    this.registerDomEvent(window, 'focus', () => { this.refreshNoted(); this.notesView()?.refresh(); this.refreshDesk(); });
    this.registerDomEvent(window, 'beforeunload', () => this.notesView()?.save());

    this.app.workspace.onLayoutReady(async () => {
      this.buildCatalog();
      this.refreshNoted();
      const rebuild = obsidian.debounce(() => this.buildCatalog(), 1500, true);
      this.registerEvent(this.app.vault.on('create', rebuild));
      this.registerEvent(this.app.vault.on('delete', rebuild));
      this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { this.followRename(file, oldPath); rebuild(); }));
      this.registerEvent(this.app.vault.on('modify', file => { if (file.path === this.requestsPath()) this.refreshDesk(); }));
      if (this.settings.deskOnStart && !this.app.workspace.getLeavesOfType(VIEW_DESK).length)
        await this.app.workspace.getLeaf('tab').setViewState({ type: VIEW_DESK, active: false });
      if (this.settings.openPanelsOnStart && !this.app.workspace.getLeavesOfType(VIEW_LIBRARY).length) {
        const leaf = this.app.workspace.getLeftLeaf(false);
        if (leaf) await leaf.setViewState({ type: VIEW_LIBRARY, active: true });
      }
      if (this.settings.openPanelsOnStart && !this.app.workspace.getLeavesOfType(VIEW_NOTES).length) {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf) await leaf.setViewState({ type: VIEW_NOTES, active: false });
      }
      if (this.settings.indexing) this.textIndex.build();
    });
  }

  onunload() {
    try { this.notesView()?.save(); } catch (e) { console.error(e); }
    this.textIndex.stop(false);
    for (const k of STYLE_VARS) document.body.style.removeProperty(k);
  }

  // ------------------------------------------------------------ appearance
  /** Settings -> CSS variables on <body>; styles.css falls back to theme values when one is unset. */
  applyStyle() {
    const s = this.settings, b = document.body.style;
    const set = (k, v) => (v === '' || v == null ? b.removeProperty(k) : b.setProperty(k, String(v)));
    set('--lr-title-font', s.titleFont);
    set('--lr-ui-font', s.uiFont);
    set('--lr-notes-font', s.notesFont);
    set('--lr-mono-font', s.monoFont);
    set('--lr-title-size', s.titleSize ? s.titleSize + 'px' : '');
    set('--lr-meta-size', s.metaSize ? s.metaSize + 'px' : '');
    set('--lr-notes-size', s.notesSize ? s.notesSize + 'px' : '');
    set('--lr-notes-lh', s.notesLineHeight || '');
    set('--lr-row-pad', ROW_PAD[s.rowSpacing] || ROW_PAD.normal);
    set('--lr-accent', s.accentColor);
    set('--lr-pin', s.pinColor);
    set('--lr-hit', s.hitColor);
    set('--lr-notes-bg', s.notesBackground);
  }
  /** The theme's current value for a colour setting, as #rrggbb for the colour picker. */
  themeColor(key) {
    const v = { accentColor: 'var(--color-accent)', pinColor: 'var(--color-orange)', hitColor: 'var(--text-highlight-bg)', notesBackground: 'var(--background-primary)' }[key];
    const el = document.body.createDiv();
    el.style.color = v;
    const rgb = getComputedStyle(el).color.match(/[\d.]+/g) || ['0', '0', '0'];
    el.remove();
    return '#' + rgb.slice(0, 3).map(n => Math.round(+n).toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------ web reference
  /** Alt+R: show the web reference tab (reusing an open one); pressed again there, back to the book. */
  async toggleRogetta() {
    const url = (this.settings.rogettaUrl || '').trim();
    if (!url) { new Notice('Set the web reference address in Settings → Library Reader first.'); return; }
    const ws = this.app.workspace;
    const key = u => String(u || '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
    const leaf = ws.getLeavesOfType('webviewer').find(l => {
      const st = l.getViewState().state || {};
      return key(st.url).startsWith(key(url)) || key(l.view && l.view.url).startsWith(key(url));
    });
    if (leaf && ws.activeLeaf === leaf) { if (!this.focusBook()) this.focusLibrary(); return; }
    let target = leaf;
    if (!target) {
      target = ws.getRightLeaf(false);
      try { await target.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } }); }
      catch (e) { new Notice('Could not open the web reference: is the Web viewer core plugin on?'); return; }
    }
    await ws.revealLeaf(target);
    ws.setActiveLeaf(target, { focus: true });
  }

  // ------------------------------------------------------------ reference desk
  requestsPath() { return obsidian.normalizePath(this.settings.requestsFile || DEFAULT_SETTINGS.requestsFile); }
  fixesPath() { return obsidian.normalizePath(this.settings.fixesFile || DEFAULT_SETTINGS.fixesFile); }
  deskViews() { return this.app.workspace.getLeavesOfType(VIEW_DESK).map(l => l.view).filter(v => v instanceof ReferenceDeskView); }
  refreshDesk() { for (const v of this.deskViews()) v.schedule(); }
  async openDesk() {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_DESK)[0];
    if (!leaf) { leaf = ws.getLeaf('tab'); await leaf.setViewState({ type: VIEW_DESK, active: true }); }
    await ws.revealLeaf(leaf);
    ws.setActiveLeaf(leaf, { focus: true });
    if (leaf.view instanceof ReferenceDeskView) leaf.view.render();
  }
  async searchLibrary(q) {
    await this.focusLibrary();
    const v = this.libraryViews()[0];
    if (!v) return;
    if (v.mode !== 'search') v.setMode('search', false);
    v.q.value = q; v.sel = 0; v.build(); v.q.focus();
  }

  /** A short description: 'description' in the book's notes frontmatter, else the PDF's Subject. */
  async describe(it) {
    if (this.notedSet.has(it.p)) {
      try {
        const d = fmGet(splitNote(readText(this.notes.noteFile(it.p)))[0], 'description');
        if (d && String(d).trim()) return String(d).trim();
      } catch (_) { /* no notes file */ }
    }
    if (it.e !== 'pdf') return null;
    const c = this.descCache[it.p];
    if (c && c.s === it.s && c.m === it.m) return c.d;
    let d = null;
    try {
      const md = await this.pdfMetadata(it);
      const good = s => typeof s === 'string' && s.replace(/\s+/g, ' ').trim().length >= 20 && norm(s).trim() !== norm(it.t).trim() && !/^(untitled|unknown|scan|microsoft word)/i.test(s.trim());
      const info = (md && md.info) || {};
      let xmp = null;
      try { xmp = md && md.metadata && md.metadata.get('dc:description'); } catch (_) { /* no XMP */ }
      d = [info.Subject, xmp].find(good) || null;
      if (d) { d = d.replace(/\s+/g, ' ').trim(); if (d.length > 420) d = d.slice(0, 417).replace(/\s+\S*$/, '') + '…'; }
    } catch (_) { d = null; }
    this.descCache[it.p] = { s: it.s, m: it.m, d };
    clearTimeout(this.descSave); this.descSave = setTimeout(() => this.saveState(), 2000);
    return d;
  }
  /** PDF metadata read with ranged reads, so even a 500 MB scan costs a few small reads. */
  async pdfMetadata(it) {
    const pdfjs = await obsidian.loadPdfJs();
    const full = this.notes.libFile(it.p);
    const fh = await fsp.open(full, 'r');
    let task = null;
    try {
      const len = (await fh.stat()).size;
      const first = Buffer.alloc(Math.min(len, 65536));
      await fh.read(first, 0, first.length, 0);
      const tr = new pdfjs.PDFDataRangeTransport(len, new Uint8Array(first));
      tr.requestDataRange = (begin, end) => {
        const buf = Buffer.alloc(end - begin);
        fh.read(buf, 0, buf.length, begin).then(() => tr.onDataRange(begin, new Uint8Array(buf))).catch(() => { /* closed */ });
      };
      task = pdfjs.getDocument({ range: tr, length: len, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536, verbosity: 0, isEvalSupported: false });
      const doc = await withTimeout(task.promise, 20000, 'Opening the PDF');
      return await withTimeout(doc.getMetadata(), 10000, 'Reading metadata');
    } finally {
      if (task) { try { await task.destroy(); } catch (_) { /* ignore */ } }
      await fh.close();
    }
  }

  /** The newest dated sections across all notes files: [{ rel, when, ts, text }]. */
  recentAnnotations(n) {
    const out = [];
    for (const rel of this.noted.slice(0, 25)) {
      const nf = this.notes.noteFile(rel);
      let body, mt;
      try { body = splitNote(readText(nf))[1]; mt = fs.statSync(nf).mtimeMs; } catch (_) { continue; }
      const parts = body.split(/^## (\d{4}-\d{2}-\d{2})(?: (\d{1,2}:\d{2}))?[^\n]*$/m);
      const add = (txt, ts, when) => {
        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return;
        let text = lines.slice(0, 3).join(' ');
        if (text.length > 220) text = text.slice(0, 217).replace(/\s+\S*$/, '') + '…';
        out.push({ rel, ts, when, text });
      };
      if (parts.length === 1) { add(body, mt, ''); continue; }
      for (let i = 1; i < parts.length; i += 3) {
        const d = parts[i], t = parts[i + 1] || '';
        const ts = Date.parse(d + 'T' + (t ? t.padStart(5, '0') : '00:00')) || mt;
        add(parts[i + 2] || '', ts, t ? `${d} ${t}` : d);
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, n);
  }

  /** Books needing a fix, by kind. OCR and "won't open" come from the text index. */
  async problems() {
    const ti = this.textIndex;
    try { await ti.loadMeta(); } catch (_) { ti.meta = ti.meta || new Map(); }
    const large = Math.max(1, this.settings.largeMB || 100) * 1048576;
    const cats = { ocr: [], large: [], info: [], broken: [] };
    let unchecked = 0;
    for (const it of this.catalog) {
      if (!DOC_EXT.has(it.e)) continue;
      if (!it.a) cats.info.push(it);
      if (it.s > large) cats.large.push(it);
      if (it.e === 'pdf') {
        const m = ti.fresh(it) ? ti.meta.get(it.p) : null;
        if (!m || (m.error && /^larger than/.test(m.error))) unchecked++;
        else if (m.noText) cats.ocr.push(it);
        else if (m.error) cats.broken.push(it);
      }
    }
    cats.large.sort((a, b) => b.s - a.s);
    for (const k of ['ocr', 'info', 'broken']) cats[k].sort((a, b) => collator.compare(a.p, b.p));
    return { cats, unchecked };
  }
  async exportFixes() {
    const { cats, unchecked } = await this.problems();
    const root = this.libRoot();
    const total = new Set(Object.values(cats).flat().map(it => it.p)).size;
    let md = `# Library fixes\n\nGenerated ${day()} ${clock()} · ${total.toLocaleString()} books need attention.\n`;
    if (unchecked) md += `\n${unchecked.toLocaleString()} PDFs have not been checked for a text layer yet (build the text index to check them).\n`;
    for (const [key, [name, desc]] of Object.entries(FIX_LABELS)) {
      const list = cats[key];
      md += `\n## ${name} (${list.length.toLocaleString()})\n\n${desc}\n\n`;
      if (!list.length) { md += 'None.\n'; continue; }
      for (const it of list) md += `- [ ] ${it.a ? it.a + ' — ' : ''}${it.t}${it.y ? ' (' + it.y + ')' : ''} · \`${it.p}\` · ${fmtSize(it.s)}\n`;
      md += '\nFull paths, one per line:\n\n```text\n' + list.map(it => path.join(root, ...it.p.split('/'))).join('\n') + '\n```\n';
    }
    const fp = this.fixesPath();
    await this.writeVaultFile(fp, md);
    await this.showVaultFile(fp);
    new Notice(`Library: ${total.toLocaleString()} books needing fixes written to ${fp}`);
  }
  /** Show a vault file in its existing tab if it has one, else in a new tab. */
  async showVaultFile(fp) {
    const f = this.app.vault.getAbstractFileByPath(fp);
    if (!f) return;
    let leaf = null;
    this.app.workspace.iterateRootLeaves(l => { if (!leaf && l.view && l.view.file === f) leaf = l; });
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(f); }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  async writeVaultFile(fp, text) {
    const vault = this.app.vault;
    const f = vault.getAbstractFileByPath(fp);
    if (f) { await vault.modify(f, text); return; }
    const dir = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : '';
    if (dir && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
    await vault.create(fp, text);
  }
  /** Open the requests file, or with listOnly return its unticked items. */
  async openRequests(listOnly = false) {
    const fp = this.requestsPath();
    let f = this.app.vault.getAbstractFileByPath(fp);
    if (listOnly) {
      if (!f) return [];
      const txt = await this.app.vault.cachedRead(f);
      return txt.split('\n').map(l => /^\s*[-*] \[ \]\s+(.+)$/.exec(l)).filter(Boolean).map(m => m[1].trim());
    }
    if (!f) await this.writeVaultFile(fp, '# New requests\n\nBooks to get. Tick them off when they are in the library.\n\n');
    await this.showVaultFile(fp);
    return [];
  }
  async addRequest(text) {
    const fp = this.requestsPath();
    const line = `- [ ] ${text.replace(/\s+/g, ' ')} (added ${day()})\n`;
    const f = this.app.vault.getAbstractFileByPath(fp);
    if (f) await this.app.vault.process(f, d => (d && !d.endsWith('\n') ? d + '\n' : d) + line);
    else await this.writeVaultFile(fp, '# New requests\n\nBooks to get. Tick them off when they are in the library.\n\n' + line);
    new Notice('Added to requests.');
    this.refreshDesk();
  }

  // ------------------------------------------------------------ state
  saveState() {
    return this.saveData({ settings: this.settings, pins: this.pins, recent: this.recent, ui: this.ui, currentBook: this.currentBook, descCache: this.descCache });
  }
  saveUi(ui) { this.ui = ui; this.saveState(); }
  libRoot() { return this.app.vault.adapter.getBasePath(); }
  defaultNotesRoot() { return process.env.LIBRARY_NOTES || path.join(path.dirname(this.libRoot()), 'Notes'); }
  notesRoot() { return this.settings.notesFolder || this.defaultNotesRoot(); }

  // ------------------------------------------------------------ catalogue
  buildCatalog() {
    const t0 = Date.now();
    const excl = this.settings.excludeFolders.split(/\r?\n/).map(s => s.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
    const notesRel = NotesStore.inside(this.libRoot(), this.notesRoot()) ? path.relative(this.libRoot(), this.notesRoot()).replace(/\\/g, '/') : null;
    if (notesRel) excl.push(notesRel);
    const own = new Set([this.requestsPath(), this.fixesPath()]);   // the desk's own files are not books
    const out = [];
    for (const f of this.app.vault.getFiles()) {
      if (SKIP_NAME.test(f.name) || f.name.startsWith('~$') || own.has(f.path)) continue;
      if (f.path.split('/').some(part => part.startsWith('.'))) continue;
      if (excl.some(x => f.path === x || f.path.startsWith(x + '/'))) continue;
      out.push(makeItem(f));
    }
    out.sort((x, y) => collator.compare(x.a || '\uffff', y.a || '\uffff') || collator.compare(x.t, y.t) || collator.compare(x.p, y.p));
    this.catalog = out;
    this.byPath = new Map(out.map(it => [it.p, it]));
    this._tree = null;
    this.scannedAt = new Date();
    console.log(`Library Reader: ${out.length} items in ${Date.now() - t0} ms`);
    for (const v of this.libraryViews()) { v.updateStatus(); v.build(true); }
    this.refreshDesk();
  }
  tree() {
    if (this._tree) return this._tree;
    const root = { dirs: new Map(), files: [], n: 0 };
    for (const it of this.catalog) {
      let node = root; node.n++;
      if (it.f) for (const part of it.f.split('/')) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], n: 0 });
        node = node.dirs.get(part); node.n++;
      }
      node.files.push(it);
    }
    return (this._tree = root);
  }
  nodeAt(p) {
    let node = this.tree();
    if (p) for (const part of p.split('/')) { node = node.dirs.get(part); if (!node) return null; }
    return node;
  }
  refreshNoted() {
    try { this.noted = this.notes.listNoted(); } catch (_) { this.noted = []; }
    this.notedSet = new Set(this.noted);
    this.refreshLists();
    this.refreshDesk();
  }
  refreshLists() { for (const v of this.libraryViews()) v.build(true); }

  // ------------------------------------------------------------ views
  libraryViews() { return this.app.workspace.getLeavesOfType(VIEW_LIBRARY).map(l => l.view).filter(v => v instanceof LibraryView); }
  notesView() { const l = this.app.workspace.getLeavesOfType(VIEW_NOTES)[0]; return l && l.view instanceof NotesView ? l.view : null; }
  async ensureLeaf(type, side) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = side === 'left' ? this.app.workspace.getLeftLeaf(false) : this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  async focusLibrary(mode) {
    const leaf = await this.ensureLeaf(VIEW_LIBRARY, 'left');
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf.view instanceof LibraryView) { if (mode) leaf.view.setMode(mode); leaf.view.focusSearch(); }
  }
  async openTextSearch() {
    const sel = window.getSelection().toString().trim();
    const leaf = await this.ensureLeaf(VIEW_SEARCH, 'right');
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const v = leaf.view;
    if (v instanceof TextSearchView) {
      if (sel && sel.length < 200) { v.q.value = sel; v.schedule(true); }
      v.focusInput();
    }
  }
  /** Alt+N: from the book (or anywhere) to its notes; from the notes back to the book. */
  async toggleNotes(forceNotes = false) {
    const nv = this.notesView();
    const inNotes = nv && nv.contentEl.contains(document.activeElement);
    if (inNotes && !forceNotes) { nv.save(); this.focusBook() || this.focusLibrary(); return; }
    if (!this.currentBook) { new Notice('Open a book first, then Alt+N for its notes.'); return; }
    const leaf = await this.ensureLeaf(VIEW_NOTES, 'right');
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    if (leaf.view instanceof NotesView) leaf.view.load(this.currentBook, { focus: true });
  }
  bookLeaf(rel = this.currentBook) {
    const alive = l => l && l.view && l.view.file && l.view.file.path === rel && l.getRoot() === this.app.workspace.rootSplit;
    if (alive(this.readerLeaf)) return this.readerLeaf;
    let found = null;
    this.app.workspace.iterateRootLeaves(l => { if (!found && alive(l)) found = l; });
    return found;
  }
  focusBook() {
    const leaf = this.bookLeaf();
    if (!leaf) return false;
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return true;
  }
  currentItem() { return this.currentBook ? this.byPath.get(this.currentBook) || null : null; }
  currentPage(rel) { return pdfPage(this.bookLeaf(rel)); }

  // ------------------------------------------------------------ books
  setCurrentBook(rel) {
    if (this.currentBook === rel) return;
    this.currentBook = rel;
    this.saveState();
    const nv = this.notesView();
    if (nv) nv.load(rel);
    this.refreshLists();
  }
  bookOpened(rel) {
    this.recent = [[rel, Date.now()], ...this.recent.filter(r => r[0] !== rel)].slice(0, this.settings.recentMax || RECENT_MAX);
    this.setCurrentBook(rel);
    this.saveState();
    this.refreshDesk();
  }
  canOpenInside(ext) {
    try { return !!this.app.viewRegistry.getTypeByExtension(ext); }
    catch (_) { return ['pdf', 'md', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp3', 'm4a', 'wav', 'ogg', 'flac', 'mp4', 'webm'].includes(ext); }
  }
  async openItem(it, newTab) {
    if (!this.canOpenInside(it.e)) { this.openExternal(it.p); this.bookOpened(it.p); return; }
    const ws = this.app.workspace;
    let leaf;
    if (newTab) leaf = ws.getLeaf('tab');
    else {
      const r = this.readerLeaf;
      leaf = r && r.view && r.getRoot && r.getRoot() === ws.rootSplit ? r : ws.getLeaf(false);
      if (leaf.view && leaf.view.getViewType() === VIEW_DESK) leaf = ws.getLeaf('tab');
    }
    await leaf.openFile(it.file, { active: !!newTab });
    this.readerLeaf = leaf;
    this.bookOpened(it.p);
    if (newTab) {   // "open to annotate": the book in its own tab with its notes beside it
      ws.setActiveLeaf(leaf, { focus: true });
      await this.ensureLeaf(VIEW_NOTES, 'right');
      ws.setActiveLeaf(leaf, { focus: true });
    }
  }
  async openAt(rel, page, term, entireWord) {
    const it = this.byPath.get(rel);
    if (!it) return;
    const ws = this.app.workspace;
    let leaf = this.bookLeaf(rel);
    if (!leaf) { const r = this.readerLeaf; leaf = r && r.getRoot && r.getRoot() === ws.rootSplit ? r : ws.getLeaf(false); }
    if (leaf.view && leaf.view.getViewType() === VIEW_DESK) leaf = ws.getLeaf('tab');
    await leaf.openFile(it.file, { active: false, eState: { subpath: '#page=' + page } });
    this.readerLeaf = leaf;
    if (this.currentBook !== rel) this.bookOpened(rel);
    // mark the term with pdf.js's own find bar machinery, once the viewer is ready
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const { viewer, bus } = pdfParts(leaf);
      if (!viewer || !bus || !viewer.pagesCount) continue;
      if (viewer.currentPageNumber !== page) { try { viewer.currentPageNumber = page; } catch (_) { /* ignore */ } }
      try {
        bus.dispatch('find', { source: this, type: '', query: term, caseSensitive: false, entireWord: !!entireWord,
                               highlightAll: true, findPrevious: false, phraseSearch: true, matchDiacritics: false });
      } catch (_) { /* viewer internals differ: the page jump alone still works */ }
      break;
    }
  }
  openExternal(rel) {
    try { this.app.openWithDefaultApp(rel); }
    catch (_) { require('electron').shell.openPath(this.notes.libFile(rel)); }
  }
  togglePin(it) {
    if (!it) return;
    if (this.pins[it.p]) delete this.pins[it.p]; else this.pins[it.p] = Date.now();
    this.saveState();
    this.refreshLists();
    this.notesView()?.syncPin();
  }
  itemMenu(it) {
    const m = new Menu();
    m.addItem(i => i.setTitle('Open').setIcon('book-open').onClick(() => this.openItem(it, false)));
    m.addItem(i => i.setTitle('Open to annotate (new tab)').setIcon('file-plus').onClick(() => this.openItem(it, true)));
    m.addItem(i => i.setTitle('Open in default program').setIcon('external-link').onClick(() => this.openExternal(it.p)));
    m.addItem(i => i.setTitle(this.pins[it.p] ? 'Unpin' : 'Pin').setIcon('star').onClick(() => this.togglePin(it)));
    return m;
  }
  /** A book renamed inside Obsidian takes its notes along (same rule as the relink offer). */
  followRename(file, oldPath) {
    try {
      if (!file || !('extension' in file)) return;
      const nv = this.notesView();
      const open = nv && nv.doc && nv.doc.rel === oldPath ? nv.doc : null;
      const pending = open && open.dirty ? nv.ta.value : null;
      const src = this.notes.noteFile(oldPath), dst = this.notes.noteFile(file.path);
      if (src && dst && isFile(src) && !fs.existsSync(dst)) {
        const [lines, body] = splitNote(readText(src));
        fmSet(lines, 'pdf', JSON.stringify(file.path));
        writeAtomic(dst, joinNote(lines, body));
        fs.unlinkSync(src);
        new Notice('Library: moved the notes along with the renamed book.');
      }
      if (this.currentBook === oldPath) this.currentBook = file.path;
      if (this.readerLeaf && this.readerLeaf.view && this.readerLeaf.view.file === file) this.setCurrentBook(file.path);
      if (open) {   // the editor had this book: reopen it under the new name, keeping unsaved text
        clearTimeout(nv.timer);
        nv.draftDel(oldPath);
        nv.doc = null;
        nv.load(file.path, { force: true });
        if (pending !== null && nv.doc) { nv.ta.value = pending; nv.doc.dirty = true; nv.save(); }
      }
      this.refreshNoted();
    } catch (e) { console.error('Library Reader: could not move notes after rename', e); }
  }
};

// exposed for the headless tests in the plugin's test script
module.exports.__test = { parseName, searchCatalog, splitNote, fmGet, fmSet, joinNote, buildMatcher, findInPage, windowAround, pageText, fold, foldMap, NotesStore, norm };
