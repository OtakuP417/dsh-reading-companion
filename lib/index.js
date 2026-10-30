/* dsh-reading-companion v0.1.0 — built from src/ by build.mjs; do not edit by hand. */

// src/host/books.js
import fsp2 from "node:fs/promises";
import path3 from "node:path";

// src/host/store.js
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
function defaultRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "reading-companion");
}
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}
async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const body = JSON.stringify(value, null, 2);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const handle = await fsp.open(tmp, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}
async function readJson(file, fallback) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
function readJsonSync(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
async function appendLine(file, record) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(record)}
`, "utf8");
}
async function readLines(file) {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return out;
}
function slugify(value) {
  const base = String(value ?? "").normalize("NFKD").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return base || "book";
}
function bookIdFor(input) {
  const hash = crypto.createHash("sha1").update(input.bytes ?? Buffer.from(String(input.title ?? ""))).digest("hex").slice(0, 8);
  return `${slugify(input.title)}-${hash}`;
}
var Store = class {
  /**
   * A string is accepted as shorthand for `{ root }`: a caller that passes a
   * bare path and then silently writes into the real data root is the one bug
   * this class can hide from everyone, including its own tests.
   * @param {string | { root?: string }} [options]
   */
  constructor(options = {}) {
    const root = typeof options === "string" ? options : options?.root;
    this.root = root || defaultRoot();
  }
  get booksDir() {
    return path.join(this.root, "books");
  }
  /** Join any path under the data root. @param {...string} parts */
  path(...parts) {
    return path.join(this.root, ...parts);
  }
  bookDir(bookId) {
    return path.join(this.booksDir, bookId);
  }
  /** @param {string} bookId */
  bookPath(bookId, name2) {
    return path.join(this.bookDir(bookId), name2);
  }
  /** @param {string} bookId */
  progressPath(bookId) {
    return path.join(this.root, "progress", `${bookId}.json`);
  }
  /**
   * Book ids known on disk, synchronously. The guard runs synchronously, so it
   * cannot await `listBooks`; it still needs to know whether there is exactly one
   * book to fall back on when the conversation has no active book.
   * @returns {string[]}
   */
  syncBookIds() {
    try {
      return readdirSync(this.booksDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  /** @param {'notes'|'takeaways'|'cards'|'reviews'|'summaries'} kind @param {string} bookId */
  logPath(kind, bookId) {
    const name2 = kind === "summaries" ? "summaries.jsonl" : `${kind}.jsonl`;
    return kind === "summaries" ? this.bookPath(bookId, name2) : path.join(this.root, kind, `${bookId}.jsonl`);
  }
  /** Books that have a meta.json, newest first. */
  async listBooks() {
    let entries;
    try {
      entries = await fsp.readdir(this.booksDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const metas = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJson(path.join(this.booksDir, entry.name, "meta.json"), null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => String(b.importedAt ?? "").localeCompare(String(a.importedAt ?? "")));
    return metas;
  }
  async ensureLayout() {
    await ensureDir(this.booksDir);
    for (const kind of ["progress", "notes", "takeaways", "cards", "reviews"]) {
      await ensureDir(path.join(this.root, kind));
    }
  }
};

// src/host/epub.js
import path2 from "node:path";

// src/host/zip.js
import zlib from "node:zlib";
var EOCD_SIG = 101010256;
var ZIP64_LOCATOR_SIG = 117853008;
var ZIP64_EOCD_SIG = 101075792;
var CENTRAL_SIG = 33639248;
var LOCAL_SIG = 67324752;
function readCentralDirectory(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 66e3);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 EPUB/ZIP\uFF1A\u627E\u4E0D\u5230\u4E2D\u592E\u76EE\u5F55");
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  const comment = commentLen ? buf.toString("utf8", eocd + 22, eocd + 22 + commentLen) : "";
  if (count === 65535 || cdOffset === 4294967295) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }
  const entries = /* @__PURE__ */ new Map();
  let offset = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const entryCommentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name2 = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.set(name2, { method, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + entryCommentLen;
  }
  return { entries, comment };
}
function readEntry2(buf, entry) {
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) {
    throw new Error("ZIP \u6761\u76EE\u635F\u574F\uFF1A\u672C\u5730\u5934\u7B7E\u540D\u4E0D\u7B26");
  }
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`\u4E0D\u652F\u6301\u7684 ZIP \u538B\u7F29\u65B9\u5F0F\uFF1A${entry.method}`);
}
function readZip(buf) {
  const { entries } = readCentralDirectory(buf);
  const files = /* @__PURE__ */ new Map();
  for (const [name2, entry] of entries) {
    if (name2.endsWith("/")) continue;
    files.set(name2, readEntry2(buf, entry));
  }
  return files;
}

// src/host/epub.js
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  middot: "\xB7",
  times: "\xD7",
  copy: "\xA9",
  reg: "\xAE",
  deg: "\xB0",
  laquo: "\xAB",
  raquo: "\xBB"
};
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}
function htmlToText(html) {
  let text = String(html ?? "");
  text = text.replace(/<\?xml[\s\S]*?\?>/g, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figcaption|dd|dt|pre)>/gi, "\n\n");
  text = text.replace(/<hr\b[^>]*>/gi, "\n\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/\u00a0/g, " ");
  text = text.replace(/[ \t\f\v]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
function attr(tag, name2) {
  const re = new RegExp(`\\b${name2}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = re.exec(tag);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? "");
}
function resolveHref(base, href) {
  const clean = href.split("#")[0];
  if (!clean) return "";
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const dir = path2.posix.dirname(base);
  return path2.posix.normalize(path2.posix.join(dir === "." ? "" : dir, decoded));
}
function normPath(value) {
  let out = value;
  try {
    out = decodeURIComponent(value);
  } catch {
    out = value;
  }
  return out.replace(/^\.\//, "");
}
function parseOpf(opfText, opfPath) {
  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfText);
  const creatorMatch = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opfText);
  const languageMatch = /<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i.exec(opfText);
  const title = titleMatch ? htmlToText(titleMatch[1]).trim() : "";
  const author = creatorMatch ? htmlToText(creatorMatch[1]).trim() : "";
  const manifest = /* @__PURE__ */ new Map();
  for (const tag of opfText.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, "id");
    const href = attr(tag, "href");
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      path: resolveHref(opfPath, href),
      mediaType: attr(tag, "media-type") ?? "",
      properties: attr(tag, "properties") ?? ""
    });
  }
  const spine = [];
  for (const tag of opfText.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = attr(tag, "idref");
    if (!idref) continue;
    spine.push({ idref, linear: (attr(tag, "linear") ?? "yes").toLowerCase() !== "no" });
  }
  const tocId = attr((/<spine\b[^>]*>/i.exec(opfText) ?? [""])[0], "toc");
  return {
    title,
    author,
    language: languageMatch ? htmlToText(languageMatch[1]).trim() : "",
    manifest,
    spine,
    tocId: tocId || null,
    opfPath
  };
}
function readTocTitles(files, opf) {
  const titles = /* @__PURE__ */ new Map();
  const navItem = [...opf.manifest.values()].find((item) => /\bnav\b/.test(item.properties));
  if (navItem) {
    const bytes = files.get(navItem.path);
    if (bytes) {
      const html = bytes.toString("utf8");
      const navBlock = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][\s\S]*?<\/nav>/i.exec(html) ?? /<nav\b[\s\S]*?<\/nav>/i.exec(html);
      if (navBlock) {
        for (const tag of navBlock[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
          const open = /<a\b[^>]*>/i.exec(tag)?.[0] ?? "";
          const href = attr(open, "href");
          const label = htmlToText(tag).trim();
          if (!href || !label) continue;
          const target = resolveHref(navItem.path, href);
          if (!titles.has(target)) titles.set(target, label);
        }
      }
    }
  }
  if (titles.size === 0) {
    const ncxItem = (opf.tocId ? opf.manifest.get(opf.tocId) : null) ?? [...opf.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
    if (ncxItem) {
      const bytes = files.get(ncxItem.path);
      if (bytes) {
        const xml = bytes.toString("utf8");
        for (const block of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
          const label = htmlToText(/<text>([\s\S]*?)<\/text>/i.exec(block)?.[1] ?? "").trim();
          const src = attr(/<content\b[^>]*>/i.exec(block)?.[0] ?? "", "src");
          if (!label || !src) continue;
          const target = resolveHref(ncxItem.path, src);
          if (!titles.has(target)) titles.set(target, label);
        }
      }
    }
  }
  return titles;
}
function readTocEntries(files, opf) {
  const entries = [];
  const navItem = [...opf.manifest.values()].find((item) => /\bnav\b/.test(item.properties));
  if (navItem) {
    const bytes = files.get(navItem.path);
    if (bytes) {
      const html = bytes.toString("utf8");
      const navBlock = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][\s\S]*?<\/nav>/i.exec(html) ?? /<nav\b[\s\S]*?<\/nav>/i.exec(html);
      for (const tag of navBlock?.[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
        const open = /<a\b[^>]*>/i.exec(tag)?.[0] ?? "";
        const href = attr(open, "href");
        const title = htmlToText(tag).trim();
        if (!href || !title || href.startsWith("http")) continue;
        const [pathPart, fragment = ""] = href.split("#");
        entries.push({
          title,
          target: resolveHref(navItem.path, pathPart),
          fragment: decodeFragment(fragment)
        });
      }
    }
  }
  if (entries.length === 0) {
    const ncxItem = (opf.tocId ? opf.manifest.get(opf.tocId) : null) ?? [...opf.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
    if (ncxItem) {
      const bytes = files.get(ncxItem.path);
      if (bytes) {
        const xml = bytes.toString("utf8");
        for (const block of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
          const title = htmlToText(/<text>([\s\S]*?)<\/text>/i.exec(block)?.[1] ?? "").trim();
          const src = attr(/<content\b[^>]*>/i.exec(block)?.[0] ?? "", "src");
          if (!title || !src) continue;
          const [pathPart, fragment = ""] = src.split("#");
          entries.push({
            title,
            target: resolveHref(ncxItem.path, pathPart),
            fragment: decodeFragment(fragment)
          });
        }
      }
    }
  }
  return entries;
}
function decodeFragment(fragment) {
  if (!fragment) return "";
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}
function parseEpub(bytes) {
  const files = readZip(bytes);
  const container = files.get("META-INF/container.xml");
  if (!container) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 EPUB\uFF1A\u7F3A\u5C11 META-INF/container.xml");
  const rootfile = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container.toString("utf8"));
  if (!rootfile) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 EPUB\uFF1Acontainer.xml \u91CC\u6CA1\u6709 rootfile");
  const opfPath = normPath(rootfile[1]);
  const opfBytes = files.get(opfPath) ?? files.get(rootfile[1]);
  if (!opfBytes) throw new Error(`\u4E0D\u662F\u6709\u6548\u7684 EPUB\uFF1A\u627E\u4E0D\u5230 ${opfPath}`);
  const opfText = opfBytes.toString("utf8");
  const opf = parseOpf(opfText, opfPath);
  const tocTitles = readTocTitles(files, opf);
  const tocEntries = readTocEntries(files, opf);
  const sections = [];
  for (const spineItem of opf.spine) {
    const item = opf.manifest.get(spineItem.idref);
    if (!item) continue;
    if (item.mediaType && !/html|xml/.test(item.mediaType)) continue;
    const fileBytes = files.get(item.path) ?? files.get(item.href);
    if (!fileBytes) continue;
    const text = htmlToText(fileBytes.toString("utf8"));
    sections.push({
      index: sections.length,
      href: item.href,
      path: item.path,
      title: tocTitles.get(normPath(item.path)) ?? tocTitles.get(item.href) ?? "",
      chars: text.length,
      text
    });
  }
  if (sections.length === 0) throw new Error("\u8FD9\u4E2A EPUB \u6CA1\u6709\u53EF\u8BFB\u7684\u6B63\u6587\u7AE0\u8282");
  for (const section of sections) {
    if (section.title) continue;
    const firstLine2 = section.text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    section.title = firstLine2 ? firstLine2.slice(0, 24) : "";
  }
  const sectionByPath = new Map(sections.map((section) => [normPath(section.path), section]));
  const toc = [];
  for (const entry of tocEntries) {
    const section = sectionByPath.get(normPath(entry.target));
    if (!section) continue;
    if (toc.length >= 500) break;
    toc.push({
      index: toc.length,
      title: entry.title,
      sectionIndex: section.index,
      // The renderer resolves a TOC href against the OPF, so this must be the
      // archive path (`OEBPS/chapter1.xhtml`), not the manifest's relative href.
      href: entry.fragment ? `${section.path}#${entry.fragment}` : section.path
    });
  }
  return {
    title: opf.title || "\u672A\u547D\u540D\u4E66\u7C4D",
    author: opf.author || "",
    language: opf.language || "",
    chapterCount: sections.length,
    sections,
    toc
  };
}

// src/host/zip-write.js
import zlib2 from "node:zlib";
var CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crc >>> 8 ^ CRC_TABLE[(crc ^ buf[i]) & 255];
  return (crc ^ -1) >>> 0;
}
function dosDateTime(date) {
  const time = date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2);
  const day = date.getFullYear() - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate();
  return { time, day };
}
function writeZip(entries, { mtime = /* @__PURE__ */ new Date() } = {}) {
  const { time, day } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name2 = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const deflated = entry.compress && raw.length > 64 ? zlib2.deflateRawSync(raw) : null;
    const body = deflated ?? raw;
    const method = deflated ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(67324752, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name2.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name2, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(33639248, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(2048, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name2.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name2);
    offset += local.length + name2.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

// src/host/epub-build.js
var XML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
function escapeXml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch]);
}
function paragraphs(text) {
  return String(text ?? "").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean).map((block) => `<p>${escapeXml(block).replace(/\n/g, "<br/>")}</p>`).join("\n");
}
function chapterDocument(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<style>body{font-family:serif;line-height:1.7;margin:0 4%;}h1,h2{font-weight:600;}p{margin:0 0 .8em;text-indent:2em;}</style>
</head>
<body>
${body}
</body>
</html>`;
}
function buildEpub(input) {
  const title = String(input.title ?? "").trim() || "\u672A\u547D\u540D";
  const author = String(input.author ?? "").trim();
  const language = String(input.language ?? "zh").trim() || "zh";
  const identifier = input.identifier ?? `urn:dsh-reading:${Date.now().toString(36)}`;
  const sections = (input.sections ?? []).filter(Boolean);
  if (sections.length === 0) throw new Error("\u6CA1\u6709\u53EF\u4EE5\u653E\u8FDB\u4E66\u7684\u6B63\u6587");
  const resources = input.resources ?? [];
  const chapterFiles = [];
  const navItems = [];
  sections.forEach((section, index) => {
    const file = `chap-${String(index + 1).padStart(3, "0")}.xhtml`;
    chapterFiles.push(file);
    navItems.push({ label: section.title?.trim() || `\u7B2C ${index + 1} \u8282`, href: file });
  });
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...chapterFiles.map(
      (file, index) => `<item id="c${index + 1}" href="${file}" media-type="application/xhtml+xml"/>`
    ),
    ...resources.map(
      (res, index) => `<item id="r${index + 1}" href="${escapeXml(res.href)}" media-type="${escapeXml(res.mediaType)}"/>`
    )
  ];
  const spine = chapterFiles.map((_, index) => `<itemref idref="c${index + 1}"/>`).join("\n    ");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    ${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ""}
    <dc:language>${escapeXml(language)}</dc:language>
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
<head><meta charset="utf-8"/><title>\u76EE\u5F55</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>\u76EE\u5F55</h1>
  <ol>
    ${navItems.map((item) => `<li><a href="${item.href}">${escapeXml(item.label)}</a></li>`).join("\n    ")}
  </ol>
</nav>
</body>
</html>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
  const entries = [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf, compress: true },
    { name: "OEBPS/nav.xhtml", data: nav, compress: true }
  ];
  sections.forEach((section, index) => {
    const body = section.html ?? paragraphs(section.text ?? "");
    const heading = section.title ? `<h1>${escapeXml(section.title)}</h1>
` : "";
    entries.push({
      name: `OEBPS/${chapterFiles[index]}`,
      data: chapterDocument(section.title ?? "", heading + body),
      compress: true
    });
  });
  for (const res of resources) {
    entries.push({ name: `OEBPS/${res.href}`, data: res.bytes, compress: true });
  }
  return writeZip(entries);
}

// src/host/formats/text.js
var CHAPTER_LINE = /^\s*(?:第[0-9零〇一二三四五六七八九十百千两]{1,12}[章节回卷部篇集幕]|(?:Chapter|CHAPTER|Part|PART)\s+(?:\d{1,4}|[IVXLC]{1,7})\b|序章|序幕|楔子|引子|尾声|终章|后记|番外|前言|自序)/;
var HEADING_MD = /^(#{1,2})\s+(.+?)\s*#*\s*$/;
function decodeText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return new TextDecoder("utf-8").decode(buf.subarray(3));
  }
  for (const encoding of ["utf-8", "gb18030", "big5"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buf);
    } catch {
    }
  }
  return new TextDecoder("utf-8").decode(buf);
}
function cleanTitle(line) {
  return line.replace(HEADING_MD, "$2").replace(/^#+\s*/, "").trim().slice(0, 60);
}
function trimBlank(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}
function splitByChapters(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let title = "";
  let current = [];
  const flush = () => {
    const body = trimBlank(current).join("\n").trim();
    if (body) sections.push({ title, text: body });
    current = [];
  };
  for (const line of lines) {
    if (CHAPTER_LINE.test(line) && line.trim().length <= 40) {
      flush();
      title = cleanTitle(line);
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}
function splitBySize(text, size = 7e3) {
  const paragraphs2 = String(text ?? "").replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let buffer = "";
  for (const paragraph of paragraphs2) {
    if (buffer.length + paragraph.length + 2 > size && buffer) {
      out.push({ title: "", text: buffer });
      buffer = "";
    }
    buffer += (buffer ? "\n\n" : "") + paragraph;
  }
  if (buffer) out.push({ title: "", text: buffer });
  return out;
}
function sectionsFromText(text) {
  const chapters = splitByChapters(text);
  const filled = chapters.filter((s) => s.text.length > 0);
  if (filled.length >= 2) return filled;
  const sized = splitBySize(text).filter((s) => s.text.length > 0);
  if (sized.length > 0) return sized;
  const only = String(text ?? "").trim();
  return only ? [{ title: "", text: only }] : [];
}
function sectionsFromMarkdown(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const level = /^#[ \t]+\S/m.test(raw) ? 1 : 2;
  const heading = new RegExp(`^#{${level}}[ \\t]+(.+?)[ \\t]*#*[ \\t]*$`);
  const deeper = new RegExp(`^#{${level + 1},6}[ \\t]+`);
  const lines = raw.split("\n");
  const sections = [];
  let title = "";
  let current = [];
  const flush = () => {
    const body = trimBlank(current).join("\n").trim();
    if (body) sections.push({ title, text: body });
    current = [];
  };
  for (const line of lines) {
    const match = heading.exec(line);
    if (match) {
      flush();
      title = match[1].trim().slice(0, 60);
      continue;
    }
    current.push(line.replace(deeper, ""));
  }
  flush();
  if (sections.length === 0) return sectionsFromText(raw);
  return sections;
}
var BLOCK_END = /<\/(?:p|div|h[1-6]|li|blockquote|section|article|tr|pre)>/gi;
function sectionsFromHtml(html) {
  const source = String(html ?? "").replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head|svg)[\s\S]*?<\/\1>/gi, "").replace(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, _level, inner) => {
    return `

@@CHAPTER@@${stripTags(inner)}

`;
  }).replace(BLOCK_END, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  const text = decodeEntities2(source);
  const sections = [];
  let title = "";
  let current = [];
  const flush = () => {
    const body = trimBlank(current).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (body) sections.push({ title, text: body });
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("@@CHAPTER@@")) {
      flush();
      title = line.slice("@@CHAPTER@@".length).trim().slice(0, 60);
      continue;
    }
    current.push(line);
  }
  flush();
  if (sections.length === 0) return sectionsFromText(text);
  return sections;
}
function stripTags(html) {
  return String(html ?? "").replace(/<[^>]+>/g, "");
}
var ENTITIES2 = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019"
};
function decodeEntities2(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES2[body.toLowerCase()] ?? match;
  });
}

// src/host/formats/fb2.js
function findSections(xml) {
  const out = [];
  const tag = /<\/?section\b[^>]*>/gi;
  let depth = 0;
  let start = 0;
  let startTagEnd = 0;
  let match;
  while ((match = tag.exec(xml)) !== null) {
    const closing = match[0][1] === "/";
    if (!closing) {
      if (depth === 0) {
        start = match.index;
        startTagEnd = match.index + match[0].length;
      }
      depth++;
      continue;
    }
    depth--;
    if (depth < 0) depth = 0;
    if (depth === 0) {
      out.push({
        full: xml.slice(start, match.index + match[0].length),
        inner: xml.slice(startTagEnd, match.index)
      });
    }
  }
  return out;
}
function innerOf(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match ? match[1] : "";
}
function textOf(fragment) {
  return decodeEntities2(
    String(fragment ?? "").replace(/<empty-line\b[^>]*\/?>/gi, "\n\n").replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function firstLine(fragment) {
  const text = textOf(innerOf(fragment, "title"));
  return text.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
}
function bodyText(sectionXml) {
  let body = sectionXml;
  for (const nested of findSections(body)) body = body.replace(nested.full, "");
  body = body.replace(/<title\b[\s\S]*?<\/title>/gi, "");
  const blockTag = /<(p|subtitle|v|text-author|epigraph|cite|poem|stanza)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const parts = [];
  let match;
  while ((match = blockTag.exec(body)) !== null) {
    const text = textOf(match[2]);
    if (text) parts.push(text);
  }
  if (parts.length === 0) return textOf(body);
  return parts.join("\n\n");
}
function collectSections(xml, out) {
  for (const section of findSections(xml)) {
    const text = bodyText(section.inner);
    if (text) out.push({ title: firstLine(section.inner) || "", text });
    collectSections(section.inner, out);
  }
}
function parseFb2(xml) {
  const source = String(xml ?? "").replace(/^\uFEFF/, "");
  if (!/<FictionBook\b/i.test(source)) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 FB2\uFF1A\u7F3A\u5C11 FictionBook \u6839\u5143\u7D20");
  const description = innerOf(source, "description");
  const titleTag = innerOf(description, "book-title");
  const authorTag = innerOf(description, "author");
  const author = [
    innerOf(authorTag, "first-name"),
    innerOf(authorTag, "middle-name"),
    innerOf(authorTag, "last-name")
  ].map((part) => textOf(part)).filter(Boolean).join(" ");
  const language = textOf(innerOf(description, "lang")) || "zh";
  const bodies = [];
  const bodyRegex = /<body\b([^>]*)>([\s\S]*?)<\/body>/gi;
  let bodyMatch;
  while ((bodyMatch = bodyRegex.exec(source)) !== null) {
    const attrs = bodyMatch[1] ?? "";
    if (/name\s*=\s*["'](notes|comments|footnotes)["']/i.test(attrs)) continue;
    bodies.push(bodyMatch[2]);
  }
  if (bodies.length === 0) throw new Error("\u8FD9\u4E2A FB2 \u6CA1\u6709\u6B63\u6587");
  const sections = [];
  for (const body of bodies) {
    const before = sections.length;
    collectSections(body, sections);
    if (sections.length === before) {
      const text = bodyText(body);
      if (text) sections.push({ title: firstLine(body) || "", text });
    }
  }
  if (sections.length === 0) throw new Error("\u8FD9\u4E2A FB2 \u6CA1\u6709\u53EF\u8BFB\u7684\u6B63\u6587");
  return { title: textOf(titleTag) || "\u672A\u547D\u540D", author, language, sections };
}

// src/host/formats/mobi.js
var PDB_HEADER = { type: [60, 4, "string"], creator: [64, 4, "string"], numRecords: [76, 2, "uint"] };
var PALMDOC_HEADER = {
  compression: [0, 2, "uint"],
  numTextRecords: [8, 2, "uint"],
  encryption: [12, 2, "uint"]
};
var MOBI_HEADER = {
  magic: [16, 4, "string"],
  length: [20, 4, "uint"],
  encoding: [28, 4, "uint"],
  version: [36, 4, "uint"],
  titleOffset: [84, 4, "uint"],
  titleLength: [88, 4, "uint"],
  huffcdic: [112, 4, "uint"],
  numHuffcdic: [116, 4, "uint"],
  exthFlag: [128, 4, "uint"],
  trailingFlags: [240, 4, "uint"]
};
var HUFF_HEADER = { magic: [0, 4, "string"], offset1: [8, 4, "uint"], offset2: [12, 4, "uint"] };
var CDIC_HEADER = {
  magic: [0, 4, "string"],
  length: [4, 4, "uint"],
  numEntries: [8, 4, "uint"],
  codeLength: [12, 4, "uint"]
};
var EXTH_HEADER = { magic: [0, 4, "string"], length: [4, 4, "uint"], count: [8, 4, "uint"] };
var ENCODINGS = { 1252: "windows-1252", 65001: "utf-8" };
var getUint = (buffer) => {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.byteLength === 4) return view.getUint32(0);
  if (buffer.byteLength === 2) return view.getUint16(0);
  return view.getUint8(0);
};
var getStruct = (def, buffer) => Object.fromEntries(
  Object.entries(def).map(([key, [start, len, type]]) => {
    const slice = buffer.subarray(start, start + len);
    return [key, type === "string" ? Buffer.from(slice).toString("latin1") : getUint(slice)];
  })
);
var getVarLenFromEnd = (byteArray) => {
  let value = 0;
  for (const byte of byteArray.subarray(-4)) {
    if (byte & 128) value = 0;
    value = value << 7 | byte & 127;
  }
  return value;
};
var countBitsSet = (x) => {
  let count = 0;
  for (; x > 0; x = x >> 1) if ((x & 1) === 1) count++;
  return count;
};
function decompressPalmDOC(array) {
  const output = [];
  for (let i = 0; i < array.length; i++) {
    const byte = array[i];
    if (byte === 0) output.push(0);
    else if (byte <= 8) {
      for (const x of array.subarray(i + 1, (i += byte) + 1)) output.push(x);
    } else if (byte <= 127) output.push(byte);
    else if (byte <= 191) {
      const bytes = byte << 8 | array[i++ + 1];
      const distance = (bytes & 16383) >>> 3;
      const length = (bytes & 7) + 3;
      for (let j = 0; j < length; j++) output.push(output[output.length - distance]);
    } else output.push(32, byte ^ 128);
  }
  return Uint8Array.from(output);
}
var read32Bits = (byteArray, from) => {
  const startByte = from >> 3;
  const end = from + 32;
  const endByte = end >> 3;
  let bits = 0n;
  for (let i = startByte; i <= endByte; i++) bits = bits << 8n | BigInt(byteArray[i] ?? 0);
  return bits >> 8n - BigInt(end & 7) & 0xffffffffn;
};
var concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
function makeHuffcdic(loadRecord, mobi) {
  const huffRecord = loadRecord(mobi.huffcdic);
  const { magic, offset1, offset2 } = getStruct(HUFF_HEADER, huffRecord);
  if (magic !== "HUFF") throw new Error("MOBI \u7684 HUFF \u8BB0\u5F55\u635F\u574F");
  const table1 = Array.from({ length: 256 }, (_, i) => offset1 + i * 4).map((offset) => getUint(huffRecord.subarray(offset, offset + 4))).map((x) => [x & 128, x & 31, x >>> 8]);
  const table2 = [null].concat(
    Array.from({ length: 32 }, (_, i) => offset2 + i * 8).map((offset) => [
      getUint(huffRecord.subarray(offset, offset + 4)),
      getUint(huffRecord.subarray(offset + 4, offset + 8))
    ])
  );
  const dictionary = [];
  for (let i = 1; i < mobi.numHuffcdic; i++) {
    const record = loadRecord(mobi.huffcdic + i);
    const cdic = getStruct(CDIC_HEADER, record);
    if (cdic.magic !== "CDIC") throw new Error("MOBI \u7684 CDIC \u8BB0\u5F55\u635F\u574F");
    const n = Math.min(1 << cdic.codeLength, cdic.numEntries - dictionary.length);
    const buffer = record.subarray(cdic.length);
    for (let i2 = 0; i2 < n; i2++) {
      const offset = getUint(buffer.subarray(i2 * 2, i2 * 2 + 2));
      const x = getUint(buffer.subarray(offset, offset + 2));
      const length = x & 32767;
      const decompressed = x & 32768;
      dictionary.push([new Uint8Array(buffer.subarray(offset + 2, offset + 2 + length)), decompressed]);
    }
  }
  const decompress = (byteArray) => {
    let output = new Uint8Array();
    const bitLength = byteArray.byteLength * 8;
    for (let i = 0; i < bitLength; ) {
      const bits = Number(read32Bits(byteArray, i));
      let [found, codeLength, value] = table1[bits >>> 24];
      if (!found) {
        while (bits >>> 32 - codeLength < table2[codeLength][0]) codeLength += 1;
        value = table2[codeLength][1];
      }
      if ((i += codeLength) > bitLength) break;
      const code = value - (bits >>> 32 - codeLength);
      let [result, done] = dictionary[code];
      if (!done) {
        result = decompress(result);
        dictionary[code] = [result, true];
      }
      output = concat(output, result);
    }
    return output;
  };
  return decompress;
}
function getExth(buffer, encoding) {
  const header = getStruct(EXTH_HEADER, buffer);
  if (header.magic !== "EXTH") return null;
  const decoder = new TextDecoder(ENCODINGS[encoding] ?? "utf-8");
  const out = {};
  let offset = 12;
  for (let i = 0; i < header.count && offset + 8 <= header.length; i++) {
    const type = getUint(buffer.subarray(offset, offset + 4));
    const length = getUint(buffer.subarray(offset + 4, offset + 8));
    if (length < 8) break;
    const value = buffer.subarray(offset + 8, offset + length);
    const key = type === 100 ? "creator" : type === 503 ? "title" : type === 524 ? "language" : null;
    if (key) {
      const text = decoder.decode(value).replace(/\0+$/, "");
      if (key === "creator") out.creator = out.creator ? `${out.creator} ${text}` : text;
      else out[key] = text;
    }
    if (type === 121) out.boundary = getUint(value.subarray(0, 4));
    offset += length;
  }
  return out;
}
function htmlToText2(html) {
  return decodeEntities2(
    String(html ?? "").replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "").replace(/<mbp:[^>]*>/gi, "").replace(/<\/?(?:html|body|div|p|h[1-6]|li|tr|blockquote|section)\b[^>]*>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
var PAGEBREAK = /<\s*(?:mbp:)?pagebreak[^>]*>/gi;
function parseMobi(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 100) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 MOBI\uFF1A\u6587\u4EF6\u592A\u5C0F");
  const pdb = getStruct(PDB_HEADER, buf.subarray(0, 78));
  if (pdb.type !== "BOOK") throw new Error("\u4E0D\u662F\u6709\u6548\u7684 MOBI\uFF1A\u7F3A\u5C11 BOOKMOBI \u6807\u8BB0");
  if (pdb.creator !== "MOBI" && pdb.creator !== "TEXt") {
    throw new Error(`\u4E0D\u662F\u6709\u6548\u7684 MOBI\uFF1A\u672A\u8BC6\u522B\u7684 PDB \u7C7B\u578B ${pdb.type}${pdb.creator}`);
  }
  const offsets = [];
  for (let i = 0; i < pdb.numRecords; i++) {
    offsets.push(buf.readUInt32BE(78 + i * 8));
  }
  const loadRecord = (index) => {
    const start = offsets[index];
    if (start === void 0) throw new RangeError(`MOBI \u8BB0\u5F55\u8D8A\u754C\uFF1A${index}`);
    const end = offsets[index + 1] ?? buf.length;
    return buf.subarray(start, end);
  };
  const record0 = loadRecord(0);
  const palmdoc = getStruct(PALMDOC_HEADER, record0);
  const mobi = getStruct(MOBI_HEADER, record0);
  if (mobi.magic !== "MOBI") throw new Error("\u4E0D\u662F\u6709\u6548\u7684 MOBI\uFF1A\u7F3A\u5C11 MOBI \u5934");
  const exth = mobi.exthFlag & 64 ? getExth(record0.subarray(mobi.length + 16), mobi.encoding) : null;
  const isCombo = exth?.boundary !== void 0 && exth.boundary < 4294967295;
  if (mobi.version >= 8 && !isCombo) {
    throw new Error("\u8FD9\u662F KF8/AZW3 \u683C\u5F0F\uFF0C\u6682\u4E0D\u652F\u6301\u89E3\u6790\u3002\u8BF7\u7528 Calibre \u8F6C\u6210 EPUB\uFF08\u6216\u65E7\u7248 MOBI\uFF09\u540E\u518D\u5BFC\u5165\u3002");
  }
  if (palmdoc.encryption) throw new Error("\u8FD9\u672C MOBI \u6709 DRM \u52A0\u5BC6\uFF0C\u65E0\u6CD5\u89E3\u6790\u3002");
  const decoder = new TextDecoder(ENCODINGS[mobi.encoding] ?? "utf-8");
  const decompress = palmdoc.compression === 1 ? (f) => f : palmdoc.compression === 2 ? decompressPalmDOC : palmdoc.compression === 17480 ? makeHuffcdic(loadRecord, mobi) : null;
  if (!decompress) throw new Error(`\u4E0D\u652F\u6301\u7684 MOBI \u538B\u7F29\u65B9\u5F0F\uFF1A${palmdoc.compression}`);
  const multibyte = mobi.trailingFlags & 1;
  const numTrailing = countBitsSet(mobi.trailingFlags >>> 1);
  const stripTrailing = (array) => {
    let out = array;
    for (let i = 0; i < numTrailing; i++) out = out.subarray(0, out.length - getVarLenFromEnd(out));
    if (multibyte) out = out.subarray(0, out.length - ((out[out.length - 1] & 3) + 1));
    return out;
  };
  const chunks = [];
  for (let i = 0; i < palmdoc.numTextRecords; i++) {
    chunks.push(decompress(stripTrailing(new Uint8Array(loadRecord(i + 1)))));
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  const html = decoder.decode(all);
  const pieces = html.split(PAGEBREAK);
  const sections = [];
  for (const piece of pieces) {
    const title2 = (/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(piece)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || "";
    const text = htmlToText2(piece);
    if (text.length < 2) continue;
    sections.push({ title: title2, text });
  }
  if (sections.length === 0) throw new Error("\u8FD9\u672C MOBI \u6CA1\u6709\u89E3\u6790\u51FA\u6B63\u6587");
  const title = (exth?.title ?? "").trim() || decoder.decode(record0.subarray(mobi.titleOffset, mobi.titleOffset + mobi.titleLength)).replace(/\0+$/, "").trim();
  return {
    title: title || "\u672A\u547D\u540D",
    author: (exth?.creator ?? "").trim(),
    language: exth?.language ?? "zh",
    sections
  };
}

// src/host/formats/cbz.js
var IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
function mediaType(name2) {
  const ext = name2.slice(name2.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "avif") return "image/avif";
  return "application/octet-stream";
}
function pageOrder(a, b) {
  return a.localeCompare(b, void 0, { numeric: true, sensitivity: "base" });
}
function parseCbz(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { entries } = readCentralDirectory(buf);
  const pages = [...entries.keys()].filter((name2) => IMAGE_EXT.test(name2)).sort(pageOrder);
  if (pages.length === 0) throw new Error("\u8FD9\u4E2A CBZ \u91CC\u6CA1\u6709\u56FE\u7247\u9875\u9762");
  const resources = [];
  const sections = [];
  pages.forEach((name2, index) => {
    const href = `page-${String(index + 1).padStart(4, "0")}${name2.slice(name2.lastIndexOf("."))}`;
    resources.push({ href, mediaType: mediaType(name2), bytes: Buffer.from(readEntry2(buf, entries.get(name2))) });
    sections.push({
      title: `\u7B2C ${index + 1} \u9875`,
      html: `<div style="text-align:center"><img src="${href}" alt="\u7B2C ${index + 1} \u9875" style="max-width:100%;height:auto"/></div>`
    });
  });
  return { title: "", author: "", language: "zh", textless: true, sections, resources };
}

// src/host/formats/index.js
var ZIP_MAGIC = Buffer.from([80, 75, 3, 4]);
function looksLikeZip(buf) {
  return buf.length > 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}
function looksLikeMobi(buf) {
  return buf.length > 68 && buf.subarray(60, 68).toString("latin1") === "BOOKMOBI";
}
function looksLikePdf(buf) {
  return buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}
function detectFormat(bytes, fileName = "") {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const lower = String(fileName).toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (ext === ".pdf" || looksLikePdf(buf)) return "pdf";
  if (ext === ".epub") return "epub";
  if (ext === ".fb2" || ext === ".fbz") return "fb2";
  if (ext === ".azw3") return "azw3";
  if ([".mobi", ".azw", ".prc"].includes(ext)) return "mobi";
  if (ext === ".cbz") return "cbz";
  if ([".txt", ".text", ".log"].includes(ext)) return "txt";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".html", ".htm", ".xhtml"].includes(ext)) return "html";
  if (looksLikeMobi(buf)) return "mobi";
  if (looksLikeZip(buf)) {
    if (buf.subarray(30, 38).toString("latin1") === "mimetype") {
      const nameLength = buf.readUInt16LE(26);
      const mime = buf.subarray(30, 30 + nameLength).toString("latin1");
      if (mime === "mimetype") {
        const value = buf.subarray(30 + nameLength + buf.readUInt16LE(28), 30 + nameLength + buf.readUInt16LE(28) + 20).toString("latin1");
        if (value.startsWith("application/epub+zip")) return "epub";
      }
    }
    try {
      const { entries } = readCentralDirectory(buf);
      const names = [...entries.keys()];
      if (names.some((name2) => /\.fb2$/i.test(name2))) return "fb2";
      if (names.some((name2) => /\.(jpe?g|png|gif|webp)$/i.test(name2))) return "cbz";
      if (names.some((name2) => /\.(x?html|opf)$/i.test(name2))) return "epub";
    } catch {
    }
  }
  if (buf.length > 200 && /<FictionBook\b/i.test(buf.subarray(0, 4e3).toString("utf8"))) return "fb2";
  return "unknown";
}
function normalizeToEpub(bytes, { fileName = "" } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const format = detectFormat(buf, fileName);
  const warnings = [];
  const baseName = String(fileName).replace(/\.[^.]+$/, "").trim() || "\u672A\u547D\u540D";
  if (format === "epub") {
    return { epub: buf, format, title: "", author: "", language: "", textless: false, warnings };
  }
  if (format === "pdf") {
    throw new Error("PDF \u6682\u4E0D\u652F\u6301\uFF1A\u8FD9\u4E2A\u7248\u672C\u7684\u9605\u8BFB\u5668\u6CA1\u6709\u5185\u7F6E PDF \u6587\u672C\u5C42\u3002\u53EF\u4EE5\u5148\u8F6C\u6210 EPUB \u518D\u5BFC\u5165\u3002");
  }
  if (format === "azw3") {
    throw new Error("AZW3 \u6682\u4E0D\u652F\u6301\uFF1A\u5B83\u7684\u6B63\u6587\u662F\u788E\u7247\u7D22\u5F15\uFF0C\u9700\u8981\u5148\u8F6C\u6210 EPUB \u6216\u65E7\u7248 MOBI \u518D\u5BFC\u5165\u3002");
  }
  if (format === "unknown") {
    throw new Error("\u8BA4\u4E0D\u51FA\u8FD9\u4E2A\u6587\u4EF6\u683C\u5F0F\u3002\u76EE\u524D\u652F\u6301 EPUB\u3001MOBI\u3001FB2/FBZ\u3001TXT\u3001Markdown\u3001HTML\u3001CBZ\u3002");
  }
  if (format === "mobi") {
    const book = parseMobi(buf);
    warnings.push("MOBI \u53EA\u4FDD\u7559\u6587\u5B57\uFF0C\u56FE\u7247\u4E0D\u4F1A\u5E26\u8FC7\u6765\u3002");
    return {
      epub: buildEpub({
        title: book.title || baseName,
        author: book.author,
        language: book.language,
        sections: book.sections
      }),
      format,
      ...book,
      textless: false,
      warnings
    };
  }
  if (format === "fb2") {
    const xml = readFb2Source(buf, fileName);
    const book = parseFb2(xml);
    return {
      epub: buildEpub({
        title: book.title || baseName,
        author: book.author,
        language: book.language,
        sections: book.sections
      }),
      format,
      title: book.title,
      author: book.author,
      language: book.language,
      textless: false,
      warnings
    };
  }
  if (format === "cbz") {
    const book = parseCbz(buf);
    return {
      epub: buildEpub({
        title: book.title || baseName,
        sections: book.sections,
        resources: book.resources
      }),
      format,
      title: book.title,
      author: "",
      language: "zh",
      textless: true,
      warnings
    };
  }
  const text = decodeText(buf);
  const sections = format === "markdown" ? sectionsFromMarkdown(text) : format === "html" ? sectionsFromHtml(text) : sectionsFromText(text);
  if (sections.length === 0) throw new Error("\u8FD9\u4E2A\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u8BFB\u7684\u6B63\u6587");
  const title = sections[0]?.title?.trim() || baseName;
  return {
    epub: buildEpub({ title, sections }),
    format,
    title,
    author: "",
    language: "zh",
    textless: false,
    warnings
  };
}
function readFb2Source(buf, fileName) {
  const lower = String(fileName).toLowerCase();
  if (lower.endsWith(".fbz") || looksLikeZip(buf) && !lower.endsWith(".fb2")) {
    const { entries } = readCentralDirectory(buf);
    const name2 = [...entries.keys()].find((entry2) => /\.fb2$/i.test(entry2));
    if (!name2) throw new Error("\u8FD9\u4E2A FBZ \u91CC\u6CA1\u6709 .fb2 \u6587\u4EF6");
    const entry = entries.get(name2);
    return decodeText(readEntry(buf, entry));
  }
  return decodeText(buf);
}

// src/shared/retrieval.js
var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
var WORD = /[a-z0-9]+(?:['’-][a-z0-9]+)*/g;
function normalizeText(text) {
  return text.normalize("NFKC").toLowerCase();
}
function tokenize(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const normalized = normalizeText(text);
  const tokens = [];
  for (const match of normalized.matchAll(WORD)) {
    tokens.push(match[0]);
  }
  let run = "";
  const flush = () => {
    if (run.length === 0) return;
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
    }
    run = "";
  };
  for (const ch of normalized) {
    if (CJK.test(ch)) {
      run += ch;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}
function splitSentences(text) {
  const sentences = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;
    const ends = ch === "\u3002" || ch === "\uFF01" || ch === "\uFF1F" || ch === "\uFF1B" || ch === "\u2026" || ch === "!" || ch === "?" || ch === ";" || ch === "\n" || ch === "." && (i + 1 >= text.length || /\s/.test(text[i + 1]));
    if (ends) {
      if (current.trim().length > 0) sentences.push(current);
      current = "";
    }
  }
  if (current.trim().length > 0) sentences.push(current);
  return sentences;
}
function chunkSection(text, sectionIndex, options = {}) {
  const target = options.targetChars ?? 420;
  const max = options.maxChars ?? 900;
  const sentences = splitSentences(text);
  const withOffsets = [];
  let cursor = 0;
  for (const sentence of sentences) {
    withOffsets.push({ text: sentence, start: cursor });
    cursor += sentence.length;
  }
  const chunks = [];
  let buffer = "";
  let bufferStart = -1;
  let index = 0;
  const flush = () => {
    if (buffer.trim().length === 0) {
      buffer = "";
      bufferStart = -1;
      return;
    }
    chunks.push({
      id: `s${sectionIndex}c${index}`,
      sectionIndex,
      start: bufferStart,
      end: bufferStart + buffer.length,
      text: buffer
    });
    index++;
    buffer = "";
    bufferStart = -1;
  };
  for (const sentence of withOffsets) {
    if (buffer.length > 0 && buffer.length + sentence.text.length > target) flush();
    if (bufferStart < 0) bufferStart = sentence.start;
    buffer += sentence.text;
    if (buffer.length >= max) flush();
  }
  flush();
  return chunks;
}
function hashVector(tokens, dim = 512) {
  const vector = new Float64Array(dim);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = (hash >>> 0) % dim;
    vector[bucket] += 1;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vector[i] /= norm;
  return vector;
}
function cosine(a, b) {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i++) dot += a[i] * b[i];
  return dot > 0 ? Math.min(1, dot) : 0;
}
var K1 = 1.2;
var B = 0.75;
var HybridIndex = class {
  /**
   * @param {{ id: string, sectionIndex: number, text: string, cfi?: string | null, embedding?: number[] | null }[]} chunks
   * @param {{ dim?: number }} [options]
   */
  constructor(chunks, options = {}) {
    this.dim = options.dim ?? 512;
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(chunk.text);
      const termFreq = /* @__PURE__ */ new Map();
      for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
      return {
        chunk,
        tokens,
        termFreq,
        length: tokens.length,
        vector: chunk.embedding && chunk.embedding.length > 0 ? Float64Array.from(chunk.embedding) : hashVector(tokens, this.dim)
      };
    });
    this.docFreq = /* @__PURE__ */ new Map();
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1);
      }
    }
    this.total = this.docs.length;
    this.averageLength = this.total === 0 ? 0 : this.docs.reduce((sum, doc) => sum + doc.length, 0) / this.total;
  }
  /**
   * @param {string} term
   * @returns {number}
   */
  idf(term) {
    const df = this.docFreq.get(term) ?? 0;
    return Math.log(1 + (this.total - df + 0.5) / (df + 0.5));
  }
  /**
   * Score a pre-filtered candidate list. Filtering happens BEFORE this call and
   * inside the same entry function, so unread chunks are not in memory here.
   *
   * @param {string} query
   * @param {{ limit?: number, minScore?: number, bm25Weight?: number }} [options]
   * @returns {{ chunk: { id: string, sectionIndex: number, text: string, cfi?: string | null }, score: number, bm25: number, vector: number }[]}
   */
  search(query, options = {}) {
    const limit = options.limit ?? 5;
    const minScore = options.minScore ?? 0;
    const bm25Weight = options.bm25Weight ?? 0.7;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];
    const queryVector = hashVector(queryTokens, this.dim);
    const scored = this.docs.map((doc) => {
      let bm25 = 0;
      for (const term of queryTokens) {
        const tf = doc.termFreq.get(term);
        if (!tf) continue;
        const denominator = tf + K1 * (1 - B + B * (doc.length / (this.averageLength || 1)));
        bm25 += this.idf(term) * (tf * (K1 + 1) / denominator);
      }
      const vector = cosine(queryVector, doc.vector);
      const score = bm25Weight * (bm25 / (bm25 + 3)) + (1 - bm25Weight) * vector;
      return { chunk: doc.chunk, score, bm25, vector };
    });
    return scored.filter((item) => item.score > minScore).sort((a, b) => b.score - a.score).slice(0, limit);
  }
};
function clip(text, maxChars) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}\u2026`;
}

// src/shared/cfi.js
var INTEGER = /^\d+$/;
var CfiError = class extends Error {
  constructor(message, raw) {
    super(message);
    this.name = "CfiError";
    this.cfi = raw;
  }
};
function splitTop(input, delimiter) {
  const out = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}
function parseStep(token, raw) {
  const match = /^(\d+)(?:\[([^\]]*)\])?$/.exec(token);
  if (match === null) {
    throw new CfiError(`invalid CFI step "${token}"`, raw);
  }
  const index = Number(match[1]);
  return { index, id: match[2] ?? null, isText: index % 2 === 1 };
}
function parsePath(piece, raw) {
  let body = piece;
  let offset = null;
  const offsetMatch = /:(\d+)$/.exec(body);
  if (offsetMatch !== null && body.startsWith("/")) {
    offset = Number(offsetMatch[1]);
    body = body.slice(0, offsetMatch.index);
  } else if (body.startsWith(":") && INTEGER.test(body.slice(1))) {
    offset = Number(body.slice(1));
    body = "";
  }
  const steps = [];
  if (body.length > 0) {
    if (!body.startsWith("/")) throw new CfiError(`invalid CFI path "${piece}"`, raw);
    for (const token of body.split("/").slice(1)) {
      if (token.length === 0) continue;
      steps.push(parseStep(token, raw));
    }
  }
  return { steps, offset };
}
function parseSegment(segment, raw) {
  if (segment.length === 0) throw new CfiError("empty CFI segment", raw);
  const paths = [];
  let offset = null;
  const pieces = splitTop(segment, "!");
  for (const piece of pieces) {
    const parsed = parsePath(piece, raw);
    if (parsed.steps.length > 0) paths.push(parsed.steps);
    if (parsed.offset !== null) offset = parsed.offset;
  }
  if (paths.length === 0) throw new CfiError(`CFI segment has no steps: "${segment}"`, raw);
  return { paths, offset };
}
function parseCfi(cfi) {
  if (typeof cfi !== "string") throw new CfiError("CFI must be a string", String(cfi));
  const trimmed = cfi.trim();
  const match = /^epubcfi\((.*)\)$/s.exec(trimmed);
  if (match === null) throw new CfiError(`not an epubcfi: "${trimmed.slice(0, 80)}"`, cfi);
  const inner = match[1];
  const segments = splitTop(inner, ",");
  if (segments.length !== 1 && segments.length !== 3) {
    throw new CfiError(`CFI must have 1 or 3 segments, got ${segments.length}`, cfi);
  }
  const base = parseSegment(segments[0], cfi);
  if (segments.length === 1) {
    return { raw: cfi, range: false, base, start: null, end: null };
  }
  return {
    raw: cfi,
    range: true,
    base,
    start: parseSegment(segments[1], cfi),
    end: parseSegment(segments[2], cfi)
  };
}
function isCfi(value) {
  return typeof value === "string" && /^epubcfi\(.+\)$/s.test(value.trim());
}
function tryParseCfi(value) {
  if (!isCfi(value)) return null;
  try {
    return parseCfi(
      /** @type {string} */
      value
    );
  } catch {
    return null;
  }
}
function packageSteps(parsed) {
  return parsed.base.paths[0] ?? [];
}
function spineIndexOf(input) {
  const parsed = typeof input === "string" ? tryParseCfi(input) : input;
  if (parsed === null) return null;
  const steps = packageSteps(parsed);
  if (steps.length === 0) return null;
  const spinePos = steps.findIndex((step) => step.index === 6);
  let itemref = null;
  if (spinePos >= 0 && steps.length > spinePos + 1) {
    itemref = steps[spinePos + 1];
  } else if (steps.length >= 2) {
    itemref = steps[steps.length - 1];
  }
  if (itemref === null || itemref.isText) return null;
  const index = itemref.index / 2 - 1;
  return index >= 0 ? index : null;
}
function buildCfi(sectionIndex, steps = [], offset = null) {
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) {
    throw new CfiError(`invalid section index: ${sectionIndex}`, "");
  }
  const spinePath = `/6/${2 * (sectionIndex + 1)}`;
  const local = steps.map((step) => `/${step.index}`).join("");
  const suffix = offset !== null ? `:${offset}` : "";
  return `epubcfi(${spinePath}!${local || "/4"}${suffix})`;
}

// src/shared/cards.js
var TAKEAWAY_TYPES = (
  /** @type {const} */
  ["\u7406\u89E3", "\u7591\u95EE", "\u8054\u60F3", "\u8BC4\u4EF7"]
);
var MAX_CARDS = 3;
function coreOf(text, max = 46) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const head = collapsed.slice(0, max);
  const cut = Math.max(head.lastIndexOf("\uFF0C"), head.lastIndexOf("\uFF1B"), head.lastIndexOf("\u3002"), head.lastIndexOf("\u3001"));
  return (cut > max * 0.4 ? head.slice(0, cut) : head) + "\u2026";
}
function deriveCards(takeaway) {
  const summary = (takeaway.aiSummary ?? "").trim();
  if (summary.length === 0) return [];
  const quote = (takeaway.userQuote ?? "").trim();
  const core = coreOf(summary);
  const base = {
    takeawayId: takeaway.id,
    cfi: takeaway.cfi,
    chapterIndex: takeaway.chapterIndex,
    createdAt: takeaway.createdAt
  };
  const cards = [];
  const add = (kind, front, back) => {
    if (cards.length >= MAX_CARDS) return;
    cards.push({
      id: `${takeaway.id}:${cards.length + 1}`,
      ...base,
      front,
      back,
      kind
    });
  };
  switch (takeaway.type) {
    case "\u7406\u89E3":
      add("recall", `\u4E0D\u770B\u4E66\uFF0C\u628A\u8FD9\u70B9\u8BB2\u6E05\u695A\uFF1A${core}`, summary);
      break;
    case "\u7591\u95EE":
      add(
        "question",
        quote.length > 0 ? `\u300C${clip(quote, 28)}\u300D\u2014\u2014${core}` : `\u4F60\u5F53\u65F6\u7684\u7591\u95EE\uFF1A${core}`,
        summary
      );
      break;
    case "\u8054\u60F3":
      add("connect", `\u300C${core}\u300D\u8BA9\u4F60\u60F3\u5230\u4E86\u4EC0\u4E48\uFF1F`, summary);
      break;
    case "\u8BC4\u4EF7":
      add("judge", `\u4F60\u5F53\u65F6\u7684\u5224\u65AD\u662F\uFF1A${core} \u2014\u2014 \u73B0\u5728\u8FD8\u662F\u8FD9\u4E2A\u5224\u65AD\u5417\uFF1F`, summary);
      break;
    default:
      add("recall", core, summary);
  }
  const sentences = splitSentences(summary).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
  for (let i = 1; i < sentences.length && cards.length < MAX_CARDS; i++) {
    const sentence = sentences[i];
    if (sentence.length < 12) continue;
    add("detail", `\u8FD9\u4E00\u70B9\u4F60\u600E\u4E48\u7406\u89E3\uFF1A${coreOf(sentence)}`, `${summary}

\uFF08\u51FA\u81EA\u672C\u6B21\u8BA8\u8BBA\u7684\u7B2C ${i + 1} \u53E5\uFF09`);
  }
  return cards;
}
function takeawayId(input) {
  let hash = 2166136261;
  const material = `${input.type}\0${input.cfi}\0${input.aiSummary}\0${Math.floor(input.createdAt / 6e4)}`;
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `t${(hash >>> 0).toString(36)}`;
}
function isTakeaway(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = (
    /** @type {Record<string, unknown>} */
    value
  );
  return typeof candidate.type === "string" && TAKEAWAY_TYPES.includes(
    /** @type {'理解'} */
    candidate.type
  ) && typeof candidate.cfi === "string" && candidate.cfi.startsWith("epubcfi(") && typeof candidate.aiSummary === "string" && candidate.aiSummary.trim().length > 0 && typeof candidate.chapterIndex === "number";
}

// src/host/books.js
var Library = class {
  /** @param {Store} [store] */
  constructor(store = new Store()) {
    this.store = store;
    this.sectionCache = /* @__PURE__ */ new Map();
    this.chunkCache = /* @__PURE__ */ new Map();
    this.indexCache = /* @__PURE__ */ new Map();
  }
  async ensureLayout() {
    await this.store.ensureLayout();
  }
  /** @returns {Promise<any[]>} */
  async list() {
    return this.store.listBooks();
  }
  /** @param {string} bookId */
  async meta(bookId) {
    const meta = await readJson(this.store.bookPath(bookId, "meta.json"), null);
    if (!meta) return null;
    const tocStale = !Array.isArray(meta.toc) || meta.toc.length === 0 || (meta.tocVersion ?? 1) < 2;
    if (tocStale) {
      try {
        const bytes = await this.sourceBytes(bookId);
        if (bytes) {
          meta.toc = parseEpub(bytes).toc ?? [];
          meta.tocVersion = 2;
          await writeJson(this.store.bookPath(bookId, "meta.json"), meta);
        }
      } catch {
        meta.toc = [];
      }
    }
    return meta;
  }
  /**
   * Import any supported format. Non-EPUB input is normalized into an EPUB
   * first, so rendering, spine numbering and the CFI space stay one thing.
   * @param {Buffer} bytes
   * @param {{ fileName?: string }} [options]
   */
  async importFile(bytes, options = {}) {
    const normalized = normalizeToEpub(bytes, { fileName: options.fileName });
    const meta = await this.importEpub(normalized.epub, options);
    const merged = {
      ...meta,
      format: normalized.format,
      textless: normalized.textless === true,
      warnings: normalized.warnings ?? [],
      originalName: options.fileName ?? null
    };
    await writeJson(this.store.bookPath(meta.id, "meta.json"), merged);
    return merged;
  }
  /**
   * Import an EPUB: parse, persist, chunk.
   * @param {Buffer} bytes
   * @param {{ fileName?: string }} [options]
   */
  async importEpub(bytes, options = {}) {
    const parsed = parseEpub(bytes);
    const id = bookIdFor({ title: parsed.title, bytes });
    const dir = this.store.bookDir(id);
    await this.ensureLayout();
    await fsp2.mkdir(dir, { recursive: true });
    await fsp2.writeFile(this.store.bookPath(id, "source.epub"), bytes);
    const sections = parsed.sections.map((section) => ({
      index: section.index,
      href: section.href,
      path: section.path,
      title: section.title,
      chars: section.chars,
      text: section.text
    }));
    await writeJson(this.store.bookPath(id, "sections.json"), sections);
    const meta = {
      id,
      title: parsed.title,
      author: parsed.author,
      language: parsed.language,
      chapterCount: sections.length,
      toc: parsed.toc ?? [],
      tocVersion: 2,
      sections: sections.map(({ index, href, title, chars }) => ({ index, href, title, chars })),
      fileName: options.fileName ?? null,
      importedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await writeJson(this.store.bookPath(id, "meta.json"), meta);
    this.sectionCache.set(id, sections);
    await this.buildChunks(id, sections);
    return meta;
  }
  /**
   * Cut every section into retrieval chunks and persist them.
   * Chunks carry the section index, which is the spine index an EPUB CFI uses.
   * @param {string} bookId
   * @param {any[]} sections
   */
  async buildChunks(bookId, sections) {
    const chunks = [];
    for (const section of sections) {
      for (const piece of chunkSection(section.text, section.index)) {
        chunks.push({
          id: `${bookId}:${section.index}:${piece.start}`,
          bookId,
          sectionIndex: section.index,
          start: piece.start,
          end: piece.end,
          cfi: buildCfi(section.index),
          text: piece.text
        });
      }
    }
    await writeJson(this.store.bookPath(bookId, "chunks.json"), chunks);
    this.chunkCache.set(bookId, chunks);
    this.indexCache.delete(bookId);
    return chunks;
  }
  /** @param {string} bookId @returns {Promise<any[]>} */
  async sections(bookId) {
    const cached = this.sectionCache.get(bookId);
    if (cached) return cached;
    const sections = await readJson(this.store.bookPath(bookId, "sections.json"), []);
    this.sectionCache.set(bookId, sections);
    return sections;
  }
  /** @param {string} bookId @returns {Promise<any[]>} */
  async chunks(bookId) {
    const cached = this.chunkCache.get(bookId);
    if (cached) return cached;
    let chunks = await readJson(this.store.bookPath(bookId, "chunks.json"), null);
    if (!Array.isArray(chunks) || chunks.length === 0) {
      const sections = await this.sections(bookId);
      if (sections.length === 0) return [];
      chunks = await this.buildChunks(bookId, sections);
    }
    this.chunkCache.set(bookId, chunks);
    return chunks;
  }
  /** @param {string} bookId */
  async index(bookId) {
    const cached = this.indexCache.get(bookId);
    if (cached) return cached;
    const chunks = await this.chunks(bookId);
    const index = new HybridIndex(chunks);
    this.indexCache.set(bookId, index);
    return index;
  }
  /** @param {string} bookId @returns {Promise<any | null>} */
  async progress(bookId) {
    return readJson(this.store.progressPath(bookId), null);
  }
  /**
   * Record where the reader is. The gate reads `sectionIndex`, which is a
   * read-through ceiling: turning back to an earlier chapter must not make
   * later chapters unread again.
   * @param {string} bookId
   * @param {{ cfi?: string | null, positionSectionIndex?: number | null, chapterTitle?: string | null, sectionCount?: number | null }} input
   */
  async saveProgress(bookId, input) {
    const previous = await this.progress(bookId) ?? null;
    const meta = await this.meta(bookId);
    const sectionCount = input.sectionCount ?? meta?.chapterCount ?? null;
    let position = typeof input.positionSectionIndex === "number" && Number.isInteger(input.positionSectionIndex) ? input.positionSectionIndex : null;
    if (position === null && typeof previous?.positionSectionIndex === "number") position = previous.positionSectionIndex;
    if (position === null) position = 0;
    if (typeof sectionCount === "number" && sectionCount > 0) {
      position = Math.min(Math.max(0, position), sectionCount - 1);
    }
    const previousCeiling = typeof previous?.sectionIndex === "number" ? previous.sectionIndex : -1;
    const ceiling = Math.max(previousCeiling, position);
    const section = Array.isArray(meta?.sections) ? meta.sections[position] : null;
    const chapterTitle = input.chapterTitle ?? section?.title ?? previous?.chapterTitle ?? null;
    const ceilingTitle = position >= previousCeiling ? chapterTitle : previous?.ceilingTitle ?? previous?.chapterTitle ?? chapterTitle;
    const next = {
      bookId,
      cfi: typeof input.cfi === "string" && input.cfi.length > 0 ? input.cfi : previous?.cfi ?? null,
      sectionIndex: ceiling,
      positionSectionIndex: position,
      chapterTitle,
      ceilingTitle,
      sectionCount: typeof sectionCount === "number" ? sectionCount : null,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await writeJson(this.store.progressPath(bookId), next);
    return next;
  }
  /** @param {string} bookId */
  async summaries(bookId) {
    const records = await readLines(this.store.logPath("summaries", bookId));
    const latest = /* @__PURE__ */ new Map();
    for (const record of records) {
      if (typeof record?.sectionIndex !== "number") continue;
      const existing = latest.get(record.sectionIndex);
      if (!existing || String(record.generatedAt ?? "") >= String(existing.generatedAt ?? "")) {
        latest.set(record.sectionIndex, record);
      }
    }
    return latest;
  }
  /**
   * Persist one chapter summary. Append-only, one line per generation attempt.
   * @param {string} bookId
   * @param {number} sectionIndex
   * @param {{ summary: string, title?: string, model?: string | null }} input
   */
  async saveSummary(bookId, sectionIndex, input) {
    const record = {
      sectionIndex,
      title: input.title ?? null,
      summary: input.summary,
      model: input.model ?? null,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await appendLine(this.store.logPath("summaries", bookId), record);
    return record;
  }
  /**
   * Read the real text of one section, in a window around a character offset.
   * Callers MUST have passed the spoiler gate for `sectionIndex` first; this
   * method does no gating itself so that the gate stays visible at the entry of
   * each caller instead of being buried in a text accessor.
   * @param {string} bookId
   * @param {number} sectionIndex
   * @param {{ center?: number, before?: number, after?: number }} [options]
   */
  async textWindow(bookId, sectionIndex, options = {}) {
    const sections = await this.sections(bookId);
    const section = sections.find((item) => item.index === sectionIndex);
    if (!section) return null;
    const text = String(section.text ?? "");
    const before = options.before ?? 300;
    const after = options.after ?? 300;
    const center = Math.min(Math.max(0, options.center ?? 0), text.length);
    const start = Math.max(0, center - before);
    const end = Math.min(text.length, center + after);
    return {
      sectionIndex,
      title: section.title ?? null,
      text: text.slice(start, end),
      start,
      end,
      truncatedBefore: start > 0,
      truncatedAfter: end < text.length
    };
  }
  /** @param {string} bookId @param {any} note */
  async addNote(bookId, note) {
    const record = { bookId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), ...note };
    await appendLine(this.store.logPath("notes", bookId), record);
    return record;
  }
  /** @param {string} bookId */
  async notes(bookId) {
    return readLines(this.store.logPath("notes", bookId));
  }
  /** @param {string} bookId @param {any} takeaway */
  async addTakeaway(bookId, takeaway) {
    const record = { bookId, createdAt: (/* @__PURE__ */ new Date()).toISOString(), ...takeaway };
    if (!record.id) {
      record.id = takeawayId({
        type: record.type,
        cfi: record.cfi,
        aiSummary: record.aiSummary,
        createdAt: Date.parse(record.createdAt)
      });
    }
    await appendLine(this.store.logPath("takeaways", bookId), record);
    return record;
  }
  /** @param {string} bookId */
  async takeaways(bookId) {
    return readLines(this.store.logPath("takeaways", bookId));
  }
  /** @param {string} bookId @param {any[]} cards */
  async addCards(bookId, cards) {
    if (!Array.isArray(cards) || cards.length === 0) return [];
    const existing = new Map((await this.cards(bookId)).map((card) => [card.cardId ?? card.id, card]));
    const created = [];
    for (const card of cards) {
      const cardId = card?.id ?? card?.cardId;
      if (!cardId) continue;
      const previous = existing.get(cardId);
      if (previous && previous.front === card.front && previous.back === card.back) continue;
      await appendLine(this.store.logPath("cards", bookId), { bookId, ...card, cardId, createdAt: card.createdAt ?? (/* @__PURE__ */ new Date()).toISOString() });
      created.push(cardId);
    }
    return created;
  }
  /** @param {string} bookId */
  async cardIds(bookId) {
    const cards = await this.cards(bookId);
    return new Set(cards.map((card) => card.cardId ?? card.id));
  }
  /** @param {string} bookId */
  async cards(bookId) {
    const byId = /* @__PURE__ */ new Map();
    for (const line of await readLines(this.store.logPath("cards", bookId))) {
      const cardId = line?.cardId ?? line?.id;
      if (!cardId) continue;
      byId.set(cardId, line);
    }
    return [...byId.values()];
  }
  /** @param {string} bookId @param {any} review */
  async addReview(bookId, review) {
    const record = { bookId, at: (/* @__PURE__ */ new Date()).toISOString(), ...review };
    await appendLine(this.store.logPath("reviews", bookId), record);
    return record;
  }
  /** @param {string} bookId */
  async reviews(bookId) {
    return readLines(this.store.logPath("reviews", bookId));
  }
  /** @param {string} bookId @returns {Promise<Buffer | null>} */
  async sourceBytes(bookId) {
    try {
      return await fsp2.readFile(this.store.bookPath(bookId, "source.epub"));
    } catch {
      return null;
    }
  }
  /** @param {string} bookId */
  async sourceExists(bookId) {
    try {
      await fsp2.stat(this.store.bookPath(bookId, "source.epub"));
      return true;
    } catch {
      return false;
    }
  }
  /** Directory used for the client-visible EPUB path (empty string when none). */
  bookFilePath(bookId) {
    return this.store.bookPath(bookId, "source.epub");
  }
  /** @param {string} bookId */
  async sectionDirectory(bookId) {
    const meta = await this.meta(bookId);
    return Array.isArray(meta?.sections) ? meta.sections : [];
  }
  /** @param {string} bookId */
  async stats(bookId) {
    const [takeaways, cards, reviews, notes] = await Promise.all([
      this.takeaways(bookId),
      this.cards(bookId),
      this.reviews(bookId),
      this.notes(bookId)
    ]);
    return {
      takeaways: takeaways.length,
      cards: cards.length,
      reviews: reviews.length,
      notes: notes.length,
      bookPath: this.bookFilePath(bookId),
      dir: path3.dirname(this.bookFilePath(bookId))
    };
  }
};

// src/shared/spoiler.js
var GATE_CODES = (
  /** @type {const} */
  {
    allowed: "allowed",
    noProgress: "no-progress",
    unknownTarget: "unknown-target",
    unread: "unread",
    disabled: "disabled"
  }
);
function decision(sectionIndex, readThrough, code, reason) {
  return { allowed: code === GATE_CODES.allowed, code, sectionIndex, readThrough, reason };
}
function resolveSectionIndex(target) {
  if (target === null || target === void 0) return null;
  const explicit = typeof target.sectionIndex === "number" && Number.isInteger(target.sectionIndex) && target.sectionIndex >= 0 ? target.sectionIndex : null;
  const anchored = typeof target.cfi === "string" && target.cfi.length > 0 ? spineIndexOf(target.cfi) : null;
  if (anchored !== null) {
    if (explicit !== null && explicit !== anchored) return null;
    return anchored;
  }
  return explicit;
}
function gateTarget(target, progress, options = {}) {
  if (options.enabled === false) {
    return decision(resolveSectionIndex(target ?? {}), null, GATE_CODES.disabled, "\u8FDB\u5EA6\u95E8\u5DF2\u5173\u95ED\uFF08\u4EC5\u9650\u4E0D\u8BFB\u53D6\u539F\u6587\u7684\u73AF\u8282\uFF09");
  }
  const readThrough = progress && typeof progress.sectionIndex === "number" && Number.isInteger(progress.sectionIndex) ? progress.sectionIndex : null;
  if (readThrough === null) {
    return decision(
      resolveSectionIndex(target ?? {}),
      null,
      GATE_CODES.noProgress,
      "\u8FD9\u672C\u4E66\u8FD8\u6CA1\u6709\u53EF\u9760\u7684\u8FDB\u5EA6\u8BB0\u5F55\uFF0C\u56E0\u6B64\u6CA1\u6709\u4EFB\u4F55\u4E00\u7AE0\u53EF\u4EE5\u5F53\u4F5C\u201C\u5DF2\u8BFB\u201D\u3002\u5148\u8BA9\u8BFB\u8005\u6253\u5F00\u4E66\u3001\u7FFB\u5230\u81EA\u5DF1\u7684\u4F4D\u7F6E\u3002"
    );
  }
  const sectionIndex = resolveSectionIndex(target ?? {});
  if (sectionIndex === null) {
    return decision(
      null,
      readThrough,
      GATE_CODES.unknownTarget,
      `\u65E0\u6CD5\u628A\u8FD9\u4E2A\u4F4D\u7F6E\u5F52\u5C5E\u5230\u67D0\u4E00\u7AE0\uFF08\u8FDB\u5EA6\uFF1A\u7B2C ${readThrough + 1} \u7AE0\uFF09\u3002\u62D2\u7EDD\u8BBF\u95EE\u3002`
    );
  }
  const limit = options.allowAtBoundary === false ? readThrough - 1 : readThrough;
  if (sectionIndex > limit) {
    return decision(
      sectionIndex,
      readThrough,
      GATE_CODES.unread,
      `\u7B2C ${sectionIndex + 1} \u7AE0\u5728\u8BFB\u8005\u8FDB\u5EA6\uFF08\u7B2C ${readThrough + 1} \u7AE0\uFF09\u4E4B\u540E\uFF0C\u672A\u8BFB\u539F\u6587\u4E0E\u672A\u8BFB\u6458\u8981\u90FD\u4E0D\u5728\u53EF\u53D6\u8303\u56F4\u5185\u3002`
    );
  }
  return decision(sectionIndex, readThrough, GATE_CODES.allowed, "\u5728\u8BFB\u8303\u56F4\u5185");
}
function requireReadable(target, progress, options = {}) {
  const result = gateTarget(target, progress, options);
  if (!result.allowed) {
    const error = new Error(`${options.what ?? "\u8BFB\u53D6\u539F\u6587"}\u88AB\u8FDB\u5EA6\u95E8\u62D2\u7EDD\uFF1A${result.reason}`);
    error.name = "SpoilerGateError";
    error.code = result.code;
    error.gate = result;
    throw error;
  }
  return result;
}
function filterReadable(chunks, progress, options = {}) {
  const readThrough = progress?.sectionIndex;
  if (typeof readThrough !== "number" || !Number.isInteger(readThrough)) return [];
  const limit = options.allowAtBoundary === false ? readThrough - 1 : readThrough;
  return chunks.filter((chunk) => typeof chunk.sectionIndex === "number" && chunk.sectionIndex <= limit);
}
function summaryCeiling(progress) {
  const readThrough = progress?.sectionIndex;
  if (typeof readThrough !== "number" || !Number.isInteger(readThrough)) return -1;
  return readThrough;
}
function describeProgress(progress, extra = {}) {
  const readThrough = progress?.sectionIndex;
  if (typeof readThrough !== "number" || !Number.isInteger(readThrough)) {
    return "\u8BFB\u8005\u5C1A\u672A\u7ED9\u51FA\u8FDB\u5EA6\uFF1A\u8FD9\u672C\u4E66\u6CA1\u6709\u4EFB\u4F55\u4E00\u7AE0\u5904\u4E8E\u201C\u5DF2\u8BFB\u201D\u72B6\u6001\uFF0C\u5148\u9080\u8BF7\u8BFB\u8005\u6253\u5F00\u4E66\u3001\u7FFB\u5230\u81EA\u5DF1\u7684\u4F4D\u7F6E\u3002";
  }
  const book = extra.bookTitle ? `\u300A${extra.bookTitle}\u300B` : "\u672C\u4E66";
  const position = progress?.positionSectionIndex;
  const sameSpot = typeof position !== "number" ? true : position === readThrough;
  const ceilingTitle = (typeof progress?.ceilingTitle === "string" && progress.ceilingTitle.length > 0 ? progress.ceilingTitle : null) ?? (sameSpot ? progress?.chapterTitle ?? extra.chapterTitle ?? null : null);
  const total = extra.sectionCount;
  const where = ceilingTitle ? `\u7B2C ${readThrough + 1} \u7AE0\u300C${ceilingTitle}\u300D` : `\u7B2C ${readThrough + 1} \u7AE0`;
  const tail = total ? `\uFF08\u5168\u4E66 ${total} \u7AE0\uFF09` : "";
  const now = !sameSpot && typeof position === "number" ? `\uFF0C\u73B0\u5728\u505C\u5728\u7B2C ${position + 1} \u7AE0${progress?.chapterTitle ? `\u300C${progress.chapterTitle}\u300D` : ""}` : "";
  return `${book}${tail}\uFF1A\u8BFB\u8005\u5DF2\u8BFB\u5230${where}${now}\u3002\u53EF\u53D6\u8303\u56F4 = \u7B2C 1 \u7AE0\u81F3\u7B2C ${readThrough + 1} \u7AE0\uFF1B\u6B64\u540E\u5404\u7AE0\u7684\u539F\u6587\u4E0E\u6458\u8981\u90FD\u4E0D\u5B58\u5728\u4E8E\u4F60\u7684\u4E0A\u4E0B\u6587\u91CC\u3002`;
}

// src/host/context.js
var ReadIndexCache = class {
  constructor(limit = 6) {
    this.limit = limit;
    this.cache = /* @__PURE__ */ new Map();
  }
  /**
   * @param {import('./books.js').Library} library
   * @param {string} bookId
   * @param {any} progress
   */
  async indexFor(library, bookId, progress) {
    const ceiling = typeof progress?.sectionIndex === "number" ? progress.sectionIndex : -1;
    const key = `${bookId}@${ceiling}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const chunks = await library.chunks(bookId);
    const readable = filterReadable(chunks, progress);
    if (readable.length === 0) return null;
    const index = new HybridIndex(readable);
    this.cache.set(key, index);
    if (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== void 0) this.cache.delete(oldest);
    }
    return index;
  }
};
function progressLine(progress, extra = {}) {
  return describeProgress(progress, extra);
}
async function summaryIndexText(library, bookId, progress, options = {}) {
  const ceiling = progress?.sectionIndex;
  if (typeof ceiling !== "number" || !Number.isInteger(ceiling)) return "";
  const meta = await library.meta(bookId);
  const sections = Array.isArray(meta?.sections) ? meta.sections : [];
  const summaries = await library.summaries(bookId);
  const maxChapters = options.maxChapters ?? 120;
  const lines = [];
  const start = Math.max(0, ceiling - maxChapters + 1);
  if (start > 0) lines.push(`\uFF08\u7B2C 1 \u81F3 ${start} \u7AE0\u7684\u6458\u8981\u672A\u6CE8\u5165\uFF0C\u9700\u8981\u65F6\u53EF\u8BA9\u5DE5\u5177\u8BFB\u53D6\u3002\uFF09`);
  for (let index = start; index <= ceiling; index += 1) {
    const section = sections[index];
    const record = summaries.get(index);
    const title = section?.title ? `\u300C${section.title}\u300D` : "";
    if (record?.summary) lines.push(`\u7B2C ${index + 1} \u7AE0${title}\uFF1A${record.summary}`);
    else lines.push(`\u7B2C ${index + 1} \u7AE0${title}\uFF1A\uFF08\u6458\u8981\u8FD8\u6CA1\u751F\u6210\uFF0C\u6B63\u6587\u53EF\u7528 read_text_window \u8BFB\u53D6\uFF09`);
  }
  return lines.join("\n");
}
async function selectionWindow(library, bookId, progress, selection) {
  const sectionIndex = resolveSectionIndex({ cfi: selection.cfi, sectionIndex: selection.sectionIndex });
  requireReadable({ sectionIndex }, progress, { what: "\u8BFB\u53D6\u9009\u4E2D\u539F\u6587" });
  const index = (
    /** @type {number} */
    sectionIndex
  );
  const sections = await library.sections(bookId);
  const section = sections.find((item) => item.index === index);
  const fullText = String(section?.text ?? "");
  const quote = typeof selection.quote === "string" ? selection.quote.trim() : "";
  let center = 0;
  if (quote) {
    const at = fullText.indexOf(quote);
    center = at >= 0 ? at + Math.floor(quote.length / 2) : 0;
  }
  const window = await library.textWindow(bookId, index, {
    center,
    before: selection.before ?? 300,
    after: selection.after ?? 300
  });
  return {
    sectionIndex: index,
    title: window?.title ?? null,
    text: window?.text ?? "",
    window
  };
}
async function retrieveRead(library, cache, bookId, progress, query, options = {}) {
  const index = await cache.indexFor(library, bookId, progress);
  if (!index) return [];
  return index.search(query, { limit: options.limit ?? 4 }).map((hit) => ({
    sectionIndex: hit.chunk.sectionIndex,
    cfi: hit.chunk.cfi ?? buildCfi(hit.chunk.sectionIndex),
    score: Number(hit.score.toFixed(4)),
    text: clip(hit.chunk.text, 500)
  }));
}
function retrievalText(hits) {
  if (!hits || hits.length === 0) return "";
  return hits.map((hit, index) => `\u3014${index + 1}\u3015\u7B2C ${hit.sectionIndex + 1} \u7AE0
${hit.text}`).join("\n\n");
}

// src/host/guidance.js
var RULES = `\u4F60\u662F\u8FD9\u672C\u4E66\u7684\u4F34\u8BFB\uFF0C\u4E0D\u662F\u66FF\u8BFB\u8005\u8BFB\u4E66\u7684\u4EBA\u3002

\u3010\u8EAB\u4EFD\u3011
\u8BFB\u8005\u5DF2\u7ECF\u8BFB\u5230\u8FD9\u91CC\u4E86\uFF1B\u4F60\u53EA\u548C\u4ED6\u8BA8\u8BBA\u4ED6\u8BFB\u8FC7\u7684\u90E8\u5206\u3002\u4ED6\u7684\u8FDB\u5EA6\u3001\u5DF2\u8BFB\u7AE0\u8282\u6458\u8981\u3001\u4EE5\u53CA\u4ED6\u8FD9\u4E00\u6BB5\u9009\u4E2D\u7684\u539F\u6587\uFF0C\u4F1A\u968F\u4E0B\u9762\u4E00\u8D77\u7ED9\u4F60\u3002\u4F60\u4E0D\u9700\u8981\u3001\u4E5F\u4E0D\u5E94\u8BE5\u66FF\u4ED6\u628A\u4E66\u8BFB\u4E0B\u53BB\u3002

\u3010\u9ED8\u8BA4\u52A8\u4F5C\u662F\u63D0\u95EE\uFF0C\u4E0D\u662F\u56DE\u7B54\u3011
- \u8BFB\u8005\u63D0\u51FA\u89E3\u91CA\u6027\u3001\u8BC4\u4EF7\u6027\u7684\u95EE\u9898\u65F6\uFF1A\u5148\u7528\u4E00\u53E5\u8BDD\u628A\u4ED6\u95EE\u9898\u91CC\u9884\u8BBE\u7684\u4E1C\u897F\u590D\u8FF0\u51FA\u6765\uFF08"\u4F60\u89C9\u5F97\u4ED6\u8FD9\u6B21\u9053\u6B49\u662F\u771F\u5FC3\u8FD8\u662F\u7B56\u7565\u2014\u2014"\uFF09\uFF0C\u7136\u540E\u53EA\u7ED9\u4E00\u4E2A\u5177\u4F53\u3001\u4ED6\u80FD\u9A6C\u4E0A\u56DE\u7B54\u7684\u8FFD\u95EE\uFF08\u6307\u5230\u67D0\u4E00\u53E5\u3001\u67D0\u4E2A\u4EBA\u3001\u67D0\u4E2A\u52A8\u4F5C\uFF09\u3002\u4E0D\u8981\u4E0B\u7ED3\u8BBA\uFF0C\u4E0D\u8981\u7ED9\u5224\u51B3\u3002
- \u53EA\u6709\u5F53\u95EE\u9898\u786E\u5B9E\u662F"\u4E8B\u5B9E\u578B"\uFF08\u67D0\u4E2A\u4EBA\u662F\u8C01\u3001\u67D0\u4EF6\u4E8B\u53D1\u751F\u5728\u54EA\u3001\u8FD9\u53E5\u8BDD\u4EC0\u4E48\u610F\u601D\uFF09\u65F6\uFF0C\u624D\u76F4\u63A5\u56DE\u7B54\uFF1B\u56DE\u7B54\u53EA\u7528\u5DF2\u8BFB\u8303\u56F4\u5185\u7684\u5185\u5BB9\uFF0C\u7136\u540E\u7528\u4E00\u4E2A\u8F7B\u7684\u8FFD\u95EE\u6536\u5C3E\u3002
- \u8FFD\u95EE\u8981\u5177\u4F53\uFF1A\u53EF\u4EE5\u6307\u5411\u67D0\u4E00\u53E5\u539F\u6587\u3001\u67D0\u4E2A\u4EBA\u7684\u9009\u62E9\u3001\u67D0\u4E2A\u53CD\u590D\u51FA\u73B0\u7684\u7EC6\u8282\u3002\u4E0D\u8981\u95EE"\u4F60\u89C9\u5F97\u5462""\u4F60\u600E\u4E48\u770B"\u8FD9\u79CD\u7A7A\u95EE\u9898\u3002

\u3010\u53EA\u5C31\u7ED9\u5B9A\u7684\u6587\u5B57\u8BA8\u8BBA\u3011
\u8BA8\u8BBA\u67D0\u4E00\u6BB5\u65F6\uFF0C\u53EA\u7528\u6CE8\u5165\u7ED9\u4F60\u7684"\u9009\u4E2D\u539F\u6587"\u90A3\u4E00\u6BB5\u3002\u4E0D\u8981\u51ED\u8BAD\u7EC3\u8BB0\u5FC6\u8865\u5145\u4E66\u91CC\u7684\u5176\u4ED6\u7EC6\u8282\u3001\u4F5C\u8005\u751F\u5E73\u3001\u6539\u7F16\u5267\u60C5\u6216\u522B\u4EBA\u7684\u8BC4\u8BBA\u3002\u4E0A\u4E0B\u6587\u91CC\u6CA1\u6709\u7684\uFF0C\u5C31\u8BF4\u4F60\u770B\u4E0D\u5230\uFF0C\u4E0D\u8981\u7F16\u3002

\u3010\u4E0D\u505A\u5143\u5C42\u9762\u7684\u6697\u793A\u3011
\u7EDD\u4E0D\u8BF4"\u540E\u9762\u6709\u53CD\u8F6C""\u71AC\u8FC7\u8FD9\u4E00\u6BB5\u5C31\u597D""\u6CE8\u610F\u8FD9\u4E00\u7AE0\u4E4B\u540E""\u73B0\u5728\u8FD8\u4E0D\u80FD\u544A\u8BC9\u4F60""\u7B49\u4F60\u8BFB\u5230\u2026\u2026\u5C31\u660E\u767D\u4E86"\u8FD9\u7C7B\u8BDD\u3002\u4E0D\u8981\u8BC4\u4EF7\u8282\u594F\u5FEB\u6162\u3001\u4E0D\u8981\u6697\u793A\u63A5\u4E0B\u6765\u4F1A\u53D8\u597D\u6216\u53D8\u7CDF\u3001\u4E0D\u8981\u63D0\u793A\u67D0\u4E2A\u4EBA\u7269\u4EE5\u540E\u8FD8\u6709\u620F\u3002\u4F60\u624B\u4E0A\u6CA1\u6709\u540E\u9762\u7684\u4E1C\u897F\uFF0C\u4E5F\u4E0D\u8981\u5047\u88C5\u6709\u3002

\u3010\u8BFB\u8005\u5212\u7EBF\u3001\u8D34\u4E00\u53E5\u8BDD\u3001\u53EA\u662F\u611F\u53F9\u65F6\u3011
\u63A5\u4F4F\u8FD9\u4E2A\u53CD\u5E94\u672C\u8EAB\uFF1A\u8BF4\u6E05\u4F60\u5728\u4ED6\u5212\u7684\u8FD9\u53E5\u8BDD\u91CC\u770B\u5230\u4EC0\u4E48\uFF0C\u6216\u8005\u95EE\u4E00\u53E5\u4ED6\u5F53\u65F6\u7684\u53CD\u5E94\u3002\u4E0D\u8981\u628A\u5212\u7EBF\u8F6C\u6210\u7AE0\u8282\u6458\u8981\uFF0C\u4E5F\u4E0D\u8981\u94FA\u5F00\u957F\u7BC7\u5206\u6790\u3002

\u3010\u6536\u53E3\u3011
\u4E00\u6BB5\u8BA8\u8BBA\u7ED3\u675F\u65F6\uFF08\u8BFB\u8005\u8868\u793A\u544A\u4E00\u6BB5\u843D\u3001\u6216\u8BDD\u9898\u81EA\u7136\u6536\u4F4F\uFF09\uFF0C\u7528\u4E00\u53E5\u8BDD\u628A\u4F60\u7406\u89E3\u7684\u4ED6\u7684\u6536\u83B7\u8BF4\u6E05\u695A\uFF0C\u5E76\u8C03\u7528 save_takeaway \u628A\u5B83\u5B58\u4E0B\u6765\uFF1Atype \u53D6"\u7406\u89E3/\u7591\u95EE/\u8054\u60F3/\u8BC4\u4EF7"\uFF0CaiSummary \u7528\u4E00\u4E24\u53E5\u5199\u4ED6\u81EA\u5DF1\u60F3\u5230\u7684\u4E1C\u897F\uFF0C\u4E0D\u8981\u590D\u8FF0\u539F\u6587\u3002`;
function contextBlock(parts) {
  const lines = [];
  lines.push("\u3010\u8BFB\u8005\u8FDB\u5EA6\u3011");
  lines.push(parts.progressLine);
  lines.push("");
  lines.push("\u3010\u5DF2\u8BFB\u7AE0\u8282\u7D22\u5F15\u3011");
  lines.push(parts.summaryIndex || "\uFF08\u8FD8\u6CA1\u6709\u7AE0\u8282\u6458\u8981\u3002\u53EA\u6709\u8BFB\u8005\u5F53\u524D\u6240\u5728\u7AE0\u53CA\u4E4B\u524D\u7684\u7AE0\u4F1A\u6709\u6458\u8981\u3002\uFF09");
  if (parts.window) {
    lines.push("");
    lines.push("\u3010\u9009\u4E2D\u539F\u6587\u3011");
    lines.push("\u8FD9\u662F\u8BFB\u8005\u6B64\u523B\u9009\u4E2D\u7684\u6BB5\u843D\uFF0C\u524D\u540E\u5404\u7559\u4E86\u4E00\u70B9\u771F\u5B9E\u539F\u6587\u7528\u4E8E\u7406\u89E3\u4E0A\u4E0B\u6587\u3002\u53EA\u5C31\u8FD9\u6BB5\u6587\u5B57\u672C\u8EAB\u8BA8\u8BBA\uFF0C\u4E0D\u51ED\u8BAD\u7EC3\u8BB0\u5FC6\u8865\u5145\u7EC6\u8282\u3002");
    lines.push("");
    lines.push(parts.window);
  }
  if (parts.retrieval) {
    lines.push("");
    lines.push("\u3010\u5DF2\u8BFB\u8303\u56F4\u5185\u7684\u76F8\u5173\u6BB5\u843D\u3011");
    lines.push(parts.retrieval);
  }
  if (parts.readerNote) {
    lines.push("");
    lines.push("\u3010\u8BFB\u8005\u7684\u5212\u7EBF/\u6279\u6CE8\u3011");
    lines.push(parts.readerNote);
  }
  return lines.join("\n");
}
function singleTurnSystem(parts) {
  return [RULES, "", contextBlock(parts)].join("\n");
}
function closingSystem(parts) {
  const items = parts.takeaways.map((item, index) => {
    const quote = item.userQuote ? `
   \u4ED6\u5212\u7684\u539F\u53E5\uFF1A\u300C${item.userQuote}\u300D` : "";
    return `  ${index + 1}. [${item.type}] ${item.aiSummary}${quote}`;
  }).join("\n");
  return `\u4F60\u662F\u8FD9\u672C\u4E66\u7684\u4F34\u8BFB\u3002\u73B0\u5728\u662F\u672C\u7AE0\u6536\u53E3\uFF0C\u4E0D\u662F\u5199\u8BFB\u4E66\u7B14\u8BB0\u7ED9\u522B\u4EBA\u770B\u3002

\u3010\u53EA\u770B\u8BFB\u8005\u81EA\u5DF1\u7684\u8BA8\u8BBA\u3011
\u4E0B\u9762\u8FD9\u4E9B\u662F\u8FD9\u4F4D\u8BFB\u8005\u5728\u8FD9\u4E00\u7AE0\u91CC\u548C\u4F60\u804A\u51FA\u6765\u7684\u4E1C\u897F\uFF0C\u4E0D\u662F\u4E66\u91CC\u7684\u539F\u6587\u3002\u4F60\u624B\u4E0A\u6CA1\u6709\u8FD9\u4E00\u7AE0\u7684\u539F\u6587\uFF0C\u4E5F\u4E0D\u8981\u590D\u8FF0\u60C5\u8282\u3001\u4E0D\u8981\u8865\u5145\u4E66\u91CC\u5176\u4ED6\u7EC6\u8282\u3001\u4E0D\u8981\u8BC4\u4EF7\u8FD9\u672C\u4E66\u3002

\u3010\u8981\u5199\u6210\u4EC0\u4E48\u6837\u3011
- \u7528\u7B2C\u4E8C\u4EBA\u79F0"\u4F60"\uFF0C\u4E09\u5230\u4E94\u53E5\uFF0C\u53EA\u8BF4\u4ED6\u81EA\u5DF1\u60F3\u5230\u7684\u90A3\u4E9B\u3002
- \u6307\u51FA\u4ED6\u8FD9\u4E00\u7AE0\u53CD\u590D\u5728\u610F\u7684\u70B9\uFF08\u53EF\u80FD\u662F\u4E00\u53E5\u8BDD\u3001\u4E00\u4E2A\u4EBA\u3001\u4E00\u4E2A\u4ED6\u8FD8\u6CA1\u60F3\u901A\u7684\u5730\u65B9\uFF09\u3002
- \u5982\u679C\u5217\u8868\u91CC\u6709"\u7591\u95EE"\u7C7B\u7684\u6536\u83B7\uFF0C\u628A\u5B83\u653E\u5230\u6700\u540E\uFF0C\u4F5C\u4E3A\u4E00\u4E2A\u8FD8\u5F00\u7740\u7684\u53E3\u5B50\u3002
- \u4E0D\u8981\u7F57\u5217\uFF0C\u4E0D\u8981\u5206\u70B9\uFF0C\u4E0D\u8981\u4E0B\u7ED3\u8BBA\uFF0C\u4E0D\u8981\u8BF4\u4ED6"\u7406\u89E3\u5F97\u5F88\u5230\u4F4D"\u8FD9\u79CD\u8BC4\u4EF7\u3002
- \u4E0D\u8981\u63D0\u4EFB\u4F55\u4ED6\u6CA1\u5728\u8BA8\u8BBA\u91CC\u63D0\u5230\u7684\u4EBA\u7269\u6216\u60C5\u8282\u3002

\u3010\u8BFB\u8005\u8FDB\u5EA6\u3011
${parts.progressLine}

\u3010\u8FD9\u4E00\u7AE0\u7684\u8BA8\u8BBA\uFF08\u8BFB\u8005\u81EA\u5DF1\u7684\u6536\u83B7\uFF09\u3011
${parts.chapterTitle ? `\u7AE0\u8282\uFF1A${parts.chapterTitle}
` : ""}${items}`;
}

// src/host/guard.js
var GATED_TOOLS = /* @__PURE__ */ new Set([
  "read_text_window",
  "search_read_text",
  "chapter_summary",
  "save_takeaway",
  "chapter_closing",
  "reading_context"
]);
function installGuard(deps) {
  const { ctx, state, config, progressSync, bookIds } = deps;
  const guard = (exec) => {
    if (!exec || typeof exec.name !== "string" || !GATED_TOOLS.has(exec.name)) return void 0;
    if (config?.spoilerGate === false) return void 0;
    const args = exec.arguments;
    if (!args || typeof args !== "object") return void 0;
    const target = {
      cfi: typeof args.cfi === "string" ? args.cfi : null,
      sectionIndex: typeof args.sectionIndex === "number" ? args.sectionIndex : null
    };
    if (target.cfi === null && target.sectionIndex === null) return void 0;
    let bookId = typeof args.bookId === "string" && args.bookId.length > 0 ? args.bookId : state.activeBookId;
    if (!bookId) {
      const known = bookIds?.() ?? [];
      if (known.length === 1) bookId = known[0];
    }
    if (!bookId) {
      return "\u9605\u8BFB\u4F4D\u7F6E\u95E8\u62D2\u7EDD\u4E86\u8FD9\u6B21\u8C03\u7528\uFF1A\u65E0\u6CD5\u786E\u8BA4\u8FD9\u6B21\u8BBF\u95EE\u5C5E\u4E8E\u54EA\u4E00\u672C\u4E66\uFF0C\u56E0\u6B64\u65E0\u6CD5\u6838\u5BF9\u8BFB\u8005\u7684\u9605\u8BFB\u8FDB\u5EA6\u3002\u8BF7\u5728\u53C2\u6570\u91CC\u5199\u660E bookId\u3002";
    }
    const progress = progressSync(bookId);
    const gate = gateTarget(target, progress);
    if (gate.allowed) return void 0;
    const readThrough = Number.isInteger(progress?.sectionIndex) ? `\u8BFB\u8005\u5DF2\u8BFB\u5230\u7B2C ${progress.sectionIndex + 1} \u7AE0` : "\u8FD9\u672C\u4E66\u8FD8\u6CA1\u6709\u8FDB\u5EA6\u8BB0\u5F55";
    return `\u9605\u8BFB\u4F4D\u7F6E\u95E8\u62D2\u7EDD\u4E86\u8FD9\u6B21\u8C03\u7528\uFF1A\u8FD9\u6B21\u8981\u8BBF\u95EE\u7684\u4F4D\u7F6E\u4E0D\u5728\u8BFB\u8005\u5DF2\u8BFB\u7684\u8303\u56F4\u5185\uFF08${readThrough}\uFF09\u3002\u672A\u8BFB\u7AE0\u8282\u7684\u539F\u6587\u548C\u6458\u8981\u90FD\u4E0D\u4F1A\u63D0\u4F9B\uFF0C\u4E5F\u4E0D\u8981\u7528\u5176\u4ED6\u9014\u5F84\u8865\u8DB3\u3002\u9700\u8981\u7684\u8BDD\uFF0C\u5148\u8BF7\u8BFB\u8005\u5F80\u4E0B\u8BFB\u3002`;
  };
  return ctx.tools.guard(guard);
}

// vendor/supermemo2/sm2.js
function calcFactor(oldFac, quality) {
  return oldFac + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
}
function sm2_default(quality, lastSchedule, lastFactor) {
  let newFac;
  let curSchedule;
  if (quality == null || quality < 0 || quality > 5) {
    quality = 0;
  }
  if (quality < 3) {
    newFac = lastFactor;
    curSchedule = 1;
  } else {
    if (lastSchedule === 1) {
      curSchedule = 6;
      newFac = lastFactor;
    } else if (lastSchedule == null) {
      curSchedule = 1;
      newFac = 2.5;
    } else {
      newFac = calcFactor(lastFactor, quality);
      if (newFac < 1.3) {
        newFac = 1.3;
      }
      curSchedule = Math.round(lastSchedule * newFac);
    }
  }
  return {
    factor: newFac,
    schedule: curSchedule,
    isRepeatAgain: quality < 4
  };
}

// src/shared/scheduler.js
var QUALITY = (
  /** @type {const} */
  {
    /** "还要再想想" — the reader wants this takeaway again soon. */
    rethink: 3,
    /** "先放着" — seen, keep it in rotation. */
    settled: 4,
    /** "已经想明白了" — push it far out. */
    got: 5
  }
);
var INITIAL_STATE = (
  /** @type {const} */
  {
    interval: 0,
    factor: 2.5,
    repetitions: 0,
    dueAt: 0
  }
);
var DAY = 24 * 60 * 60 * 1e3;
var RETIRE_AFTER_DAYS = 3650;
function applyReview(state, quality, now = Date.now()) {
  const current = state ?? INITIAL_STATE;
  if (current.retired) return current;
  const clamped = Math.max(0, Math.min(5, Math.round(quality)));
  const result = sm2_default(clamped, current.interval === 0 ? null : current.interval, current.factor);
  const interval = Math.max(1, Math.round(result.schedule));
  return {
    interval,
    factor: result.factor,
    repetitions: clamped < 3 ? 0 : (current.repetitions ?? 0) + 1,
    dueAt: now + interval * DAY
  };
}
function retire(state, now = Date.now()) {
  return {
    ...state ?? INITIAL_STATE,
    retired: true,
    dueAt: now + RETIRE_AFTER_DAYS * DAY
  };
}
function replay(events) {
  let state = { ...INITIAL_STATE, dueAt: 0 };
  const normalized = (events ?? []).map((event) => ({ ...event, at: toEpoch(event.at) }));
  const sorted = normalized.sort((a, b) => a.at - b.at);
  for (const event of sorted) {
    if (event.action === "retire") {
      state = retire(state, event.at);
      continue;
    }
    if (typeof event.quality === "number") {
      state = applyReview(state, event.quality, event.at);
    }
  }
  return state;
}
function toEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}
function describeDue(state, now = Date.now()) {
  if (!state) return "\u672A\u5B89\u6392";
  if (state.retired) return "\u5DF2\u6536\u8D77";
  const delta = state.dueAt - now;
  if (delta <= 0) return "\u73B0\u5728\u53EF\u4EE5\u56DE\u987E";
  const days = Math.round(delta / DAY);
  if (days <= 1) return "\u660E\u5929";
  if (days < 30) return `${days} \u5929\u540E`;
  return `${Math.round(days / 30)} \u4E2A\u6708\u540E`;
}

// src/host/progress-view.js
function resolvedReadthrough(progress, meta) {
  if (!progress) return null;
  const sections = Array.isArray(meta?.sections) ? meta.sections : [];
  const ceiling = typeof progress.sectionIndex === "number" ? progress.sectionIndex : null;
  const position = typeof progress.positionSectionIndex === "number" ? progress.positionSectionIndex : ceiling;
  const chapterCount = typeof meta?.chapterCount === "number" ? meta.chapterCount : sections.length;
  return {
    ceiling,
    position,
    chapterCount,
    ceilingTitle: ceiling !== null ? sections[ceiling]?.title ?? null : null,
    positionTitle: position !== null ? sections[position]?.title ?? null : null,
    atCeiling: ceiling !== null && position === ceiling,
    updatedAt: progress.updatedAt ?? null
  };
}

// src/host/model.js
function optionalService(ctx, name2) {
  const readers = [() => ctx.reflect?.get?.(name2, false), () => ctx.get?.(name2)];
  for (const read of readers) {
    try {
      const service = read();
      if (service) return service;
    } catch {
    }
  }
  return null;
}
function resolveRoute(ctx, config, preferred = null) {
  const currentSelection = () => {
    const selection = optionalService(ctx, "agentDefaultModel")?.currentSelection?.();
    return selection?.provider && selection?.model ? selection : null;
  };
  const fallback = currentSelection();
  const provider = config.summaryProvider || preferred?.provider || fallback?.provider;
  const model = config.summaryModel || preferred?.model || fallback?.model;
  if (!provider || !model) return null;
  return { provider, model };
}
async function streamText(ctx, call) {
  const messages = [];
  if (call.system) messages.push({ role: "system", content: [{ type: "text", text: call.system }] });
  messages.push({ role: "user", content: [{ type: "text", text: call.prompt }] });
  let text = "";
  let failure = null;
  let finish = null;
  let reasoning = 0;
  const llm = optionalService(ctx, "llm");
  if (!llm || typeof llm.stream !== "function") {
    const error = new Error("\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\u670D\u52A1");
    error.code = "NO_LLM";
    throw error;
  }
  const stream = llm.stream({
    provider: call.provider,
    model: call.model,
    messages,
    ...call.maxTokens ? { maxTokens: call.maxTokens } : {},
    ...typeof call.temperature === "number" ? { temperature: call.temperature } : {},
    ...call.signal ? { signal: call.signal } : {}
  });
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") text += chunk.text;
    else if (chunk.type === "reasoning-delta") reasoning += 1;
    else if (chunk.type === "finish") {
      finish = chunk.reason ?? null;
      if (finish?.kind === "error") failure = finish.failure;
    }
  }
  if (failure) {
    const error = new Error(failure.message ?? "\u6A21\u578B\u8C03\u7528\u5931\u8D25");
    error.code = failure.code;
    throw error;
  }
  const answer = text.trim();
  if (!answer) {
    const spent = reasoning > 0 ? "\u6A21\u578B\u628A\u8FD9\u4E00\u8F6E\u7684\u9884\u7B97\u90FD\u7528\u5728\u601D\u8003\u4E0A\u4E86" : "\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u6B63\u6587";
    const error = new Error(`${spent}\uFF08\u7ED3\u675F\u539F\u56E0\uFF1A${finish?.kind ?? "unknown"}\uFF0C\u601D\u8003\u7247\u6BB5 ${reasoning} \u4E2A\uFF09`);
    error.code = "EMPTY_COMPLETION";
    throw error;
  }
  return answer;
}

// src/host/routes.js
var PREFIX = "/__reading";
var MAX_BODY = 64 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("\u8BF7\u6C42\u4F53\u8FC7\u5927"));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}
function sendBytes(res, buf, contentType = "application/epub+zip") {
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(buf.length));
  res.setHeader("cache-control", "no-store");
  res.end(buf);
}
function registerRoutes(deps) {
  const { ctx, library, cache, summaries, config, state, persistActiveBook } = deps;
  async function syncCards(bookId) {
    const takeaways = await library.takeaways(bookId);
    for (const takeaway of takeaways) {
      try {
        const cards = deriveCards(takeaway);
        if (cards.length > 0) await library.addCards(bookId, cards);
      } catch {
      }
    }
  }
  async function cardState(bookId) {
    await syncCards(bookId);
    const cards = await library.cards(bookId);
    const reviews = await library.reviews(bookId);
    const now = Date.now();
    const decorated = cards.map((card) => {
      const cardId = card.cardId ?? card.id;
      const state2 = replay(reviews.filter((review) => (review.cardId ?? review.id) === cardId));
      return {
        ...card,
        cardId,
        schedule: {
          interval: state2.interval,
          factor: state2.factor,
          repetitions: state2.repetitions,
          dueAt: state2.dueAt,
          retired: state2.retired,
          due: state2.dueAt <= now && !state2.retired,
          label: describeDue(state2, now)
        }
      };
    });
    return decorated.sort((a, b) => Number(b.schedule.due) - Number(a.schedule.due) || a.schedule.dueAt - b.schedule.dueAt);
  }
  async function snapshot() {
    const books = await library.list();
    const activeBookId = state.activeBookId && books.some((book) => book.id === state.activeBookId) ? state.activeBookId : books[0]?.id ?? null;
    if (activeBookId !== state.activeBookId) {
      state.activeBookId = activeBookId;
      await persistActiveBook(activeBookId);
    }
    if (!activeBookId) {
      return { ok: true, root: config.dataDir ?? null, books, activeBookId: null, book: null, progress: null, summaries: null, stats: null, cards: [], takeaways: [], notes: [], dueCount: 0 };
    }
    const [progress, meta, summaryStatus, cards, takeaways, notes, stats] = await Promise.all([
      library.progress(activeBookId),
      library.meta(activeBookId),
      summaries.status(activeBookId),
      cardState(activeBookId),
      library.takeaways(activeBookId),
      library.notes(activeBookId),
      library.stats(activeBookId)
    ]);
    const readthrough = progress ? resolvedReadthrough(progress, meta) : null;
    return {
      ok: true,
      root: config.dataDir ?? null,
      books,
      activeBookId,
      book: meta ? {
        id: meta.id,
        title: meta.title,
        author: meta.author ?? "",
        language: meta.language ?? "",
        chapterCount: meta.chapterCount ?? null,
        toc: Array.isArray(meta.toc) ? meta.toc : [],
        format: meta.format ?? "epub",
        textless: meta.textless === true,
        warnings: meta.warnings ?? [],
        fileName: meta.originalName ?? meta.fileName ?? null
      } : null,
      progress: progress ? { ...progress, readthrough, bookTitle: meta?.title ?? null, chapterCount: meta?.chapterCount ?? null } : { readthrough, bookTitle: meta?.title ?? null, chapterCount: meta?.chapterCount ?? null },
      summaries: summaryStatus,
      stats,
      cards,
      takeaways: takeaways.map((item) => ({ ...item, quote: item.userQuote ? clip(item.userQuote, 120) : null })),
      notes,
      dueCount: cards.filter((card) => card.schedule.due).length
    };
  }
  const handler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path4 = url.pathname.slice(PREFIX.length) || "/";
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path4 === "/state") return sendJson(res, 200, await snapshot());
      if (method === "POST" && path4 === "/active") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const meta = await library.meta(String(body?.bookId ?? ""));
        if (!meta) return sendJson(res, 404, { ok: false, error: `\u6CA1\u6709\u8FD9\u672C\u4E66\uFF1A${body?.bookId}` });
        state.activeBookId = meta.id;
        await persistActiveBook(meta.id);
        return sendJson(res, 200, await snapshot());
      }
      if (method === "POST" && path4 === "/import") {
        const rawName = String(req.headers["x-file-name"] ?? "book.epub");
        let name2 = rawName;
        try {
          name2 = decodeURIComponent(rawName);
        } catch {
        }
        name2 = name2.split(/[\\/]/).pop() || "book.epub";
        const bytes = await readBody(req);
        if (bytes.length === 0) return sendJson(res, 400, { ok: false, error: "\u4E0A\u4F20\u7684\u6587\u4EF6\u662F\u7A7A\u7684" });
        let meta;
        try {
          meta = await library.importFile(bytes, { fileName: name2 });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
        state.activeBookId = meta.id;
        await persistActiveBook(meta.id);
        ctx.logger?.info?.(
          `reading: imported ${meta.title} (${meta.format ?? "epub"}, ${meta.chapterCount} sections)`
        );
        return sendJson(res, 200, {
          ok: true,
          bookId: meta.id,
          format: meta.format ?? "epub",
          warnings: meta.warnings ?? [],
          meta,
          state: await snapshot()
        });
      }
      if (method === "GET" && path4.startsWith("/book/") && path4.endsWith("/file")) {
        const bookId = decodeURIComponent(path4.slice("/book/".length, -"/file".length));
        const bytes = await library.sourceBytes(bookId);
        if (!bytes) return sendJson(res, 404, { ok: false, error: "\u8FD9\u672C\u4E66\u7684\u6E90\u6587\u4EF6\u4E0D\u5728\u672C\u5730" });
        return sendBytes(res, bytes);
      }
      if (method === "GET" && path4.startsWith("/book/") && path4.endsWith("/meta")) {
        const bookId = decodeURIComponent(path4.slice("/book/".length, -"/meta".length));
        const meta = await library.meta(bookId);
        if (!meta) return sendJson(res, 404, { ok: false, error: "\u6CA1\u6709\u8FD9\u672C\u4E66" });
        return sendJson(res, 200, { ok: true, meta });
      }
      if (method === "POST" && path4 === "/progress") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        if (!bookId) return sendJson(res, 400, { ok: false, error: "\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u4E66" });
        if (!isCfi(body?.cfi) && typeof body?.cfi !== "string") return sendJson(res, 400, { ok: false, error: "\u7F3A\u5C11\u6709\u6548\u7684 CFI" });
        const saved = await library.saveProgress(bookId, {
          cfi: String(body.cfi),
          positionSectionIndex: typeof body.positionSectionIndex === "number" ? body.positionSectionIndex : void 0,
          chapterTitle: typeof body.chapterTitle === "string" ? body.chapterTitle : void 0,
          sectionCount: typeof body.sectionCount === "number" ? body.sectionCount : void 0
        });
        state.lastSelection = null;
        void summaries.ensure(bookId, saved);
        return sendJson(res, 200, { ok: true, progress: saved });
      }
      if (method === "POST" && path4 === "/selection") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const progress = await library.progress(bookId);
        const gate = requireReadable({ cfi: body?.cfi ?? null, sectionIndex: typeof body?.sectionIndex === "number" ? body.sectionIndex : null }, progress, {
          what: "\u8BB0\u5F55\u9009\u4E2D\u6BB5\u843D"
        });
        state.lastSelection = {
          cfi: typeof body?.cfi === "string" ? body.cfi : null,
          sectionIndex: typeof body?.sectionIndex === "number" ? body.sectionIndex : null,
          quote: typeof body?.quote === "string" ? body.quote.slice(0, 2e3) : null,
          at: (/* @__PURE__ */ new Date()).toISOString()
        };
        return sendJson(res, 200, { ok: true, gate });
      }
      if (method === "POST" && path4 === "/note") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const progress = await library.progress(bookId);
        requireReadable({ cfi: body?.cfi ?? null, sectionIndex: typeof body?.sectionIndex === "number" ? body.sectionIndex : null }, progress, {
          what: "\u5B58\u4E0B\u5212\u7EBF"
        });
        const note = await library.addNote(bookId, {
          cfi: typeof body?.cfi === "string" ? body.cfi : null,
          sectionIndex: typeof body?.sectionIndex === "number" ? body.sectionIndex : 0,
          quote: typeof body?.quote === "string" ? body.quote : "",
          comment: typeof body?.comment === "string" ? body.comment : ""
        });
        return sendJson(res, 200, { ok: true, note });
      }
      if (method === "GET" && path4 === "/notes") {
        const notes = await library.notes(String(url.searchParams.get("bookId") ?? state.activeBookId ?? ""));
        return sendJson(res, 200, { ok: true, notes });
      }
      if (method === "POST" && path4 === "/ask") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const meta = await library.meta(bookId);
        if (!meta) return sendJson(res, 404, { ok: false, error: "\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u4E66" });
        const progress = await library.progress(bookId);
        const question = String(body?.question ?? "").slice(0, 4e3);
        const selection = {
          cfi: typeof body?.cfi === "string" ? body.cfi : null,
          sectionIndex: typeof body?.sectionIndex === "number" ? body.sectionIndex : null,
          quote: typeof body?.quote === "string" ? body.quote : null
        };
        const anchored = Boolean(selection.cfi) || typeof selection.sectionIndex === "number";
        const target = anchored ? { cfi: selection.cfi, sectionIndex: selection.sectionIndex } : { cfi: null, sectionIndex: progress?.positionSectionIndex ?? 0 };
        requireReadable(target, progress, { what: "\u5C31\u8FD9\u6BB5\u539F\u6587\u8BA8\u8BBA" });
        const route = resolveRoute(ctx, config, null);
        if (!route) return sendJson(res, 503, { ok: false, error: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\u8DEF\u7531\uFF0C\u6682\u65F6\u65E0\u6CD5\u5BF9\u8BDD\u3002\u590D\u4E60\u548C\u7B14\u8BB0\u4E0D\u53D7\u5F71\u54CD\u3002" });
        const window = await selectionWindow(library, bookId, progress, {
          cfi: anchored ? selection.cfi : null,
          sectionIndex: target.sectionIndex,
          quote: anchored ? selection.quote : null,
          before: config.windowChars ?? 300,
          after: config.windowChars ?? 300
        }).catch((error) => {
          if (error?.name === "SpoilerGateError") throw error;
          return null;
        });
        const index = await summaryIndexText(library, bookId, progress);
        const hits = await retrieveRead(library, cache, bookId, progress, question || window?.text?.slice(0, 300) || "", { limit: 3 });
        const system = singleTurnSystem({
          progressLine: progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }),
          summaryIndex: index,
          window: window ? `\u7B2C ${window.sectionIndex + 1} \u7AE0${window.title ? `\u300C${window.title}\u300D` : ""}
${window.text}` : null,
          retrieval: retrievalText(hits)
        });
        const answer = await streamText(ctx, {
          provider: route.provider,
          model: route.model,
          system,
          prompt: question || "\u6211\u60F3\u5C31\u8FD9\u6BB5\u6587\u5B57\u804A\u804A\u3002",
          maxTokens: 1600,
          temperature: 0.6,
          signal: void 0
        });
        return sendJson(res, 200, { ok: true, reply: answer, usedWindow: Boolean(window), sections: { window: window?.sectionIndex ?? null, retrieved: hits.map((hit) => hit.sectionIndex) } });
      }
      if (method === "POST" && path4 === "/closing") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const meta = await library.meta(bookId);
        if (!meta) return sendJson(res, 404, { ok: false, error: "\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u4E66" });
        const progress = await library.progress(bookId);
        const sectionIndex = typeof body?.sectionIndex === "number" ? body.sectionIndex : progress?.positionSectionIndex ?? 0;
        requireReadable({ sectionIndex }, progress, { what: "\u5BF9\u672C\u7AE0\u505A\u6536\u53E3" });
        const all = await library.takeaways(bookId);
        const mine = all.filter((item) => (item.chapterIndex ?? 0) === sectionIndex);
        if (mine.length === 0) {
          return sendJson(res, 400, { ok: false, error: "\u8FD9\u4E00\u7AE0\u8FD8\u6CA1\u6709\u6536\u83B7\u53EF\u4EE5\u6536\u53E3\u3002\u5148\u5C31\u8FD9\u4E00\u7AE0\u804A\u51E0\u53E5\uFF0C\u6216\u8005\u5728\u5BF9\u8BDD\u91CC\u628A\u67D0\u53E5\u5B58\u6210\u6536\u83B7\u3002" });
        }
        const chapterTitle = meta.sections?.[sectionIndex]?.title ?? progress?.chapterTitle ?? null;
        const fallback = mine.map((item) => `\xB7 [${item.type}] ${item.aiSummary}`).join("\n");
        const route = resolveRoute(ctx, config, null);
        if (!route) {
          return sendJson(res, 200, { ok: true, text: `\u8FD9\u4E00\u7AE0\u4F60\u5B58\u4E86 ${mine.length} \u6761\u6536\u83B7\uFF1A
${fallback}`, modelFree: true });
        }
        try {
          const text = await streamText(ctx, {
            provider: route.provider,
            model: route.model,
            system: closingSystem({
              progressLine: progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }),
              chapterTitle,
              takeaways: mine
            }),
            prompt: "\u628A\u8FD9\u4E00\u7AE0\u7684\u8BA8\u8BBA\u6536\u4E2A\u53E3\u3002",
            maxTokens: 1200,
            temperature: 0.5
          });
          return sendJson(res, 200, { ok: true, text });
        } catch (error) {
          return sendJson(res, 200, { ok: true, text: `\u8FD9\u4E00\u7AE0\u4F60\u5B58\u4E86 ${mine.length} \u6761\u6536\u83B7\uFF1A
${fallback}`, modelFree: true, warning: String(error?.message ?? error) });
        }
      }
      if (method === "GET" && path4 === "/takeaways") {
        const bookId = String(url.searchParams.get("bookId") ?? state.activeBookId ?? "");
        const items = await library.takeaways(bookId);
        return sendJson(res, 200, { ok: true, takeaways: items });
      }
      if (method === "POST" && path4 === "/takeaway") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const progress = await library.progress(bookId);
        const fromCfi = isCfi(body?.cfi) ? spineIndexOf(body.cfi) : null;
        const claimed = typeof body?.chapterIndex === "number" ? body.chapterIndex : typeof body?.sectionIndex === "number" ? body.sectionIndex : null;
        if (fromCfi !== null && claimed !== null && fromCfi !== claimed) {
          return sendJson(res, 400, { ok: false, error: `\u951A\u70B9\u548C\u7AE0\u8282\u53F7\u5BF9\u4E0D\u4E0A\uFF1ACFI \u6307\u5411\u7B2C ${fromCfi + 1} \u7AE0\uFF0C\u53C2\u6570\u5199\u7684\u662F\u7B2C ${claimed + 1} \u7AE0\u3002` });
        }
        const sectionIndex = fromCfi ?? claimed ?? (progress?.positionSectionIndex ?? 0);
        requireReadable({ cfi: isCfi(body?.cfi) ? body.cfi : null, sectionIndex }, progress, { what: "\u8BB0\u5F55\u6536\u83B7" });
        const record = await library.addTakeaway(bookId, {
          type: String(body?.type ?? "\u7406\u89E3"),
          cfi: isCfi(body?.cfi) ? body.cfi : buildCfi(sectionIndex),
          chapterIndex: sectionIndex,
          userQuote: typeof body?.userQuote === "string" && body.userQuote.length > 0 ? body.userQuote.slice(0, 1e3) : null,
          aiSummary: String(body?.aiSummary ?? "").slice(0, 1e3)
        });
        const cards = await library.addCards(bookId, deriveCards(record));
        return sendJson(res, 200, { ok: true, takeaway: record, cards });
      }
      if (method === "GET" && path4 === "/cards") {
        const bookId = String(url.searchParams.get("bookId") ?? state.activeBookId ?? "");
        return sendJson(res, 200, { ok: true, cards: await cardState(bookId) });
      }
      if (method === "POST" && path4 === "/rephrase") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        if (!await library.meta(bookId)) return sendJson(res, 404, { ok: false, error: "\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u4E66" });
        const cards = await library.cards(bookId);
        const card = cards.find((item) => (item.cardId ?? item.id) === body?.cardId);
        if (!card) return sendJson(res, 404, { ok: false, error: "\u6CA1\u6709\u8FD9\u5F20\u5361\u7247" });
        const mode = ["rephrase", "split", "compare"].includes(body?.mode) ? body.mode : "rephrase";
        const other = cards.find((item) => (item.cardId ?? item.id) !== (card.cardId ?? card.id));
        const task = mode === "split" ? "\u628A\u8FD9\u4E2A\u95EE\u9898\u62C6\u6210\u4E24\u4E2A\u66F4\u5C0F\u3001\u80FD\u4E00\u6B65\u6B65\u56DE\u7B54\u7684\u95EE\u9898\uFF0C\u6BCF\u4E2A\u4E00\u884C\uFF0C\u4E0D\u8981\u89E3\u91CA\u4E3A\u4EC0\u4E48\u8981\u62C6\u3002" : mode === "compare" ? `\u628A\u5B83\u548C\u53E6\u4E00\u5F20\u5361\u7247\u653E\u5728\u4E00\u8D77\u95EE\uFF1A\u53E6\u4E00\u5F20\u5361\u7247\u662F\u300C${other?.front ?? "\uFF08\u8FD9\u672C\u4E66\u53EA\u6709\u8FD9\u4E00\u5F20\u5361\u7247\uFF09"}\u300D\u3002\u7528\u4E00\u53E5\u8BDD\u95EE\u51FA\u8FD9\u4E24\u5F20\u5361\u7247\u4E4B\u95F4\u7684\u8054\u7CFB\uFF0C\u4E0D\u8981\u7ED9\u7B54\u6848\u3002` : "\u6362\u4E00\u79CD\u66F4\u5177\u4F53\u3001\u66F4\u53E3\u8BED\u7684\u95EE\u6CD5\u91CD\u95EE\u4E00\u6B21\u3002\u53EA\u8F93\u51FA\u8FD9\u4E00\u4E2A\u95EE\u9898\u3002";
        const route = resolveRoute(ctx, config, null);
        if (!route) {
          return sendJson(res, 200, { ok: true, text: "", modelFree: true, note: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\u8DEF\u7531\u3002\u590D\u4E60\u672C\u8EAB\u4E0D\u9700\u8981\u6A21\u578B\uFF0C\u5361\u7247\u7167\u5E38\u53EF\u4EE5\u7FFB\u3002" });
        }
        try {
          const text = await streamText(ctx, {
            provider: route.provider,
            model: route.model,
            system: `\u4F60\u5728\u5E2E\u8BFB\u8005\u590D\u4E60\u4ED6\u81EA\u5DF1\u8BB0\u4E0B\u7684\u6536\u83B7\u3002\u53EA\u6539\u5199\u63D0\u95EE\uFF0C\u4E0D\u8981\u7ED9\u7B54\u6848\u3001\u4E0D\u8981\u5F15\u5165\u4E66\u91CC\u4ED6\u6CA1\u8BFB\u5230\u7684\u5185\u5BB9\u3002
\u8BFB\u8005\u5F53\u65F6\u7684\u7B14\u8BB0\uFF1A\u300C${clip(card.back, 400)}\u300D`,
            prompt: `\u8FD9\u5F20\u5361\u7247\u6B63\u9762\u662F\uFF1A\u300C${card.front}\u300D
${task}`,
            maxTokens: 900
          });
          return sendJson(res, 200, { ok: true, text: clip(text, 500), mode });
        } catch (error) {
          return sendJson(res, 200, { ok: true, text: "", modelFree: true, note: `\u6A21\u578B\u8FD9\u4E00\u6B65\u6CA1\u6210\u529F\uFF08${clip(String(error?.message ?? error), 120)}\uFF09\uFF0C\u5361\u7247\u672C\u8EAB\u4E0D\u53D7\u5F71\u54CD\u3002` });
        }
      }
      if (method === "POST" && path4 === "/review") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        const cards = await library.cards(bookId);
        const card = cards.find((item) => (item.cardId ?? item.id) === body?.cardId);
        if (!card) return sendJson(res, 404, { ok: false, error: "\u6CA1\u6709\u8FD9\u5F20\u5361\u7247" });
        const outcome = String(body?.outcome ?? "settled");
        const quality = outcome === "got" ? 5 : outcome === "reread" ? 3 : 4;
        await library.addReview(bookId, { cardId: card.cardId ?? card.id, quality, outcome });
        return sendJson(res, 200, { ok: true, cards: await cardState(bookId) });
      }
      if (method === "POST" && path4 === "/summaries") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const bookId = String(body?.bookId ?? state.activeBookId ?? "");
        if (!await library.meta(bookId)) return sendJson(res, 404, { ok: false, error: "\u8FD8\u6CA1\u6709\u6253\u5F00\u4EFB\u4F55\u4E66" });
        const progress = await library.progress(bookId);
        void summaries.ensure(bookId, progress);
        return sendJson(res, 200, { ok: true, status: await summaries.status(bookId) });
      }
      return sendJson(res, 404, { ok: false, error: `\u672A\u77E5\u7684\u63A5\u53E3\uFF1A${method} ${path4}` });
    } catch (error) {
      const message = error?.name === "SpoilerGateError" ? `\u62D2\u7EDD\uFF1A${error.message}` : String(error?.message ?? error);
      const status = error?.name === "SpoilerGateError" ? 403 : 500;
      try {
        sendJson(res, status, { ok: false, error: message, code: error?.code ?? null });
      } catch {
      }
    }
  };
  const dispose = ctx.webServer.register({ kind: "prefix", path: PREFIX, handler });
  return { dispose, handler };
}

// src/host/summaries.js
var SUMMARY_SYSTEM = `\u4F60\u4E3A\u4E00\u672C\u6B63\u5728\u88AB\u9605\u8BFB\u7684\u4E66\u505A\u7AE0\u8282\u6458\u8981\u7D22\u5F15\u3002\u53EA\u6839\u636E\u7ED9\u4F60\u7684\u8FD9\u4E00\u7AE0\u539F\u6587\u5199\uFF0C\u4E0D\u8865\u5145\u3001\u4E0D\u63A8\u6D4B\u3001\u4E0D\u8BC4\u4EF7\u3002
\u8981\u6C42\uFF1A\u4E0D\u8D85\u8FC7 120 \u4E2A\u5B57\uFF1B\u5199\u6E05\u8FD9\u4E00\u7AE0"\u53D1\u751F\u4E86\u4EC0\u4E48\u3001\u8BFB\u8005\u6B64\u523B\u77E5\u9053\u4EC0\u4E48"\uFF1B\u4E0D\u5199\u4F0F\u7B14\u3001\u4E0D\u5199"\u63A5\u4E0B\u6765"\uFF0C\u4E0D\u8BC4\u4EF7\u597D\u574F\u3002`;
function normalizeSummary(text) {
  const collapsed = String(text ?? "").replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  const clipped = collapsed.length > 140 ? `${collapsed.slice(0, 138)}\u2026` : collapsed;
  return clipped;
}
function createSummaries(deps) {
  const { ctx, library, config } = deps;
  const inflight = /* @__PURE__ */ new Set();
  const lastError = /* @__PURE__ */ new Map();
  let chain = Promise.resolve();
  async function generateOne(bookId, sectionIndex, preferred = null) {
    const route = resolveRoute(ctx, config, preferred);
    if (!route) throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u6A21\u578B\u8DEF\u7531\uFF0C\u65E0\u6CD5\u751F\u6210\u7AE0\u8282\u6458\u8981");
    const sections = await library.sections(bookId);
    const section = sections.find((item) => item.index === sectionIndex);
    if (!section) throw new Error(`\u7B2C ${sectionIndex + 1} \u7AE0\u4E0D\u5B58\u5728`);
    const body = clip(section.text, 8e3);
    const summary = normalizeSummary(
      await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        system: SUMMARY_SYSTEM,
        prompt: `\u7B2C ${sectionIndex + 1} \u7AE0${section.title ? `\u300C${section.title}\u300D` : ""}\u539F\u6587\uFF1A

${body}

\u8BF7\u5199\u8FD9\u4E00\u7AE0\u7684\u6458\u8981\u3002`,
        maxTokens: 1200,
        temperature: 0.2
      })
    );
    if (!summary) throw new Error("\u6A21\u578B\u6CA1\u6709\u8FD4\u56DE\u6458\u8981\u5185\u5BB9");
    await library.saveSummary(bookId, sectionIndex, { summary, title: section.title, model: route.model });
    return summary;
  }
  function ensure(bookId, progress, preferred = null) {
    const ceiling = summaryCeiling(progress);
    if (ceiling < 0) return Promise.resolve([]);
    chain = chain.then(async () => {
      const existing = await library.summaries(bookId);
      for (let index = 0; index <= ceiling; index += 1) {
        if (existing.has(index)) continue;
        const key = `${bookId}:${index}`;
        if (inflight.has(key)) continue;
        inflight.add(key);
        try {
          await generateOne(bookId, index, preferred);
          lastError.delete(key);
        } catch (error) {
          lastError.set(key, String(error?.message ?? error));
        } finally {
          inflight.delete(key);
        }
      }
      return [];
    }).catch(() => []);
    return chain;
  }
  async function status(bookId) {
    const existing = await library.summaries(bookId);
    return {
      done: [...existing.keys()].sort((a, b) => a - b),
      pending: [...inflight].filter((key) => key.startsWith(`${bookId}:`)).map((key) => Number(key.split(":")[1])),
      errors: [...lastError.entries()].filter(([key]) => key.startsWith(`${bookId}:`)).map(([, message]) => message)
    };
  }
  return { ensure, generateOne, status };
}

// src/host/tools.js
var TEXT = (text) => [{ type: "text", text }];
var stringOutput = { schema: { type: "string" }, render: (_args, value) => TEXT(String(value ?? "")) };
async function pickBook(library, activeBookId, requested) {
  if (typeof requested === "string" && requested.length > 0) {
    const meta = await library.meta(requested);
    if (!meta) throw new Error(`\u6CA1\u6709\u8FD9\u672C\u4E66\uFF1A${requested}`);
    return meta;
  }
  if (activeBookId) {
    const meta = await library.meta(activeBookId);
    if (meta) return meta;
  }
  const books = await library.list();
  if (books.length === 0) throw new Error("\u4E66\u67B6\u4E0A\u8FD8\u6CA1\u6709\u4E66\u3002\u8BF7\u8BFB\u8005\u5148\u5728\u9605\u8BFB\u9762\u677F\u91CC\u5BFC\u5165\u4E00\u672C EPUB\u3002");
  return books[0];
}
function registerTools(deps) {
  const { ctx, library, cache, summaries, config, state } = deps;
  const disposers = [];
  const progressOf = async (bookId) => library.progress(bookId);
  disposers.push(
    ctx.tools.register({
      name: "reading_progress",
      description: "\u62A5\u544A\u8BFB\u8005\u5F53\u524D\u8BFB\u5230\u54EA\u4E00\u7AE0\u3001\u54EA\u4E00\u53E5\uFF0C\u4EE5\u53CA\u53EF\u53D6\u8303\u56F4\u7684\u4E0A\u754C\u3002\u8BA8\u8BBA\u4EFB\u4F55\u539F\u6587\u4E4B\u524D\u5148\u8C03\u7528\u5B83\u786E\u8BA4\u8FB9\u754C\u3002",
      parameters: {
        type: "object",
        properties: { bookId: { type: "string", description: "\u4E66 id\uFF0C\u7701\u7565\u5219\u7528\u5F53\u524D\u6253\u5F00\u7684\u4E66" } },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const lines = [progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount })];
        if (progress?.cfi) lines.push(`\u5F53\u524D\u4F4D\u7F6E CFI\uFF1A${progress.cfi}`);
        if (progress?.chapterTitle) lines.push(`\u5F53\u524D\u7AE0\u8282\uFF1A${progress.chapterTitle}`);
        const status = await summaries.status(meta.id);
        const ceiling = summaryCeiling(progress);
        const missing = [];
        for (let index = 0; index <= ceiling; index += 1) {
          if (!status.done.includes(index)) missing.push(index + 1);
        }
        if (missing.length > 0) lines.push(`\u5DF2\u8BFB\u8303\u56F4\u5185\u5C1A\u672A\u751F\u6210\u6458\u8981\u7684\u7AE0\u8282\uFF1A\u7B2C ${missing.join("\u3001")} \u7AE0`);
        return lines.join("\n");
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "read_text_window",
      description: "\u8BFB\u53D6\u8BFB\u8005\u5DF2\u8BFB\u8303\u56F4\u5185\u7684\u771F\u5B9E\u539F\u6587\uFF08\u9009\u4E2D\u53E5\u524D\u540E\u5404\u7EA6 300 \u5B57\uFF09\u3002\u53C2\u6570\u53EF\u4EE5\u7ED9 cfi\u3001sectionIndex\uFF0C\u6216\u53EA\u7ED9 quote \u8BA9\u5DE5\u5177\u81EA\u5DF1\u5B9A\u4F4D\u3002\u8D85\u51FA\u8BFB\u8005\u8FDB\u5EA6\u7684\u4F4D\u7F6E\u4F1A\u88AB\u76F4\u63A5\u62D2\u7EDD\u3002",
      parameters: {
        type: "object",
        properties: {
          cfi: { type: "string", description: "EPUB CFI \u4F4D\u7F6E" },
          sectionIndex: { type: "integer", description: "\u7AE0\u8282\u5E8F\u53F7\uFF08\u4ECE 0 \u5F00\u59CB\uFF09" },
          quote: { type: "string", description: "\u8BFB\u8005\u9009\u4E2D\u7684\u90A3\u53E5\u8BDD\uFF0C\u7528\u4E8E\u5B9A\u4F4D" },
          before: { type: "integer", description: "\u5411\u524D\u53D6\u591A\u5C11\u5B57\uFF0C\u9ED8\u8BA4 300" },
          after: { type: "integer", description: "\u5411\u540E\u53D6\u591A\u5C11\u5B57\uFF0C\u9ED8\u8BA4 300" }
        },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const target = {
          cfi: typeof args?.cfi === "string" ? args.cfi : null,
          sectionIndex: typeof args?.sectionIndex === "number" ? args.sectionIndex : null
        };
        if (target.cfi === null && target.sectionIndex === null) {
          const fallback = progress?.positionSectionIndex ?? progress?.sectionIndex;
          if (typeof fallback !== "number") {
            throw new Error("\u8FD9\u672C\u4E66\u8FD8\u6CA1\u6709\u8FDB\u5EA6\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u539F\u6587\u3002\u8BF7\u8BFB\u8005\u5148\u5728\u9605\u8BFB\u9762\u677F\u91CC\u7FFB\u5230\u81EA\u5DF1\u7684\u4F4D\u7F6E\u3002");
          }
          target.sectionIndex = fallback;
        }
        requireReadable(target, progress, { what: "\u8BFB\u53D6\u539F\u6587" });
        const window = await selectionWindow(library, meta.id, progress, {
          cfi: target.cfi,
          sectionIndex: target.sectionIndex,
          quote: typeof args?.quote === "string" ? args.quote : null,
          before: typeof args?.before === "number" ? Math.min(args.before, 1200) : 300,
          after: typeof args?.after === "number" ? Math.min(args.after, 1200) : 300
        });
        const header = `\u7B2C ${window.sectionIndex + 1} \u7AE0${window.title ? `\u300C${window.title}\u300D` : ""}\uFF08\u8BFB\u8005\u5DF2\u8BFB\u5230\u6B64\u5904\uFF09`;
        return `${header}

${window.text}`;
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "search_read_text",
      description: "\u5728\u8BFB\u8005\u5DF2\u8BFB\u8303\u56F4\u5185\u505A\u6DF7\u5408\u68C0\u7D22\uFF08BM25 + \u5411\u91CF\uFF09\uFF0C\u8FD4\u56DE\u6700\u76F8\u5173\u7684\u51E0\u4E2A\u539F\u6587\u7247\u6BB5\u3002\u672A\u8BFB\u7AE0\u8282\u4E0D\u4F1A\u53C2\u4E0E\u68C0\u7D22\uFF0C\u4E5F\u4E0D\u4F1A\u51FA\u73B0\u5728\u7ED3\u679C\u91CC\u3002",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "\u8981\u68C0\u7D22\u7684\u5185\u5BB9\uFF0C\u7528\u8BFB\u8005\u7684\u8BDD\u539F\u6837\u5199" },
          limit: { type: "integer", description: "\u8FD4\u56DE\u6761\u76EE\u6570\uFF0C\u9ED8\u8BA4 4\uFF0C\u6700\u591A 8" }
        },
        required: ["query"],
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        requireReadable({ sectionIndex: progress?.sectionIndex }, progress, { what: "\u68C0\u7D22\u539F\u6587" });
        const hits = await retrieveRead(library, cache, meta.id, progress, String(args?.query ?? ""), {
          limit: Math.min(Math.max(1, args?.limit ?? 4), 8)
        });
        if (hits.length === 0) return "\u8BFB\u8005\u5DF2\u8BFB\u8303\u56F4\u5185\u6CA1\u6709\u627E\u5230\u76F8\u5173\u5185\u5BB9\u3002\u4E0D\u8981\u7528\u4E66\u4E2D\u522B\u5904\u7684\u4FE1\u606F\u8865\u8DB3\uFF0C\u76F4\u63A5\u8BF4\u660E\u6CA1\u627E\u5230\u3002";
        return retrievalText(hits);
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "chapter_summary",
      description: "\u8BFB\u53D6\u67D0\u4E00\u7AE0\u7684\u6458\u8981\uFF08\u4E00\u53E5\u8BDD\u7EA7\u7684\u7AE0\u8282\u7D22\u5F15\uFF09\u3002\u53EA\u5BF9\u8BFB\u8005\u5DF2\u8BFB\u5230\u7684\u7AE0\u8282\u6709\u6548\uFF1B\u672A\u8BFB\u7AE0\u8282\u6CA1\u6709\u6458\u8981\uFF0C\u8C03\u7528\u4F1A\u88AB\u62D2\u7EDD\u3002",
      parameters: {
        type: "object",
        properties: {
          sectionIndex: { type: "integer", description: "\u7AE0\u8282\u5E8F\u53F7\uFF08\u4ECE 0 \u5F00\u59CB\uFF09\uFF0C\u7701\u7565\u5219\u7528\u8BFB\u8005\u5F53\u524D\u7AE0" }
        },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const target = typeof args?.sectionIndex === "number" ? args.sectionIndex : progress?.positionSectionIndex ?? progress?.sectionIndex;
        if (typeof target !== "number") throw new Error("\u8FD9\u672C\u4E66\u8FD8\u6CA1\u6709\u8FDB\u5EA6\u8BB0\u5F55\uFF0C\u6CA1\u6709\u53EF\u8BFB\u7684\u7AE0\u8282\u6458\u8981\u3002");
        requireReadable({ sectionIndex: target }, progress, { what: "\u8BFB\u53D6\u7AE0\u8282\u6458\u8981" });
        const summariesMap = await library.summaries(meta.id);
        const record = summariesMap.get(target);
        const section = (await library.meta(meta.id))?.sections?.[target];
        const title = record?.title ?? section?.title ?? null;
        if (record?.summary) return `\u7B2C ${target + 1} \u7AE0${title ? `\u300C${title}\u300D` : ""}\uFF1A${record.summary}`;
        return `\u7B2C ${target + 1} \u7AE0\u7684\u6458\u8981\u8FD8\u6CA1\u6709\u751F\u6210\uFF08\u53EF\u4EE5\u7A0D\u540E\u518D\u8BD5\uFF0C\u6216\u7528 read_text_window \u76F4\u63A5\u8BFB\u8FD9\u4E00\u7AE0\u7684\u539F\u6587\uFF09\u3002`;
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "save_takeaway",
      description: "\u628A\u672C\u8F6E\u8BA8\u8BBA\u7684\u6536\u83B7\u5B58\u6210\u4E00\u6761 takeaways \u8BB0\u5F55\uFF08\u53EA\u589E\u4E0D\u51CF\uFF09\u3002type \u53D6 \u7406\u89E3/\u7591\u95EE/\u8054\u60F3/\u8BC4\u4EF7\uFF1BaiSummary \u5199\u8BFB\u8005\u81EA\u5DF1\u60F3\u5230\u7684\u4E1C\u897F\uFF0C\u4E0D\u8981\u590D\u8FF0\u539F\u6587\u3002",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...TAKEAWAY_TYPES] },
          aiSummary: { type: "string", description: "\u4E00\u4E24\u53E5\u8BDD\uFF0C\u8BB0\u5F55\u8BFB\u8005\u5728\u8FD9\u6B21\u8BA8\u8BBA\u91CC\u5F62\u6210\u7684\u7406\u89E3" },
          cfi: { type: "string", description: "\u8FD9\u6761\u6536\u83B7\u951A\u5B9A\u7684 EPUB CFI" },
          sectionIndex: { type: "integer", description: "\u7AE0\u8282\u5E8F\u53F7\uFF0C\u7701\u7565\u5219\u7528\u8BFB\u8005\u5F53\u524D\u7AE0" },
          userQuote: { type: "string", description: "\u8BFB\u8005\u539F\u8BDD\u6216\u4ED6\u5212\u7684\u90A3\u53E5\u539F\u6587\uFF0C\u53EF\u4E3A\u7A7A" },
          scope: { type: "string", enum: ["moment", "chapter-closing"], description: "\u672C\u7AE0\u6536\u53E3\u7528 chapter-closing" }
        },
        required: ["type", "aiSummary"],
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const sectionIndex = typeof args?.sectionIndex === "number" ? args.sectionIndex : progress?.positionSectionIndex ?? progress?.sectionIndex ?? 0;
        requireReadable({ sectionIndex }, progress, { what: "\u8BB0\u5F55\u6536\u83B7" });
        const cfi = typeof args?.cfi === "string" && tryParseCfi(args.cfi) ? args.cfi : buildCfi(sectionIndex);
        const takeaway = {
          type: args?.type,
          cfi,
          chapterIndex: sectionIndex,
          userQuote: typeof args?.userQuote === "string" && args.userQuote.length > 0 ? args.userQuote : null,
          aiSummary: String(args?.aiSummary ?? "").trim(),
          scope: args?.scope === "chapter-closing" ? "chapter-closing" : "moment"
        };
        if (!isTakeaway(takeaway)) {
          throw new Error("\u8FD9\u6761\u6536\u83B7\u4E0D\u5B8C\u6574\uFF08type \u5FC5\u987B\u662F \u7406\u89E3/\u7591\u95EE/\u8054\u60F3/\u8BC4\u4EF7\uFF0CaiSummary \u4E0D\u80FD\u4E3A\u7A7A\uFF09");
        }
        const record = await library.addTakeaway(meta.id, { ...takeaway, id: takeawayId(takeaway) });
        const cards = deriveCards(record);
        const created = await library.addCards(meta.id, cards);
        return created.length > 0 ? `\u5DF2\u5B58\u4E0B\u4E00\u6761\u300C${record.type}\u300D\u6536\u83B7\uFF1A${record.aiSummary}
\u7531\u5B83\u6D3E\u751F\u51FA\u7684\u590D\u4E60\u5361\u7247\uFF1A${created.length} \u5F20\uFF08${cards.map((card) => clip(card.front, 40)).join(" / ")}\uFF09` : `\u5DF2\u5B58\u4E0B\u4E00\u6761\u300C${record.type}\u300D\u6536\u83B7\uFF1A${record.aiSummary}
\u8FD9\u6761\u6536\u83B7\u5BF9\u5E94\u7684\u590D\u4E60\u5361\u7247\u4E4B\u524D\u5DF2\u7ECF\u5B58\u5728\uFF0C\u6CA1\u6709\u91CD\u590D\u5EFA\u5361\u3002`;
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "list_takeaways",
      description: "\u5217\u51FA\u8BFB\u8005\u5DF2\u7ECF\u5B58\u4E0B\u7684\u6536\u83B7\uFF08\u53EF\u6309\u7AE0\u8282\u8FC7\u6EE4\uFF09\u3002\u8FD9\u662F\u8BFB\u8005\u81EA\u5DF1\u7684\u8BB0\u5F55\uFF0C\u4E0D\u6D89\u53CA\u672A\u8BFB\u539F\u6587\u3002",
      parameters: {
        type: "object",
        properties: {
          chapterIndex: { type: "integer", description: "\u53EA\u770B\u8FD9\u4E00\u7AE0" },
          limit: { type: "integer", description: "\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u6761\uFF0C\u9ED8\u8BA4 20" }
        },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        let items = await library.takeaways(meta.id);
        if (typeof args?.chapterIndex === "number") items = items.filter((item) => item.chapterIndex === args.chapterIndex);
        const limit = Math.min(Math.max(1, args?.limit ?? 20), 60);
        items = items.slice(-limit);
        if (items.length === 0) return "\u8FD8\u6CA1\u6709\u5B58\u8FC7\u4EFB\u4F55\u6536\u83B7\u3002";
        return items.map(
          (item, index) => `${index + 1}. [${item.type}] \u7B2C ${(item.chapterIndex ?? 0) + 1} \u7AE0 ${item.aiSummary}${item.userQuote ? `\uFF08\u8BFB\u8005\u539F\u8BDD\uFF1A${clip(item.userQuote, 60)}\uFF09` : ""}`
        ).join("\n");
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "chapter_closing",
      description: '\u628A\u8BFB\u8005\u5728\u8FD9\u4E00\u7AE0\u91CC\u81EA\u5DF1\u8BF4\u8FC7\u7684\u6536\u83B7\u6C47\u603B\u6210"\u672C\u7AE0\u6536\u53E3"\u3002\u53EA\u8BFB\u8BFB\u8005\u81EA\u5DF1\u7684 takeaways\uFF0C\u4E0D\u91CD\u65B0\u8BFB\u539F\u6587\u3001\u4E0D\u91CD\u65B0\u6982\u62EC\u8FD9\u4E00\u7AE0\u3002',
      parameters: {
        type: "object",
        properties: { sectionIndex: { type: "integer", description: "\u7AE0\u8282\u5E8F\u53F7\uFF0C\u7701\u7565\u5219\u7528\u8BFB\u8005\u5F53\u524D\u7AE0" } },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const target = typeof args?.sectionIndex === "number" ? args.sectionIndex : progress?.positionSectionIndex ?? progress?.sectionIndex ?? 0;
        requireReadable({ sectionIndex: target }, progress, { what: "\u6C47\u603B\u672C\u7AE0\u6536\u53E3" });
        const items = (await library.takeaways(meta.id)).filter((item) => item.chapterIndex === target);
        if (items.length === 0) {
          return `\u7B2C ${target + 1} \u7AE0\u8FD8\u6CA1\u6709\u4EFB\u4F55\u6536\u83B7\u8BB0\u5F55\u3002\u8BF7\u8BFB\u8005\u5148\u804A\u70B9\u4EC0\u4E48\uFF0C\u6536\u53E3\u53EA\u4ECE\u4ED6\u81EA\u5DF1\u8BF4\u8FC7\u7684\u4E1C\u897F\u91CC\u957F\u51FA\u6765\u3002`;
        }
        const body = items.map((item) => `- [${item.type}] ${item.aiSummary}${item.userQuote ? `
  \u8BFB\u8005\u539F\u8BDD\uFF1A${clip(item.userQuote, 80)}` : ""}`).join("\n");
        return `\u7B2C ${target + 1} \u7AE0\uFF0C\u8BFB\u8005\u81EA\u5DF1\u7684\u6536\u83B7\u8BB0\u5F55\uFF08\u5171 ${items.length} \u6761\uFF09\uFF1A
${body}

\u8BF7\u7528\u5B83\u5199\u4E09\u5230\u4E94\u884C\u7684"\u672C\u7AE0\u6536\u53E3"\uFF1A\u8FD9\u662F\u8BFB\u8005\u81EA\u5DF1\u7684\u7406\u89E3\u8DEF\u5F84\uFF0C\u4E0D\u8981\u91CD\u65B0\u6982\u62EC\u539F\u6587\uFF0C\u4E5F\u4E0D\u8981\u8865\u4ED6\u6CA1\u8BF4\u8FC7\u7684\u89C2\u70B9\u3002`;
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "review_due",
      description: "\u5217\u51FA\u5230\u671F\uFF08\u6216\u8FD8\u6CA1\u590D\u4E60\u8FC7\uFF09\u7684\u590D\u4E60\u5361\u7247\u3002\u5361\u7247\u7531\u6536\u83B7\u81EA\u52A8\u6D3E\u751F\uFF0C\u53EA\u770B\u8BFB\u8005\u81EA\u5DF1\u7684\u8BB0\u5F55\uFF0C\u4E0D\u8BFB\u539F\u6587\u3002",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer", description: "\u6700\u591A\u51E0\u5F20\uFF0C\u9ED8\u8BA4 5" } },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const cards = (await library.cards(meta.id)).map((card) => ({ ...card, cardId: card.cardId ?? card.id }));
        const reviews = await library.reviews(meta.id);
        const limit = Math.min(Math.max(1, args?.limit ?? 5), 20);
        const due = cards.map((card) => ({ card, state: replay(reviewsFor(reviews, card.cardId)) })).filter((entry) => entry.state.dueAt <= Date.now() && !entry.state.retired).slice(0, limit);
        if (due.length === 0) return "\u73B0\u5728\u6CA1\u6709\u5230\u671F\u7684\u5361\u7247\u3002";
        return due.map(
          (entry, index) => `${index + 1}. ${entry.card.front}
   \u5361\u7247 id\uFF1A${entry.card.cardId}\uFF5C\u7B2C ${(entry.card.chapterIndex ?? 0) + 1} \u7AE0\uFF5C${describeDue(entry.state)}`
        ).join("\n");
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "review_card",
      description: "\u8BB0\u4E0B\u4E00\u6B21\u590D\u4E60\u51B3\u5B9A\uFF1Areread\uFF08\u60F3\u518D\u8BFB\u4E00\u904D\uFF09\u3001settled\uFF08\u5DF2\u7ECF\u7A33\u4E86\uFF09\u3001got\uFF08\u5F88\u719F\uFF09\u3002\u8C03\u5EA6\u7528 SM-2\uFF0C\u7531\u4EE3\u7801\u7B97\uFF0C\u4E0D\u7ECF\u8FC7\u6A21\u578B\u3002",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "\u5361\u7247 id" },
          outcome: { type: "string", enum: ["reread", "settled", "got"] }
        },
        required: ["cardId", "outcome"],
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state2.activeBookId, args?.bookId);
        const cards = (await library.cards(meta.id)).map((item) => ({ ...item, cardId: item.cardId ?? item.id }));
        const card = cards.find((item) => item.cardId === args?.cardId);
        if (!card) throw new Error(`\u6CA1\u6709\u8FD9\u5F20\u5361\u7247\uFF1A${args?.cardId}`);
        const quality = args?.outcome === "got" ? QUALITY.got : args?.outcome === "reread" ? QUALITY.rethink : QUALITY.settled;
        await library.addReview(meta.id, { cardId: card.cardId, quality, outcome: args?.outcome });
        const state2 = replay(reviewsFor(await library.reviews(meta.id), card.cardId));
        return `\u5DF2\u8BB0\u5F55\uFF1A${card.front}
\u4E0B\u6B21\u590D\u4E60\uFF1A${describeDue(state2)}`;
      }
    })
  );
  disposers.push(
    ctx.tools.register({
      name: "reading_context",
      description: "\u6C47\u603B\u5F53\u524D\u8BA8\u8BBA\u8BE5\u7528\u7684\u4E0A\u4E0B\u6587\uFF1A\u8BFB\u8005\u8FDB\u5EA6\u3001\u5DF2\u8BFB\u7AE0\u8282\u6458\u8981\u7D22\u5F15\u3001\u4EE5\u53CA\uFF08\u53EF\u9009\u7684\uFF09\u9009\u4E2D\u6BB5\u843D\u4E0E\u68C0\u7D22\u7247\u6BB5\u3002\u9ED8\u8BA4\u53EA\u9700\u8981\u5728\u8BFB\u539F\u6587\u524D\u8C03\u7528\u4E00\u6B21\u3002",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "\u8BFB\u8005\u8FD9\u6B21\u95EE\u7684\u8BDD\uFF0C\u7528\u4E8E\u68C0\u7D22\u5DF2\u8BFB\u8303\u56F4\u5185\u7684\u76F8\u5173\u6BB5\u843D" },
          includeWindow: { type: "boolean", description: "\u662F\u5426\u5E26\u4E0A\u5F53\u524D\u9009\u4E2D\u6BB5\u843D" }
        },
        additionalProperties: false
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId);
        const progress = await progressOf(meta.id);
        const index = await summaryIndexText(library, meta.id, progress);
        const parts = [progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }), "", index];
        if (args?.includeWindow && state.lastSelection) {
          try {
            const window = await selectionWindow(library, meta.id, progress, state.lastSelection);
            parts.push("", "\u3010\u9009\u4E2D\u539F\u6587\u3011", window.text);
          } catch (error) {
            parts.push("", "\u3010\u9009\u4E2D\u539F\u6587\u3011\u8FDB\u5EA6\u95E8\u62D2\u7EDD\u4E86\u8FD9\u4E2A\u4F4D\u7F6E\uFF0C\u56E0\u6B64\u6CA1\u6709\u6CE8\u5165\u4EFB\u4F55\u539F\u6587\u3002");
          }
        }
        if (typeof args?.question === "string" && args.question.length > 0) {
          const hits = await retrieveRead(library, cache, meta.id, progress, args.question, { limit: 4 });
          if (hits.length > 0) parts.push("", "\u3010\u5DF2\u8BFB\u8303\u56F4\u5185\u7684\u76F8\u5173\u6BB5\u843D\u3011", retrievalText(hits));
        }
        return parts.join("\n");
      }
    })
  );
  return { dispose: () => disposers.forEach((dispose) => dispose()) };
}
function reviewsFor(reviews, cardId) {
  return reviews.filter((review) => (review.cardId ?? review.id) === cardId);
}

// src/index.js
var name = "dsh-reading-companion";
var inject = ["tools", "systemPrompt"];
function apply(ctx, config = {}) {
  const store = new Store({ root: config.dataDir || void 0 });
  const library = new Library(store);
  const cache = new ReadIndexCache();
  const state = {
    activeBookId: (
      /** @type {string | null} */
      null
    ),
    lastSelection: (
      /** @type {any} */
      null
    )
  };
  const summaries = createSummaries({ ctx, library, config });
  const statePath = store.path("state.json");
  const persisted = readJsonSync(statePath, null);
  if (persisted && typeof persisted.activeBookId === "string") state.activeBookId = persisted.activeBookId;
  const persistActiveBook = async (bookId) => {
    await writeJson(statePath, { activeBookId: bookId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
  };
  const progressSync = (bookId) => {
    if (!bookId) return null;
    return readJsonSync(store.progressPath(bookId), null);
  };
  ctx.logger?.info?.(`reading-companion: data at ${store.root}`);
  void library.ensureLayout();
  const tools = registerTools({ ctx, library, cache, summaries, config, state });
  const guardDisposer = installGuard({ ctx, state, config, progressSync, bookIds: () => store.syncBookIds() });
  ctx.inject(["systemPrompt"], (prompted) => {
    prompted.get("systemPrompt").section({
      name: "reading-companion",
      order: config.promptOrder ?? 85,
      text: () => {
        const bookId = state.activeBookId;
        const meta = bookId ? readJsonSync(store.bookPath(bookId, "meta.json"), null) : null;
        if (!meta) return RULES;
        const progress = progressSync(bookId);
        const line = describeProgress(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount });
        const selection = state.lastSelection;
        const selectionLine = selection?.quote && typeof selection.sectionIndex === "number" ? `
\u8BFB\u8005\u521A\u9009\u4E2D\u4E86\u7B2C ${selection.sectionIndex + 1} \u7AE0\u7684\u8FD9\u4E00\u6BB5\uFF08\u53EA\u4F5C\u5B9A\u4F4D\u7528\uFF0C\u6B63\u6587\u8981\u7528 read_text_window \u53D6\uFF09\uFF1A"${String(selection.quote).slice(0, 160)}"` : "";
        return `${RULES}

\u3010\u8FD9\u672C\u4E66\u7684\u5F53\u524D\u8FB9\u754C\u3011
${line}${selectionLine}`;
      }
    });
  });
  ctx.inject(["webServer"], (webCtx) => {
    const routes = registerRoutes({ ctx: webCtx, library, cache, summaries, config, state, persistActiveBook });
    webCtx.effect(() => () => routes.dispose());
  });
  ctx.effect(() => () => {
    tools.dispose();
    guardDisposer?.();
  });
}
export {
  apply,
  inject,
  name
};
