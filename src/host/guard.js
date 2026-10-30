/**
 * The synchronous second line of the spoiler defence.
 *
 * Every tool entry already calls the gate itself. This guard sits earlier still:
 * it runs before the tool executes, before any await, and it denies on the raw
 * arguments. A tool whose entry check was ever lost cannot leak through it, and
 * the denial reaches the model as the tool's error text, which is what makes
 * "asking about an unread passage is refused" observable in a transcript.
 */

import { gateTarget } from '../shared/spoiler.js'

export const GATED_TOOLS = new Set([
  'read_text_window',
  'search_read_text',
  'chapter_summary',
  'save_takeaway',
  'chapter_closing',
  'reading_context',
])

/**
 * @param {{
 *   ctx: any,
 *   state: { activeBookId: string | null },
 *   config: any,
 *   progressSync: (bookId: string | null) => any,
 *   bookIds?: () => string[],
 * }} deps
 */
export function installGuard(deps) {
  const { ctx, state, config, progressSync, bookIds } = deps

  const guard = (/** @type {any} */ exec) => {
    if (!exec || typeof exec.name !== 'string' || !GATED_TOOLS.has(exec.name)) return undefined
    if (config?.spoilerGate === false) return undefined
    const args = exec.arguments
    if (!args || typeof args !== 'object') return undefined
    /** @type {{ cfi: string | null, sectionIndex: number | null }} */
    const target = {
      cfi: typeof args.cfi === 'string' ? args.cfi : null,
      sectionIndex: typeof args.sectionIndex === 'number' ? args.sectionIndex : null,
    }
    if (target.cfi === null && target.sectionIndex === null) return undefined

    // Which book? Explicit argument first, then the conversation's active book,
    // then the only book on the shelf. The tool entries resolve the same way.
    let bookId = typeof args.bookId === 'string' && args.bookId.length > 0 ? args.bookId : state.activeBookId
    if (!bookId) {
      const known = bookIds?.() ?? []
      if (known.length === 1) bookId = known[0]
    }
    if (!bookId) {
      // A target we cannot attribute to a book cannot be checked against a
      // progress coordinate, so it is not allowed through.
      return '阅读位置门拒绝了这次调用：无法确认这次访问属于哪一本书，因此无法核对读者的阅读进度。请在参数里写明 bookId。'
    }

    const progress = progressSync(bookId)
    const gate = gateTarget(target, progress)
    if (gate.allowed) return undefined
    const readThrough = Number.isInteger(progress?.sectionIndex) ? `读者已读到第 ${progress.sectionIndex + 1} 章` : '这本书还没有进度记录'
    return `阅读位置门拒绝了这次调用：这次要访问的位置不在读者已读的范围内（${readThrough}）。未读章节的原文和摘要都不会提供，也不要用其他途径补足。需要的话，先请读者往下读。`
  }

  return ctx.tools.guard(guard)
}
