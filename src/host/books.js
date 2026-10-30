/**
 * The library: imported books, their text index, progress and the append-only
 * reader records around them.
 *
 * This class is the only place that touches book text on the Host, so it is the
 * place where text is cut into chunks and where a book's identity (spine index
 * per section) is fixed. Everything the model may see is built on top of it and
 * passes the spoiler gate first.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { Store, appendLine, bookIdFor, readJson, readLines, writeJson } from './store.js'
import { parseEpub } from './epub.js'
import { buildChapters } from './chapters.js'
import { normalizeToEpub } from './formats/index.js'
import { HybridIndex, chunkSection } from '../shared/retrieval.js'
import { buildCfi } from '../shared/cfi.js'
import { takeawayId } from '../shared/cards.js'
import { isCfi, spineIndexOf } from '../shared/cfi.js'

/**
 * Chapter records as they are stored: the table-of-contents entry, its text,
 * and the spine document it came from. The document index is what keeps a
 * chapter addressable — foliate navigates by spine, and every CFI we receive
 * resolves to a document first.
 * @param {any[]} chapters
 */
function chapterRecords(chapters) {
  return chapters.map((chapter) => ({
    index: chapter.index,
    title: chapter.title,
    href: chapter.href ?? null,
    docIndex: chapter.docIndex,
    startChar: chapter.startChar ?? 0,
    chars: chapter.chars,
    text: chapter.text,
  }))
}

/** Chapters that live in one spine document, in reading order. */
export function chaptersInDoc(sections, docIndex) {
  return (sections ?? []).filter((section) => section.docIndex === docIndex)
}

/** Compare hrefs the way the EPUB generator wrote them: decoded, no "./". */
function normalizeHref(href) {
  if (typeof href !== 'string' || href.length === 0) return null
  let out = href
  try {
    out = decodeURIComponent(href)
  } catch {
    out = href
  }
  out = out.replace(/^\.\//, '').replace(/^\//, '')
  return out.length > 0 ? out : null
}

/**
 * Which chapter the reader is in, from what foliate can tell us: the current
 * table-of-contents entry's href, and the spine document the position is in.
 *
 * A book whose anchors resolve gives an exact href match. A converted book
 * whose anchors are broken cannot: foliate then reports the last entry it knows
 * of inside the document, so we take the last chapter of that document too —
 * the same belief, expressed in our numbers.
 *
 * @param {any[]} sections
 * @param {string | null | undefined} href
 * @param {number | null | undefined} spineIndex
 * @returns {number | null}
 */
export function resolveChapterFromHref(sections, href, spineIndex) {
  const wanted = normalizeHref(href)
  if (wanted) {
    const exact = sections.find((section) => normalizeHref(section.href) === wanted)
    if (exact) return exact.index
    const docPart = wanted.split('#')[0]
    const sameDoc = sections.filter((section) => normalizeHref(section.href)?.split('#')[0] === docPart)
    if (sameDoc.length > 0) return sameDoc[sameDoc.length - 1].index
  }
  if (typeof spineIndex === 'number' && Number.isInteger(spineIndex)) {
    const inside = chaptersInDoc(sections, spineIndex)
    if (inside.length > 0) return inside[inside.length - 1].index
  }
  return null
}

/**
 * Which chapter a tool call or a highlight is about. A chapter number is taken
 * at its word (the client knows it exactly); a bare CFI resolves through its
 * spine document to the LAST chapter in it, which is the least privileged
 * answer — guessing the first one would let a stale anchor quietly unlock text
 * the reader has not reached.
 * @param {any[]} sections
 * @param {{ chapterIndex?: unknown, sectionIndex?: unknown, cfi?: unknown }} target
 * @returns {number | null}
 */
export function resolveChapterIndex(sections, target) {
  const claimed = typeof target?.chapterIndex === 'number' ? target.chapterIndex : typeof target?.sectionIndex === 'number' ? target.sectionIndex : null
  if (claimed !== null) return claimed
  if (!isCfi(target?.cfi)) return null
  const inside = chaptersInDoc(sections, spineIndexOf(target.cfi))
  if (inside.length === 0) return null
  return inside[inside.length - 1].index
}

export class Library {
  /** @param {Store} [store] */
  constructor(store = new Store()) {
    this.store = store
    /** @type {Map<string, any[]>} */
    this.sectionCache = new Map()
    /** @type {Map<string, any[]>} */
    this.chunkCache = new Map()
    /** @type {Map<string, import('../shared/retrieval.js').HybridIndex>} */
    this.indexCache = new Map()
    /** Books already examined for the chapter split, once per process. */
    this.upgraded = new Set()
  }

  async ensureLayout() {
    await this.store.ensureLayout()
  }

  /** @returns {Promise<any[]>} */
  async list() {
    return this.store.listBooks()
  }

  /** @param {string} bookId */
  async meta(bookId) {
    const meta = await readJson(this.store.bookPath(bookId, 'meta.json'), null)
    if (!meta) return null
    // Books imported before the table of contents was indexed get it filled in
    // from the stored source, so an old library does not stay stuck at "5 章".
    const tocStale = !Array.isArray(meta.toc) || meta.toc.length === 0 || (meta.tocVersion ?? 1) < 2
    if (tocStale) {
      try {
        const bytes = await this.sourceBytes(bookId)
        if (bytes) {
          meta.toc = parseEpub(bytes).toc ?? []
          meta.tocVersion = 2
          await writeJson(this.store.bookPath(bookId, 'meta.json'), meta)
        }
      } catch {
        meta.toc = []
      }
    }
    return meta
  }

  /**
   * Import any supported format. Non-EPUB input is normalized into an EPUB
   * first, so rendering, spine numbering and the CFI space stay one thing.
   * @param {Buffer} bytes
   * @param {{ fileName?: string }} [options]
   */
  async importFile(bytes, options = {}) {
    const normalized = normalizeToEpub(bytes, { fileName: options.fileName })
    const meta = await this.importEpub(normalized.epub, options)
    const merged = {
      ...meta,
      format: normalized.format,
      textless: normalized.textless === true,
      warnings: normalized.warnings ?? [],
      originalName: options.fileName ?? null,
    }
    await writeJson(this.store.bookPath(meta.id, 'meta.json'), merged)
    return merged
  }

  /**
   * Import an EPUB: parse, persist, chunk.
   * @param {Buffer} bytes
   * @param {{ fileName?: string }} [options]
   */
  async importEpub(bytes, options = {}) {
    const parsed = parseEpub(bytes)
    const id = bookIdFor({ title: parsed.title, bytes })
    const dir = this.store.bookDir(id)
    await this.ensureLayout()
    await fsp.mkdir(dir, { recursive: true })

    await fsp.writeFile(this.store.bookPath(id, 'source.epub'), bytes)
    // A chapter is a table-of-contents entry, not a spine file: one file here
    // holds seven chapters, and progress measured in files would unlock all of
    // them at once.
    const split = buildChapters(parsed)
    const sections = chapterRecords(split.chapters)
    await writeJson(this.store.bookPath(id, 'sections.json'), sections)

    const meta = {
      id,
      title: parsed.title,
      author: parsed.author,
      language: parsed.language,
      chapterCount: sections.length,
      docCount: parsed.sections.length,
      toc: parsed.toc ?? [],
      tocVersion: 2,
      chaptersVersion: 2,
      splitStats: split.stats,
      sections: sections.map(({ index, href, title, chars, docIndex }) => ({ index, href, title, chars, docIndex })),
      fileName: options.fileName ?? null,
      importedAt: new Date().toISOString(),
    }
    await writeJson(this.store.bookPath(id, 'meta.json'), meta)
    this.sectionCache.set(id, sections)
    await this.buildChunks(id, sections)
    return meta
  }

  /**
   * Cut every section into retrieval chunks and persist them.
   * Chunks carry the section index, which is the spine index an EPUB CFI uses.
   * @param {string} bookId
   * @param {any[]} sections
   */
  async buildChunks(bookId, sections) {
    /** @type {any[]} */
    const chunks = []
    for (const section of sections) {
      for (const piece of chunkSection(section.text, section.index)) {
        chunks.push({
          id: `${bookId}:${section.index}:${piece.start}`,
          bookId,
          sectionIndex: section.index,
          start: piece.start,
          end: piece.end,
          // A chapter is not a spine document, so the anchor points at the
          // document that holds it; jumping there lands on that chapter's page
          // because the reader restores the closest position it can express.
          cfi: buildCfi(section.docIndex ?? section.index),
          docIndex: section.docIndex ?? section.index,
          text: piece.text,
        })
      }
    }
    await writeJson(this.store.bookPath(bookId, 'chunks.json'), chunks)
    this.chunkCache.set(bookId, chunks)
    this.indexCache.delete(bookId)
    return chunks
  }

  /** @param {string} bookId @returns {Promise<any[]>} */
  async sections(bookId) {
    const cached = this.sectionCache.get(bookId)
    if (cached) return cached
    if (!this.upgraded.has(bookId)) {
      this.upgraded.add(bookId)
      await this.ensureChapters(bookId)
    }
    const sections = await readJson(this.store.bookPath(bookId, 'sections.json'), [])
    this.sectionCache.set(bookId, sections)
    return sections
  }

  /**
   * Re-cut a library that was imported when a chapter meant a spine document.
   * The split runs from the stored EPUB, so nothing has to be re-imported; the
   * reading position is lifted to the END of the document it used to point at,
   * which can only widen what the reader has already read, never narrow it.
   */
  async ensureChapters(bookId) {
    const meta = await readJson(this.store.bookPath(bookId, 'meta.json'), null)
    if (!meta) return null
    if ((meta.chaptersVersion ?? 1) >= 2) return meta
    let split
    try {
      const bytes = await this.sourceBytes(bookId)
      if (!bytes) return meta
      split = buildChapters(parseEpub(bytes))
    } catch {
      return meta
    }
    const sections = chapterRecords(split.chapters)
    if (sections.length === 0) return meta
    await writeJson(this.store.bookPath(bookId, 'sections.json'), sections)
    const next = {
      ...meta,
      chapterCount: sections.length,
      docCount: meta.docCount ?? split.stats.docs,
      chaptersVersion: 2,
      splitStats: split.stats,
      sections: sections.map(({ index, href, title, chars, docIndex }) => ({ index, href, title, chars, docIndex })),
    }
    await writeJson(this.store.bookPath(bookId, 'meta.json'), next)
    this.sectionCache.set(bookId, sections)
    this.chunkCache.delete(bookId)
    this.indexCache.delete(bookId)
    await this.buildChunks(bookId, sections)
    await this.migrateProgress(bookId, sections)
    return next
  }

  /** Move a document-level progress record onto chapter numbers. */
  async migrateProgress(bookId, sections) {
    const old = await readJson(this.store.progressPath(bookId), null)
    if (!old || (old.chaptersVersion ?? 1) >= 2) return old
    const ceilingInDoc = chaptersInDoc(sections, old.sectionIndex)
    const positionInDoc = chaptersInDoc(sections, old.positionSectionIndex ?? old.sectionIndex)
    const ceiling = ceilingInDoc.length > 0 ? ceilingInDoc[ceilingInDoc.length - 1].index : Math.min(old.sectionIndex ?? 0, sections.length - 1)
    const position = positionInDoc.length > 0 ? positionInDoc[0].index : 0
    const next = {
      ...old,
      sectionIndex: ceiling,
      positionSectionIndex: position,
      chapterTitle: sections[position]?.title ?? old.chapterTitle ?? null,
      ceilingTitle: sections[ceiling]?.title ?? old.ceilingTitle ?? null,
      sectionCount: sections.length,
      chaptersVersion: 2,
      updatedAt: old.updatedAt ?? new Date().toISOString(),
      migratedAt: new Date().toISOString(),
    }
    await writeJson(this.store.progressPath(bookId), next)
    return next
  }

  /** @param {string} bookId @returns {Promise<any[]>} */
  async chunks(bookId) {
    const cached = this.chunkCache.get(bookId)
    if (cached) return cached
    let chunks = await readJson(this.store.bookPath(bookId, 'chunks.json'), null)
    if (!Array.isArray(chunks) || chunks.length === 0) {
      const sections = await this.sections(bookId)
      if (sections.length === 0) return []
      chunks = await this.buildChunks(bookId, sections)
    }
    this.chunkCache.set(bookId, chunks)
    return chunks
  }

  /** @param {string} bookId */
  async index(bookId) {
    const cached = this.indexCache.get(bookId)
    if (cached) return cached
    const chunks = await this.chunks(bookId)
    const index = new HybridIndex(chunks)
    this.indexCache.set(bookId, index)
    return index
  }

  /** @param {string} bookId @returns {Promise<any | null>} */
  async progress(bookId) {
    return readJson(this.store.progressPath(bookId), null)
  }

  /**
   * Record where the reader is. The gate reads `sectionIndex`, which is a
   * read-through ceiling: turning back to an earlier chapter must not make
   * later chapters unread again.
   * @param {string} bookId
   * @param {{ cfi?: string | null, positionSectionIndex?: number | null, chapterTitle?: string | null, sectionCount?: number | null }} input
   */
  async saveProgress(bookId, input) {
    const previous = (await this.progress(bookId)) ?? null
    const meta = await this.meta(bookId)
    const sectionCount = input.sectionCount ?? meta?.chapterCount ?? null
    let position =
      typeof input.positionSectionIndex === 'number' && Number.isInteger(input.positionSectionIndex)
        ? input.positionSectionIndex
        : null
    if (position === null && typeof previous?.positionSectionIndex === 'number') position = previous.positionSectionIndex
    if (position === null) position = 0
    if (typeof sectionCount === 'number' && sectionCount > 0) {
      position = Math.min(Math.max(0, position), sectionCount - 1)
    }
    const previousCeiling = typeof previous?.sectionIndex === 'number' ? previous.sectionIndex : -1
    const ceiling = Math.max(previousCeiling, position)
    const section = Array.isArray(meta?.sections) ? meta.sections[position] : null
    const chapterTitle = input.chapterTitle ?? section?.title ?? previous?.chapterTitle ?? null
    // The ceiling keeps its own title: it is a high-water mark, and the reader
    // may be browsing an earlier chapter while the ceiling stays put.
    const ceilingTitle =
      position >= previousCeiling
        ? chapterTitle
        : (previous?.ceilingTitle ?? previous?.chapterTitle ?? chapterTitle)
    const next = {
      bookId,
      cfi: typeof input.cfi === 'string' && input.cfi.length > 0 ? input.cfi : (previous?.cfi ?? null),
      sectionIndex: ceiling,
      positionSectionIndex: position,
      chapterTitle,
      ceilingTitle,
      sectionCount: typeof sectionCount === 'number' ? sectionCount : null,
      updatedAt: new Date().toISOString(),
    }
    await writeJson(this.store.progressPath(bookId), next)
    return next
  }

  /** @param {string} bookId */
  async summaries(bookId) {
    const records = await readLines(this.store.logPath('summaries', bookId))
    /** @type {Map<number, any>} */
    const latest = new Map()
    for (const record of records) {
      if (typeof record?.sectionIndex !== 'number') continue
      const existing = latest.get(record.sectionIndex)
      if (!existing || String(record.generatedAt ?? '') >= String(existing.generatedAt ?? '')) {
        latest.set(record.sectionIndex, record)
      }
    }
    return latest
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
      generatedAt: new Date().toISOString(),
    }
    await appendLine(this.store.logPath('summaries', bookId), record)
    return record
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
    const sections = await this.sections(bookId)
    const section = sections.find((item) => item.index === sectionIndex)
    if (!section) return null
    const text = String(section.text ?? '')
    const before = options.before ?? 300
    const after = options.after ?? 300
    const center = Math.min(Math.max(0, options.center ?? 0), text.length)
    const start = Math.max(0, center - before)
    const end = Math.min(text.length, center + after)
    return {
      sectionIndex,
      title: section.title ?? null,
      text: text.slice(start, end),
      start,
      end,
      truncatedBefore: start > 0,
      truncatedAfter: end < text.length,
    }
  }

  /** @param {string} bookId @param {any} note */
  async addNote(bookId, note) {
    const record = { bookId, createdAt: new Date().toISOString(), ...note }
    await appendLine(this.store.logPath('notes', bookId), record)
    return record
  }

  /** @param {string} bookId */
  async notes(bookId) {
    return readLines(this.store.logPath('notes', bookId))
  }

  /** @param {string} bookId @param {any} takeaway */
  async addTakeaway(bookId, takeaway) {
    const record = { bookId, createdAt: new Date().toISOString(), ...takeaway }
    // Every takeaway needs a stable id: cards are derived from it, and a card id
    // is `${takeawayId}:${n}` so re-deriving the same takeaway must not mint new
    // cards. Derive it here, at the one place takeaways are created.
    if (!record.id) {
      record.id = takeawayId({
        type: record.type,
        cfi: record.cfi,
        aiSummary: record.aiSummary,
        createdAt: Date.parse(record.createdAt),
      })
    }
    await appendLine(this.store.logPath('takeaways', bookId), record)
    return record
  }

  /** @param {string} bookId */
  async takeaways(bookId) {
    return readLines(this.store.logPath('takeaways', bookId))
  }

  /** @param {string} bookId @param {any[]} cards */
  async addCards(bookId, cards) {
    if (!Array.isArray(cards) || cards.length === 0) return []
    const existing = new Map((await this.cards(bookId)).map((card) => [card.cardId ?? card.id, card]))
    /** @type {string[]} */
    const created = []
    for (const card of cards) {
      // Cards are identified by their stable `${takeawayId}:${n}` id, so the same
      // takeaway never yields two cards. If the derivation rules improve, the new
      // wording is appended for the same id and supersedes the old line — the log
      // stays append-only, the reader does not end up with two copies of one idea.
      const cardId = card?.id ?? card?.cardId
      if (!cardId) continue
      const previous = existing.get(cardId)
      if (previous && previous.front === card.front && previous.back === card.back) continue
      await appendLine(this.store.logPath('cards', bookId), { bookId, ...card, cardId, createdAt: card.createdAt ?? new Date().toISOString() })
      created.push(cardId)
    }
    return created
  }

  /** @param {string} bookId */
  async cardIds(bookId) {
    const cards = await this.cards(bookId)
    return new Set(cards.map((card) => card.cardId ?? card.id))
  }

  /** @param {string} bookId */
  async cards(bookId) {
    // One card per id, newest line wins: a re-derived card supersedes its earlier
    // wording while the JSONL log itself only ever grows.
    /** @type {Map<string, any>} */
    const byId = new Map()
    for (const line of await readLines(this.store.logPath('cards', bookId))) {
      const cardId = line?.cardId ?? line?.id
      if (!cardId) continue
      byId.set(cardId, line)
    }
    return [...byId.values()]
  }

  /** @param {string} bookId @param {any} review */
  async addReview(bookId, review) {
    const record = { bookId, at: new Date().toISOString(), ...review }
    await appendLine(this.store.logPath('reviews', bookId), record)
    return record
  }

  /** @param {string} bookId */
  async reviews(bookId) {
    return readLines(this.store.logPath('reviews', bookId))
  }

  /** @param {string} bookId @returns {Promise<Buffer | null>} */
  async sourceBytes(bookId) {
    try {
      return await fsp.readFile(this.store.bookPath(bookId, 'source.epub'))
    } catch {
      return null
    }
  }

  /** @param {string} bookId */
  async sourceExists(bookId) {
    try {
      await fsp.stat(this.store.bookPath(bookId, 'source.epub'))
      return true
    } catch {
      return false
    }
  }

  /** Directory used for the client-visible EPUB path (empty string when none). */
  bookFilePath(bookId) {
    return this.store.bookPath(bookId, 'source.epub')
  }

  /** @param {string} bookId */
  async sectionDirectory(bookId) {
    const meta = await this.meta(bookId)
    return Array.isArray(meta?.sections) ? meta.sections : []
  }

  /** @param {string} bookId */
  async stats(bookId) {
    const [takeaways, cards, reviews, notes] = await Promise.all([
      this.takeaways(bookId),
      this.cards(bookId),
      this.reviews(bookId),
      this.notes(bookId),
    ])
    return {
      takeaways: takeaways.length,
      cards: cards.length,
      reviews: reviews.length,
      notes: notes.length,
      bookPath: this.bookFilePath(bookId),
      dir: path.dirname(this.bookFilePath(bookId)),
    }
  }
}

export { Store }
