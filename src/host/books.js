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
import { normalizeToEpub } from './formats/index.js'
import { HybridIndex, chunkSection } from '../shared/retrieval.js'
import { buildCfi } from '../shared/cfi.js'
import { takeawayId } from '../shared/cards.js'

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
    const sections = parsed.sections.map((section) => ({
      index: section.index,
      href: section.href,
      path: section.path,
      title: section.title,
      chars: section.chars,
      text: section.text,
    }))
    await writeJson(this.store.bookPath(id, 'sections.json'), sections)

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
          cfi: buildCfi(section.index),
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
    const sections = await readJson(this.store.bookPath(bookId, 'sections.json'), [])
    this.sectionCache.set(bookId, sections)
    return sections
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
