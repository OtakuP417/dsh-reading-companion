/**
 * Filesystem store for reader-owned state.
 *
 * Everything the plugin remembers lives under one root. Files are small and
 * machine-local, so the whole layer is plain node:fs: JSON documents are
 * replaced atomically (write a sibling temp file, then rename), and event-like
 * data (notes, takeaways, cards, reviews) is appended one JSON object per line
 * so no write can ever destroy an earlier record — "只增不减".
 *
 * A linked plugin package cannot import DSH's own atomic-write package, so the
 * tmp+rename primitive is hand-written here on purpose.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readdirSync } from 'node:fs'

/** Default data root: `$DSH_HOME/reading-companion`. */
export function defaultRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'reading-companion')
}

/** @param {string} dir */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

/**
 * Atomically replace a JSON document.
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file))
  const body = JSON.stringify(value, null, 2)
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(tmp, file)
}

/**
 * Read a JSON document, or `fallback` when it is missing or unparsable.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(file, fallback) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** @param {string} file */
export function readJsonSync(file, fallback) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Append one JSON line. Append-only: a record is never rewritten or removed.
 * @param {string} file
 * @param {unknown} record
 */
export async function appendLine(file, record) {
  await ensureDir(path.dirname(file))
  await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
}

/**
 * Read a JSONL file, skipping unparsable lines instead of failing.
 * @param {string} file
 * @returns {Promise<any[]>}
 */
export async function readLines(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed))
    } catch {
      // A torn final line (crash mid-append) must not hide earlier records.
    }
  }
  return out
}

/** @param {string} value */
export function slugify(value) {
  const base = String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return base || 'book'
}

/**
 * Stable identifier for an imported book: a readable slug plus a short content
 * hash, so re-importing the same file lands on the same directory.
 * @param {{ title?: string, bytes?: Buffer }} input
 */
export function bookIdFor(input) {
  const hash = crypto
    .createHash('sha1')
    .update(input.bytes ?? Buffer.from(String(input.title ?? '')))
    .digest('hex')
    .slice(0, 8)
  return `${slugify(input.title)}-${hash}`
}

/** The data layout of one book, in one place. */
export class Store {
  /**
   * A string is accepted as shorthand for `{ root }`: a caller that passes a
   * bare path and then silently writes into the real data root is the one bug
   * this class can hide from everyone, including its own tests.
   * @param {string | { root?: string }} [options]
   */
  constructor(options = {}) {
    const root = typeof options === 'string' ? options : options?.root
    this.root = root || defaultRoot()
  }

  get booksDir() {
    return path.join(this.root, 'books')
  }

  /** Join any path under the data root. @param {...string} parts */
  path(...parts) {
    return path.join(this.root, ...parts)
  }

  bookDir(bookId) {
    return path.join(this.booksDir, bookId)
  }

  /** @param {string} bookId */
  bookPath(bookId, name) {
    return path.join(this.bookDir(bookId), name)
  }

  /** @param {string} bookId */
  progressPath(bookId) {
    return path.join(this.root, 'progress', `${bookId}.json`)
  }

  /**
   * Book ids known on disk, synchronously. The guard runs synchronously, so it
   * cannot await `listBooks`; it still needs to know whether there is exactly one
   * book to fall back on when the conversation has no active book.
   * @returns {string[]}
   */
  syncBookIds() {
    try {
      return readdirSync(this.booksDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }

  /** @param {'notes'|'takeaways'|'cards'|'reviews'|'summaries'} kind @param {string} bookId */
  logPath(kind, bookId) {
    const name = kind === 'summaries' ? 'summaries.jsonl' : `${kind}.jsonl`
    return kind === 'summaries' ? this.bookPath(bookId, name) : path.join(this.root, kind, `${bookId}.jsonl`)
  }

  /** Books that have a meta.json, newest first. */
  async listBooks() {
    let entries
    try {
      entries = await fsp.readdir(this.booksDir, { withFileTypes: true })
    } catch {
      return []
    }
    const metas = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await readJson(path.join(this.booksDir, entry.name, 'meta.json'), null)
      if (meta) metas.push(meta)
    }
    metas.sort((a, b) => String(b.importedAt ?? '').localeCompare(String(a.importedAt ?? '')))
    return metas
  }

  async ensureLayout() {
    await ensureDir(this.booksDir)
    for (const kind of ['progress', 'notes', 'takeaways', 'cards', 'reviews']) {
      await ensureDir(path.join(this.root, kind))
    }
  }
}
