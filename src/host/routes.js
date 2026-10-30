/**
 * The Client's HTTP surface.
 *
 * The reading panel lives in the browser, so it needs a channel to the Host half.
 * Registers one prefix route (`/__reading/`) on `ctx.webServer` and dispatches on
 * the remaining path. The spoiler gate is applied here too — the panel's own
 * "ask about this passage" button goes through the same entry as the tool, so a
 * client-side bug cannot route around it.
 */

import { requireReadable } from '../shared/spoiler.js'
import { describeDue, replay } from '../shared/scheduler.js'
import { deriveCards } from '../shared/cards.js'
import { clip } from '../shared/retrieval.js'
import { buildCfi, isCfi, spineIndexOf } from '../shared/cfi.js'
import { chaptersInDoc, resolveChapterFromHref, resolveChapterIndex } from './books.js'
import { progressLine, retrievalText, retrieveRead, selectionWindow, summaryIndexText } from './context.js'
import { singleTurnSystem, closingSystem } from './guidance.js'
import { resolvedReadthrough } from './progress-view.js'
import { resolveRoute, streamText } from './model.js'

const PREFIX = '/__reading'
const MAX_BODY = 64 * 1024 * 1024

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const parts = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {any} value */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** @param {import('node:http').ServerResponse} res @param {Buffer} buf */
function sendBytes(res, buf, contentType = 'application/epub+zip') {
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', String(buf.length))
  res.setHeader('cache-control', 'no-store')
  res.end(buf)
}

/**
 * @param {{
 *   ctx: any,
 *   library: import('./books.js').Library,
 *   cache: import('./context.js').ReadIndexCache,
 *   summaries: ReturnType<import('./summaries.js').createSummaries>,
 *   config: any,
 *   state: { activeBookId: string | null, lastSelection: any | null },
 *   persistActiveBook: (id: string | null) => Promise<void>,
 * }} deps
 */
export function registerRoutes(deps) {
  const { ctx, library, cache, summaries, config, state, persistActiveBook } = deps

  /**
   * Cards are derived data: every takeaway implies 1–3 cards, and the derivation
   * is pure code. Re-deriving on read keeps the review layer self-healing — a
   * takeaway written before a card rule change (or before a crash) still ends up
   * with its cards, and `addCards` dedupes by content hash.
   */
  async function syncCards(bookId) {
    const takeaways = await library.takeaways(bookId)
    for (const takeaway of takeaways) {
      try {
        const cards = deriveCards(takeaway)
        if (cards.length > 0) await library.addCards(bookId, cards)
      } catch {
        // A single malformed record must not break the review pane.
      }
    }
  }

  /** Cards with their derived schedule, newest first, due first. */
  async function cardState(bookId) {
    await syncCards(bookId)
    const cards = await library.cards(bookId)
    const reviews = await library.reviews(bookId)
    const now = Date.now()
    const decorated = cards.map((card) => {
      const cardId = card.cardId ?? card.id
      const state2 = replay(reviews.filter((review) => (review.cardId ?? review.id) === cardId))
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
          label: describeDue(state2, now),
        },
      }
    })
    return decorated.sort((a, b) => Number(b.schedule.due) - Number(a.schedule.due) || a.schedule.dueAt - b.schedule.dueAt)
  }

  async function snapshot() {
    const books = await library.list()
    const activeBookId = state.activeBookId && books.some((book) => book.id === state.activeBookId) ? state.activeBookId : (books[0]?.id ?? null)
    if (activeBookId !== state.activeBookId) {
      state.activeBookId = activeBookId
      await persistActiveBook(activeBookId)
    }
    if (!activeBookId) {
      return { ok: true, root: config.dataDir ?? null, books, activeBookId: null, book: null, progress: null, summaries: null, stats: null, cards: [], takeaways: [], notes: [], dueCount: 0 }
    }
    const [progress, meta, summaryStatus, cards, takeaways, notes, stats] = await Promise.all([
      library.progress(activeBookId),
      library.meta(activeBookId),
      summaries.status(activeBookId),
      cardState(activeBookId),
      library.takeaways(activeBookId),
      library.notes(activeBookId),
      library.stats(activeBookId),
    ])
    const readthrough = progress ? resolvedReadthrough(progress, meta) : null
    return {
      ok: true,
      root: config.dataDir ?? null,
      books,
      activeBookId,
      book: meta
        ? {
            id: meta.id,
            title: meta.title,
            author: meta.author ?? '',
            language: meta.language ?? '',
            chapterCount: meta.chapterCount ?? null,
            docCount: meta.docCount ?? null,
            // Every table-of-contents row carries the chapter it opens, so the
            // panel can mark unread entries and jump to the right place.
            toc: Array.isArray(meta.toc)
              ? meta.toc.map((entry) => ({
                  index: entry.index,
                  title: entry.title,
                  href: entry.href ?? null,
                  sectionIndex: entry.sectionIndex ?? null,
                  chapterIndex: resolveChapterFromHref(meta.sections ?? [], entry.href, entry.sectionIndex),
                }))
              : [],
            format: meta.format ?? 'epub',
            textless: meta.textless === true,
            warnings: meta.warnings ?? [],
            fileName: meta.originalName ?? meta.fileName ?? null,
          }
        : null,
      progress: progress ? { ...progress, readthrough, bookTitle: meta?.title ?? null, chapterCount: meta?.chapterCount ?? null } : { readthrough, bookTitle: meta?.title ?? null, chapterCount: meta?.chapterCount ?? null },
      summaries: summaryStatus,
      stats,
      cards,
      takeaways: takeaways.map((item) => ({ ...item, quote: item.userQuote ? clip(item.userQuote, 120) : null })),
      notes,
      dueCount: cards.filter((card) => card.schedule.due).length,
    }
  }

  const handler = async (/** @type {import('node:http').IncomingMessage} */ req, /** @type {import('node:http').ServerResponse} */ res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      // ---- state -----------------------------------------------------------
      if (method === 'GET' && path === '/state') return sendJson(res, 200, await snapshot())

      if (method === 'POST' && path === '/active') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const meta = await library.meta(String(body?.bookId ?? ''))
        if (!meta) return sendJson(res, 404, { ok: false, error: `没有这本书：${body?.bookId}` })
        state.activeBookId = meta.id
        await persistActiveBook(meta.id)
        return sendJson(res, 200, await snapshot())
      }

      // ---- import / source -------------------------------------------------
      if (method === 'POST' && path === '/import') {
        // The header is percent-encoded by the client: HTTP header values must be
        // ISO-8859-1, and half the books people import have CJK file names.
        const rawName = String(req.headers['x-file-name'] ?? 'book.epub')
        let name = rawName
        try {
          name = decodeURIComponent(rawName)
        } catch {
          // A client that sent the raw name (or a broken escape) still gets a try.
        }
        name = name.split(/[\\/]/).pop() || 'book.epub'
        const bytes = await readBody(req)
        if (bytes.length === 0) return sendJson(res, 400, { ok: false, error: '上传的文件是空的' })
        let meta
        try {
          meta = await library.importFile(bytes, { fileName: name })
        } catch (error) {
          // Format refusals are the user's business, not a 500.
          return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        state.activeBookId = meta.id
        await persistActiveBook(meta.id)
        ctx.logger?.info?.(
          `reading: imported ${meta.title} (${meta.format ?? 'epub'}, ${meta.chapterCount} sections)`,
        )
        return sendJson(res, 200, {
          ok: true,
          bookId: meta.id,
          format: meta.format ?? 'epub',
          warnings: meta.warnings ?? [],
          meta,
          state: await snapshot(),
        })
      }

      if (method === 'GET' && path.startsWith('/book/') && path.endsWith('/file')) {
        const bookId = decodeURIComponent(path.slice('/book/'.length, -'/file'.length))
        const bytes = await library.sourceBytes(bookId)
        if (!bytes) return sendJson(res, 404, { ok: false, error: '这本书的源文件不在本地' })
        return sendBytes(res, bytes)
      }

      if (method === 'GET' && path.startsWith('/book/') && path.endsWith('/meta')) {
        const bookId = decodeURIComponent(path.slice('/book/'.length, -'/meta'.length))
        const meta = await library.meta(bookId)
        if (!meta) return sendJson(res, 404, { ok: false, error: '没有这本书' })
        return sendJson(res, 200, { ok: true, meta })
      }

      // ---- reading position ------------------------------------------------
      if (method === 'POST' && path === '/progress') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        if (!bookId) return sendJson(res, 400, { ok: false, error: '还没有打开任何书' })
        if (!isCfi(body?.cfi) && typeof body?.cfi !== 'string') return sendJson(res, 400, { ok: false, error: '缺少有效的 CFI' })
        const progressSections = await library.sections(bookId)
        // The client reports the anchor it is looking at; `positionSectionIndex`
        // is what older builds sent and is still honoured as a chapter number.
        const byAnchor = resolveChapterFromHref(progressSections, body.href, body.spineIndex)
        const reportedChapter =
          typeof body.chapterIndex === 'number'
            ? body.chapterIndex
            : typeof body.sectionIndex === 'number'
              ? body.sectionIndex
              : byAnchor ?? (typeof body.positionSectionIndex === 'number' ? body.positionSectionIndex : null)
        const saved = await library.saveProgress(bookId, {
          cfi: String(body.cfi),
          positionSectionIndex: reportedChapter ?? undefined,
          chapterTitle: typeof body.chapterTitle === 'string' ? body.chapterTitle : undefined,
          sectionCount: typeof body.sectionCount === 'number' ? body.sectionCount : undefined,
        })
        state.lastSelection = null
        // Fire-and-forget: the reader must never wait for a summary.
        void summaries.ensure(bookId, saved)
        return sendJson(res, 200, { ok: true, progress: saved })
      }

      if (method === 'POST' && path === '/selection') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const progress = await library.progress(bookId)
        // A selection carries a chapter number from the reader (it knows the
        // table-of-contents entry exactly) and a CFI for the text itself.
        const sections = await library.sections(bookId)
        const chapter =
          resolveChapterFromHref(sections, body?.href, body?.spineIndex) ??
          resolveChapterIndex(sections, {
            cfi: body?.cfi ?? null,
            sectionIndex: typeof body?.chapterIndex === 'number' ? body.chapterIndex : null,
          })
        const gate = requireReadable({ sectionIndex: chapter }, progress, {
          what: '记录选中段落',
        })
        state.lastSelection = {
          cfi: typeof body?.cfi === 'string' ? body.cfi : null,
          sectionIndex: chapter,
          quote: typeof body?.quote === 'string' ? body.quote.slice(0, 2000) : null,
          at: new Date().toISOString(),
        }
        return sendJson(res, 200, { ok: true, gate })
      }

      // ---- notes (no model involved) ---------------------------------------
      if (method === 'POST' && path === '/note') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const progress = await library.progress(bookId)
        const noteSections = await library.sections(bookId)
        const noteChapter =
          resolveChapterFromHref(noteSections, body?.href, body?.spineIndex) ??
          resolveChapterIndex(noteSections, {
            cfi: body?.cfi ?? null,
            sectionIndex: typeof body?.chapterIndex === 'number' ? body.chapterIndex : null,
          })
        requireReadable({ sectionIndex: noteChapter }, progress, {
          what: '存下划线',
        })
        const note = await library.addNote(bookId, {
          cfi: typeof body?.cfi === 'string' ? body.cfi : null,
          sectionIndex: noteChapter ?? 0,
          quote: typeof body?.quote === 'string' ? body.quote : '',
          comment: typeof body?.comment === 'string' ? body.comment : '',
        })
        return sendJson(res, 200, { ok: true, note })
      }

      if (method === 'GET' && path === '/notes') {
        const notes = await library.notes(String(url.searchParams.get('bookId') ?? state.activeBookId ?? ''))
        return sendJson(res, 200, { ok: true, notes })
      }

      // ---- discussion ------------------------------------------------------
      if (method === 'POST' && path === '/ask') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const meta = await library.meta(bookId)
        if (!meta) return sendJson(res, 404, { ok: false, error: '还没有打开任何书' })
        const progress = await library.progress(bookId)
        const question = String(body?.question ?? '').slice(0, 4000)
        const selection = {
          cfi: typeof body?.cfi === 'string' ? body.cfi : null,
          quote: typeof body?.quote === 'string' ? body.quote : null,
        }
        const askSections = await library.sections(bookId)
        const askedChapter =
          typeof body?.chapterIndex === 'number'
            ? body.chapterIndex
            : typeof body?.sectionIndex === 'number'
              ? body.sectionIndex // an explicit chapter number, as the tools take it
              : resolveChapterFromHref(askSections, body?.href, body?.spineIndex)
        // No selection (just "ask about where I am") is a normal case: the UI says
        // 不划线也可以问已读过的内容. Center the window on the reader's current chapter
        // instead of on nothing — an empty target would fail closed and look like a bug.
        const anchored = Boolean(selection.cfi) || askedChapter !== null
        const askChapter = anchored
          ? (askedChapter ?? resolveChapterIndex(askSections, { cfi: selection.cfi }))
          : (progress?.positionSectionIndex ?? 0)
        // Hard gate BEFORE any text is assembled: an unread anchor is refused here.
        // It runs before the model-route check on purpose — the refusal must not
        // depend on whether a model happens to be available.
        requireReadable({ sectionIndex: askChapter }, progress, { what: '就这段原文讨论' })

        const route = resolveRoute(ctx, config, null)
        if (!route) return sendJson(res, 503, { ok: false, error: '这个会话没有可用的模型路由，暂时无法对话。复习和笔记不受影响。' })

        const window = await selectionWindow(library, bookId, progress, {
          cfi: anchored ? selection.cfi : null,
          sectionIndex: askChapter,
          quote: anchored ? selection.quote : null,
          before: config.windowChars ?? 300,
          after: config.windowChars ?? 300,
        }).catch((error) => {
          if (error?.name === 'SpoilerGateError') throw error
          return null
        })
        const index = await summaryIndexText(library, bookId, progress)
        const hits = await retrieveRead(library, cache, bookId, progress, question || window?.text?.slice(0, 300) || '', { limit: 3 })
        const system = singleTurnSystem({
          progressLine: progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }),
          summaryIndex: index,
          window: window ? `第 ${window.sectionIndex + 1} 章${window.title ? `「${window.title}」` : ''}\n${window.text}` : null,
          retrieval: retrievalText(hits),
        })
        const answer = await streamText(ctx, {
          provider: route.provider,
          model: route.model,
          system,
          prompt: question || '我想就这段文字聊聊。',
          maxTokens: 1600,
          temperature: 0.6,
          signal: undefined,
        })
        return sendJson(res, 200, { ok: true, reply: answer, usedWindow: Boolean(window), sections: { window: window?.sectionIndex ?? null, retrieved: hits.map((hit) => hit.sectionIndex) } })
      }

      // ---- 本章收口 --------------------------------------------------------
      if (method === 'POST' && path === '/closing') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const meta = await library.meta(bookId)
        if (!meta) return sendJson(res, 404, { ok: false, error: '还没有打开任何书' })
        const progress = await library.progress(bookId)
        const sectionIndex = typeof body?.sectionIndex === 'number' ? body.sectionIndex : (progress?.positionSectionIndex ?? 0)
        requireReadable({ sectionIndex }, progress, { what: '对本章做收口' })

        const all = await library.takeaways(bookId)
        const mine = all.filter((item) => (item.chapterIndex ?? 0) === sectionIndex)
        if (mine.length === 0) {
          return sendJson(res, 400, { ok: false, error: '这一章还没有收获可以收口。先就这一章聊几句，或者在对话里把某句存成收获。' })
        }
        const chapterTitle = meta.sections?.[sectionIndex]?.title ?? progress?.chapterTitle ?? null
        const fallback = mine.map((item) => `· [${item.type}] ${item.aiSummary}`).join('\n')

        const route = resolveRoute(ctx, config, null)
        if (!route) {
          // Review and notes do not depend on a model; neither does a plain list.
          return sendJson(res, 200, { ok: true, text: `这一章你存了 ${mine.length} 条收获：\n${fallback}`, modelFree: true })
        }
        try {
          const text = await streamText(ctx, {
            provider: route.provider,
            model: route.model,
            system: closingSystem({
              progressLine: progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }),
              chapterTitle,
              takeaways: mine,
            }),
            prompt: '把这一章的讨论收个口。',
            maxTokens: 1200,
            temperature: 0.5,
          })
          return sendJson(res, 200, { ok: true, text })
        } catch (error) {
          return sendJson(res, 200, { ok: true, text: `这一章你存了 ${mine.length} 条收获：\n${fallback}`, modelFree: true, warning: String(error?.message ?? error) })
        }
      }

      // ---- takeaways + review ---------------------------------------------
      if (method === 'GET' && path === '/takeaways') {
        const bookId = String(url.searchParams.get('bookId') ?? state.activeBookId ?? '')
        const items = await library.takeaways(bookId)
        return sendJson(res, 200, { ok: true, takeaways: items })
      }

      if (method === 'POST' && path === '/takeaway') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const progress = await library.progress(bookId)
        // The anchor must agree with the chapter number, but they are no longer
        // the same number: a CFI lands in a spine document, which now holds
        // several chapters. They agree when the document contains the chapter.
        const takeawaySections = await library.sections(bookId)
        const claimed = typeof body?.chapterIndex === 'number' ? body.chapterIndex : typeof body?.sectionIndex === 'number' ? body.sectionIndex : null
        const fromCfiDoc = isCfi(body?.cfi) ? spineIndexOf(body.cfi) : null
        if (fromCfiDoc !== null && claimed !== null) {
          const inside = chaptersInDoc(takeawaySections, fromCfiDoc)
          if (inside.length > 0 && !inside.some((item) => item.index === claimed)) {
            return sendJson(res, 400, {
              ok: false,
              error: `锚点和章节号对不上：这个 CFI 落在第 ${inside[0].index + 1}–${inside[inside.length - 1].index + 1} 章所在的正文段里，参数写的是第 ${claimed + 1} 章。`,
            })
          }
        }
        const sectionIndex =
          claimed ?? resolveChapterIndex(takeawaySections, { cfi: body?.cfi ?? null }) ?? (progress?.positionSectionIndex ?? 0)
        requireReadable({ sectionIndex }, progress, { what: '记录收获' })
        const takeawayChapter = takeawaySections.find((item) => item.index === sectionIndex)
        const record = await library.addTakeaway(bookId, {
          type: String(body?.type ?? '理解'),
          cfi: isCfi(body?.cfi) ? body.cfi : buildCfi(takeawayChapter?.docIndex ?? 0),
          chapterIndex: sectionIndex,
          userQuote: typeof body?.userQuote === 'string' && body.userQuote.length > 0 ? body.userQuote.slice(0, 1000) : null,
          aiSummary: String(body?.aiSummary ?? '').slice(0, 1000),
        })
        const cards = await library.addCards(bookId, deriveCards(record))
        return sendJson(res, 200, { ok: true, takeaway: record, cards })
      }

      if (method === 'GET' && path === '/cards') {
        const bookId = String(url.searchParams.get('bookId') ?? state.activeBookId ?? '')
        return sendJson(res, 200, { ok: true, cards: await cardState(bookId) })
      }

      // ---- model-assisted review, on request only ---------------------------
      // Review itself never needs a model. These three rewrites run only when the
      // reader presses a button, and they work from the reader's own takeaway —
      // never from source text — so they cannot widen what the reader has read.
      if (method === 'POST' && path === '/rephrase') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        if (!(await library.meta(bookId))) return sendJson(res, 404, { ok: false, error: '还没有打开任何书' })
        const cards = await library.cards(bookId)
        const card = cards.find((item) => (item.cardId ?? item.id) === body?.cardId)
        if (!card) return sendJson(res, 404, { ok: false, error: '没有这张卡片' })
        const mode = ['rephrase', 'split', 'compare'].includes(body?.mode) ? body.mode : 'rephrase'
        const other = cards.find((item) => (item.cardId ?? item.id) !== (card.cardId ?? card.id))
        const task =
          mode === 'split'
            ? '把这个问题拆成两个更小、能一步步回答的问题，每个一行，不要解释为什么要拆。'
            : mode === 'compare'
              ? `把它和另一张卡片放在一起问：另一张卡片是「${other?.front ?? '（这本书只有这一张卡片）'}」。用一句话问出这两张卡片之间的联系，不要给答案。`
              : '换一种更具体、更口语的问法重问一次。只输出这一个问题。'
        const route = resolveRoute(ctx, config, null)
        if (!route) {
          return sendJson(res, 200, { ok: true, text: '', modelFree: true, note: '这个会话没有可用的模型路由。复习本身不需要模型，卡片照常可以翻。' })
        }
        try {
          const text = await streamText(ctx, {
            provider: route.provider,
            model: route.model,
            system: `你在帮读者复习他自己记下的收获。只改写提问，不要给答案、不要引入书里他没读到的内容。\n读者当时的笔记：「${clip(card.back, 400)}」`,
            prompt: `这张卡片正面是：「${card.front}」\n${task}`,
            maxTokens: 900,
          })
          return sendJson(res, 200, { ok: true, text: clip(text, 500), mode })
        } catch (error) {
          return sendJson(res, 200, { ok: true, text: '', modelFree: true, note: `模型这一步没成功（${clip(String(error?.message ?? error), 120)}），卡片本身不受影响。` })
        }
      }

      if (method === 'POST' && path === '/review') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        const cards = await library.cards(bookId)
        const card = cards.find((item) => (item.cardId ?? item.id) === body?.cardId)
        if (!card) return sendJson(res, 404, { ok: false, error: '没有这张卡片' })
        const outcome = String(body?.outcome ?? 'settled')
        const quality = outcome === 'got' ? 5 : outcome === 'reread' ? 3 : 4
        await library.addReview(bookId, { cardId: card.cardId ?? card.id, quality, outcome })
        return sendJson(res, 200, { ok: true, cards: await cardState(bookId) })
      }

      if (method === 'POST' && path === '/summaries') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const bookId = String(body?.bookId ?? state.activeBookId ?? '')
        if (!(await library.meta(bookId))) return sendJson(res, 404, { ok: false, error: '还没有打开任何书' })
        const progress = await library.progress(bookId)
        void summaries.ensure(bookId, progress)
        return sendJson(res, 200, { ok: true, status: await summaries.status(bookId) })
      }

      return sendJson(res, 404, { ok: false, error: `未知的接口：${method} ${path}` })
    } catch (error) {
      const message = error?.name === 'SpoilerGateError' ? `拒绝：${error.message}` : String(error?.message ?? error)
      const status = error?.name === 'SpoilerGateError' ? 403 : 500
      try {
        sendJson(res, status, { ok: false, error: message, code: error?.code ?? null })
      } catch {
        // response already gone
      }
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return { dispose, handler }
}
