/**
 * The gated context builder — the single door between book text and a model.
 *
 * Every function here starts by asking the spoiler gate. The retrieval arm does
 * not "search then filter": it filters the candidate chunks first and builds the
 * BM25/vector index over the surviving chunks only, so an unread passage is not
 * merely excluded from the answer, it never enters the index or the prompt.
 */

import { HybridIndex } from '../shared/retrieval.js'
import { clip } from '../shared/retrieval.js'
import { buildCfi } from '../shared/cfi.js'
import { describeProgress, filterReadable, gateTarget, requireReadable, resolveSectionIndex } from '../shared/spoiler.js'

/**
 * Per-ceiling index cache. The key includes the read-through ceiling because an
 * index built at chapter 3 must never answer a question asked at chapter 5.
 */
export class ReadIndexCache {
  constructor(limit = 6) {
    this.limit = limit
    /** @type {Map<string, HybridIndex>} */
    this.cache = new Map()
  }

  /**
   * @param {import('./books.js').Library} library
   * @param {string} bookId
   * @param {any} progress
   */
  async indexFor(library, bookId, progress) {
    const ceiling = typeof progress?.sectionIndex === 'number' ? progress.sectionIndex : -1
    const key = `${bookId}@${ceiling}`
    const cached = this.cache.get(key)
    if (cached) return cached
    const chunks = await library.chunks(bookId)
    const readable = filterReadable(chunks, progress)
    if (readable.length === 0) return null
    const index = new HybridIndex(readable)
    this.cache.set(key, index)
    if (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    return index
  }
}

/**
 * How far the reader has got, as one line the model can act on.
 * @param {any} progress
 * @param {{ bookTitle?: string | null, sectionCount?: number | null }} [extra]
 */
export function progressLine(progress, extra = {}) {
  return describeProgress(progress, extra)
}

/**
 * The chapter-summary index, cut at the reader's chapter.
 *
 * Chapters the reader has not reached are not represented at all — no title, no
 * placeholder, no count of what is in them. "想剧透也没材料" is a property of
 * this function, not of the prompt.
 *
 * @param {import('./books.js').Library} library
 * @param {string} bookId
 * @param {any} progress
 * @param {{ maxChapters?: number }} [options]
 */
export async function summaryIndexText(library, bookId, progress, options = {}) {
  const ceiling = progress?.sectionIndex
  if (typeof ceiling !== 'number' || !Number.isInteger(ceiling)) return ''
  const meta = await library.meta(bookId)
  const sections = Array.isArray(meta?.sections) ? meta.sections : []
  const summaries = await library.summaries(bookId)
  const maxChapters = options.maxChapters ?? 120
  const lines = []
  const start = Math.max(0, ceiling - maxChapters + 1)
  if (start > 0) lines.push(`（第 1 至 ${start} 章的摘要未注入，需要时可让工具读取。）`)
  for (let index = start; index <= ceiling; index += 1) {
    const section = sections[index]
    const record = summaries.get(index)
    const title = section?.title ? `「${section.title}」` : ''
    if (record?.summary) lines.push(`第 ${index + 1} 章${title}：${record.summary}`)
    else lines.push(`第 ${index + 1} 章${title}：（摘要还没生成，正文可用 read_text_window 读取）`)
  }
  return lines.join('\n')
}

/**
 * The reader's selected passage, plus real text on both sides.
 *
 * @param {import('./books.js').Library} library
 * @param {string} bookId
 * @param {any} progress
 * @param {{ cfi?: string | null, sectionIndex?: number | null, quote?: string | null, before?: number, after?: number }} selection
 * @returns {Promise<{ text: string, sectionIndex: number, title: string | null, window: any }>}
 */
export async function selectionWindow(library, bookId, progress, selection) {
  const sections = await library.sections(bookId)
  // The chapter comes from a chapter number or from the CFI's document, never
  // from the CFI's own step number: a spine step is not a chapter any more.
  const sectionIndex = resolveChapterIndex(sections, { cfi: selection.cfi, sectionIndex: selection.sectionIndex })
  requireReadable({ sectionIndex }, progress, { what: '读取选中原文' })
  const index = /** @type {number} */ (sectionIndex)
  const section = sections.find((item) => item.index === index)
  const fullText = String(section?.text ?? '')
  const quote = typeof selection.quote === 'string' ? selection.quote.trim() : ''
  let center = 0
  if (quote) {
    const at = fullText.indexOf(quote)
    center = at >= 0 ? at + Math.floor(quote.length / 2) : 0
  }
  const window = await library.textWindow(bookId, index, {
    center,
    before: selection.before ?? 300,
    after: selection.after ?? 300,
  })
  return {
    sectionIndex: index,
    title: window?.title ?? null,
    text: window?.text ?? '',
    window,
  }
}

/**
 * Hybrid retrieval restricted to the read range.
 *
 * @param {import('./books.js').Library} library
 * @param {ReadIndexCache} cache
 * @param {string} bookId
 * @param {any} progress
 * @param {string} query
 * @param {{ limit?: number }} [options]
 */
export async function retrieveRead(library, cache, bookId, progress, query, options = {}) {
  const index = await cache.indexFor(library, bookId, progress)
  if (!index) return []
  return index.search(query, { limit: options.limit ?? 4 }).map((hit) => ({
    sectionIndex: hit.chunk.sectionIndex,
    cfi: hit.chunk.cfi ?? buildCfi(hit.chunk.sectionIndex),
    score: Number(hit.score.toFixed(4)),
    text: clip(hit.chunk.text, 500),
  }))
}

/**
 * Format retrieval hits for the prompt.
 * @param {{ sectionIndex: number, text: string, cfi: string }[]} hits
 */
export function retrievalText(hits) {
  if (!hits || hits.length === 0) return ''
  return hits
    .map((hit, index) => `〔${index + 1}〕第 ${hit.sectionIndex + 1} 章\n${hit.text}`)
    .join('\n\n')
}

/**
 * Does this target sit inside the readable range? Used by the tool layer before
 * it touches anything.
 * @param {any} progress
 * @param {{ cfi?: string | null, sectionIndex?: number | null }} target
 */
export function gate(progress, target) {
  return gateTarget(target, progress)
}
