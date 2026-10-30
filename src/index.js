/**
 * dsh-reading-companion — Host entry.
 *
 * The plugin turns a book the reader is *already reading* into something a
 * conversation can sit next to: it stores the reading position, indexes the text
 * per chapter, and hands the model gated access to the read range only.
 *
 * Wiring order mirrors the dependency order of the design:
 *   1. the progress coordinate         → store + library
 *   2. the spoiler gate                → tool entries + synchronous guard
 *   3. model-facing tools              → host/tools.js
 *   4. the co-reader stance            → system prompt section
 *   5. HTTP surface                    → the reading panel's channel
 */

import { Library } from './host/books.js'
import { ReadIndexCache } from './host/context.js'
import { RULES } from './host/guidance.js'
import { installGuard } from './host/guard.js'
import { registerRoutes } from './host/routes.js'
import { Store, readJsonSync, writeJson } from './host/store.js'
import { createSummaries } from './host/summaries.js'
import { registerTools } from './host/tools.js'
import { describeProgress } from './shared/spoiler.js'

export const name = 'dsh-reading-companion'
/** `webServer` is optional on purpose: without it the tools still work in a
 *  headless session, there is just no reading panel to drive them. */
export const inject = ['tools', 'systemPrompt']

/**
 * @param {any} ctx
 * @param {{ dataDir?: string, summaryModel?: string, summaryProvider?: string, spoilerGate?: boolean, windowChars?: number, promptOrder?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const store = new Store({ root: config.dataDir || undefined })
  const library = new Library(store)
  const cache = new ReadIndexCache()
  const state = {
    activeBookId: /** @type {string | null} */ (null),
    lastSelection: /** @type {any} */ (null),
  }
  const summaries = createSummaries({ ctx, library, config })

  const statePath = store.path('state.json')
  const persisted = readJsonSync(statePath, null)
  if (persisted && typeof persisted.activeBookId === 'string') state.activeBookId = persisted.activeBookId

  /** @param {string | null} bookId */
  const persistActiveBook = async (bookId) => {
    await writeJson(statePath, { activeBookId: bookId, updatedAt: new Date().toISOString() })
  }

  /** Synchronous progress read, for the guard and for the prompt section. */
  const progressSync = (/** @type {string | null} */ bookId) => {
    if (!bookId) return null
    return readJsonSync(store.progressPath(bookId), null)
  }

  ctx.logger?.info?.(`reading-companion: data at ${store.root}`)
  void library.ensureLayout()

  // 3. model-facing tools — every entry calls the gate itself
  const tools = registerTools({ ctx, library, cache, summaries, config, state })

  // 2. and the synchronous guard runs before any of them can start
  const guardDisposer = installGuard({ ctx, state, config, progressSync, bookIds: () => store.syncBookIds() })

  // 4. the co-reader stance, with this book's boundary appended per turn
  ctx.inject(['systemPrompt'], (prompted) => {
    prompted.get('systemPrompt').section({
      name: 'reading-companion',
      order: config.promptOrder ?? 85,
      text: () => {
        const bookId = state.activeBookId
        const meta = bookId ? readJsonSync(store.bookPath(bookId, 'meta.json'), null) : null
        if (!meta) return RULES
        const progress = progressSync(bookId)
        const line = describeProgress(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount })
        const selection = state.lastSelection
        const selectionLine =
          selection?.quote && typeof selection.sectionIndex === 'number'
            ? `\n读者刚选中了第 ${selection.sectionIndex + 1} 章的这一段（只作定位用，正文要用 read_text_window 取）："${String(selection.quote).slice(0, 160)}"`
            : ''
        return `${RULES}\n\n【这本书的当前边界】\n${line}${selectionLine}`
      },
    })
  })

  // 5. HTTP surface for the reading panel
  ctx.inject(['webServer'], (webCtx) => {
    const routes = registerRoutes({ ctx: webCtx, library, cache, summaries, config, state, persistActiveBook })
    webCtx.effect(() => () => routes.dispose())
  })

  ctx.effect(() => () => {
    tools.dispose()
    guardDisposer?.()
  })
}
