/**
 * Model-facing tools.
 *
 * These are the only ways book text becomes visible to a conversation, and each
 * one calls the spoiler gate at its own entry before it reads anything. The gate
 * is not consulted by a dispatcher above them: a tool that forgets it would be a
 * bug here, visible in one file, instead of a policy somewhere else.
 */

import { buildCfi, tryParseCfi } from '../shared/cfi.js'
import { requireReadable, summaryCeiling } from '../shared/spoiler.js'
import { clip } from '../shared/retrieval.js'
import { describeDue, replay, QUALITY } from '../shared/scheduler.js'
import { deriveCards, isTakeaway, takeawayId, TAKEAWAY_TYPES } from '../shared/cards.js'
import { progressLine, retrieveRead, retrievalText, selectionWindow, summaryIndexText } from './context.js'

const TEXT = (text) => [{ type: 'text', text }]

/** A tool result is always a rendered string: one shape to reason about. */
const stringOutput = { schema: { type: 'string' }, render: (_args, value) => TEXT(String(value ?? '')) }

/**
 * Which book the conversation is about. One active book at a time — the reader
 * is reading one book — and the Client sets it when it opens one.
 * @param {import('./books.js').Library} library
 * @param {string | null} activeBookId
 */
async function pickBook(library, activeBookId, requested) {
  if (typeof requested === 'string' && requested.length > 0) {
    const meta = await library.meta(requested)
    if (!meta) throw new Error(`没有这本书：${requested}`)
    return meta
  }
  if (activeBookId) {
    const meta = await library.meta(activeBookId)
    if (meta) return meta
  }
  const books = await library.list()
  if (books.length === 0) throw new Error('书架上还没有书。请读者先在阅读面板里导入一本 EPUB。')
  return books[0]
}

/**
 * @param {{
 *   ctx: any,
 *   library: import('./books.js').Library,
 *   cache: import('./context.js').ReadIndexCache,
 *   summaries: ReturnType<import('./summaries.js').createSummaries>,
 *   config: any,
 *   state: { activeBookId: string | null, lastSelection: any | null },
 * }} deps
 */
export function registerTools(deps) {
  const { ctx, library, cache, summaries, config, state } = deps
  const disposers = []

  const progressOf = async (bookId) => library.progress(bookId)

  disposers.push(
    ctx.tools.register({
      name: 'reading_progress',
      description:
        '报告读者当前读到哪一章、哪一句，以及可取范围的上界。讨论任何原文之前先调用它确认边界。',
      parameters: {
        type: 'object',
        properties: { bookId: { type: 'string', description: '书 id，省略则用当前打开的书' } },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const lines = [progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount })]
        if (progress?.cfi) lines.push(`当前位置 CFI：${progress.cfi}`)
        if (progress?.chapterTitle) lines.push(`当前章节：${progress.chapterTitle}`)
        const status = await summaries.status(meta.id)
        const ceiling = summaryCeiling(progress)
        const missing = []
        for (let index = 0; index <= ceiling; index += 1) {
          if (!status.done.includes(index)) missing.push(index + 1)
        }
        if (missing.length > 0) lines.push(`已读范围内尚未生成摘要的章节：第 ${missing.join('、')} 章`)
        return lines.join('\n')
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'read_text_window',
      description:
        '读取读者已读范围内的真实原文（选中句前后各约 300 字）。参数可以给 cfi、sectionIndex，或只给 quote 让工具自己定位。超出读者进度的位置会被直接拒绝。',
      parameters: {
        type: 'object',
        properties: {
          cfi: { type: 'string', description: 'EPUB CFI 位置' },
          sectionIndex: { type: 'integer', description: '章节序号（从 0 开始）' },
          quote: { type: 'string', description: '读者选中的那句话，用于定位' },
          before: { type: 'integer', description: '向前取多少字，默认 300' },
          after: { type: 'integer', description: '向后取多少字，默认 300' },
        },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const target = {
          cfi: typeof args?.cfi === 'string' ? args.cfi : null,
          sectionIndex: typeof args?.sectionIndex === 'number' ? args.sectionIndex : null,
        }
        if (target.cfi === null && target.sectionIndex === null) {
          // A bare quote still needs a chapter: the reader's current one.
          const fallback = progress?.positionSectionIndex ?? progress?.sectionIndex
          if (typeof fallback !== 'number') {
            throw new Error('这本书还没有进度记录，无法定位原文。请读者先在阅读面板里翻到自己的位置。')
          }
          target.sectionIndex = fallback
        }
        requireReadable(target, progress, { what: '读取原文' })
        const window = await selectionWindow(library, meta.id, progress, {
          cfi: target.cfi,
          sectionIndex: target.sectionIndex,
          quote: typeof args?.quote === 'string' ? args.quote : null,
          before: typeof args?.before === 'number' ? Math.min(args.before, 1200) : 300,
          after: typeof args?.after === 'number' ? Math.min(args.after, 1200) : 300,
        })
        const header = `第 ${window.sectionIndex + 1} 章${window.title ? `「${window.title}」` : ''}（读者已读到此处）`
        return `${header}\n\n${window.text}`
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'search_read_text',
      description:
        '在读者已读范围内做混合检索（BM25 + 向量），返回最相关的几个原文片段。未读章节不会参与检索，也不会出现在结果里。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的内容，用读者的话原样写' },
          limit: { type: 'integer', description: '返回条目数，默认 4，最多 8' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        requireReadable({ sectionIndex: progress?.sectionIndex }, progress, { what: '检索原文' })
        const hits = await retrieveRead(library, cache, meta.id, progress, String(args?.query ?? ''), {
          limit: Math.min(Math.max(1, args?.limit ?? 4), 8),
        })
        if (hits.length === 0) return '读者已读范围内没有找到相关内容。不要用书中别处的信息补足，直接说明没找到。'
        return retrievalText(hits)
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'chapter_summary',
      description:
        '读取某一章的摘要（一句话级的章节索引）。只对读者已读到的章节有效；未读章节没有摘要，调用会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          sectionIndex: { type: 'integer', description: '章节序号（从 0 开始），省略则用读者当前章' },
        },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const target =
          typeof args?.sectionIndex === 'number' ? args.sectionIndex : (progress?.positionSectionIndex ?? progress?.sectionIndex)
        if (typeof target !== 'number') throw new Error('这本书还没有进度记录，没有可读的章节摘要。')
        requireReadable({ sectionIndex: target }, progress, { what: '读取章节摘要' })
        const summariesMap = await library.summaries(meta.id)
        const record = summariesMap.get(target)
        const section = (await library.meta(meta.id))?.sections?.[target]
        const title = record?.title ?? section?.title ?? null
        if (record?.summary) return `第 ${target + 1} 章${title ? `「${title}」` : ''}：${record.summary}`
        return `第 ${target + 1} 章的摘要还没有生成（可以稍后再试，或用 read_text_window 直接读这一章的原文）。`
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'save_takeaway',
      description:
        '把本轮讨论的收获存成一条 takeaways 记录（只增不减）。type 取 理解/疑问/联想/评价；aiSummary 写读者自己想到的东西，不要复述原文。',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...TAKEAWAY_TYPES] },
          aiSummary: { type: 'string', description: '一两句话，记录读者在这次讨论里形成的理解' },
          cfi: { type: 'string', description: '这条收获锚定的 EPUB CFI' },
          sectionIndex: { type: 'integer', description: '章节序号，省略则用读者当前章' },
          userQuote: { type: 'string', description: '读者原话或他划的那句原文，可为空' },
          scope: { type: 'string', enum: ['moment', 'chapter-closing'], description: '本章收口用 chapter-closing' },
        },
        required: ['type', 'aiSummary'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const sectionIndex =
          typeof args?.sectionIndex === 'number' ? args.sectionIndex : (progress?.positionSectionIndex ?? progress?.sectionIndex ?? 0)
        requireReadable({ sectionIndex }, progress, { what: '记录收获' })
        const cfi = typeof args?.cfi === 'string' && tryParseCfi(args.cfi) ? args.cfi : buildCfi(sectionIndex)
        /** @type {any} */
        const takeaway = {
          type: args?.type,
          cfi,
          chapterIndex: sectionIndex,
          userQuote: typeof args?.userQuote === 'string' && args.userQuote.length > 0 ? args.userQuote : null,
          aiSummary: String(args?.aiSummary ?? '').trim(),
          scope: args?.scope === 'chapter-closing' ? 'chapter-closing' : 'moment',
        }
        if (!isTakeaway(takeaway)) {
          throw new Error('这条收获不完整（type 必须是 理解/疑问/联想/评价，aiSummary 不能为空）')
        }
        const record = await library.addTakeaway(meta.id, { ...takeaway, id: takeawayId(takeaway) })
        const cards = deriveCards(record)
        const created = await library.addCards(meta.id, cards)
        return created.length > 0
          ? `已存下一条「${record.type}」收获：${record.aiSummary}\n由它派生出的复习卡片：${created.length} 张（${cards.map((card) => clip(card.front, 40)).join(' / ')}）`
          : `已存下一条「${record.type}」收获：${record.aiSummary}\n这条收获对应的复习卡片之前已经存在，没有重复建卡。`
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'list_takeaways',
      description: '列出读者已经存下的收获（可按章节过滤）。这是读者自己的记录，不涉及未读原文。',
      parameters: {
        type: 'object',
        properties: {
          chapterIndex: { type: 'integer', description: '只看这一章' },
          limit: { type: 'integer', description: '最多返回多少条，默认 20' },
        },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        let items = await library.takeaways(meta.id)
        if (typeof args?.chapterIndex === 'number') items = items.filter((item) => item.chapterIndex === args.chapterIndex)
        const limit = Math.min(Math.max(1, args?.limit ?? 20), 60)
        items = items.slice(-limit)
        if (items.length === 0) return '还没有存过任何收获。'
        return items
          .map(
            (item, index) =>
              `${index + 1}. [${item.type}] 第 ${(item.chapterIndex ?? 0) + 1} 章 ${item.aiSummary}${item.userQuote ? `（读者原话：${clip(item.userQuote, 60)}）` : ''}`,
          )
          .join('\n')
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'chapter_closing',
      description:
        '把读者在这一章里自己说过的收获汇总成"本章收口"。只读读者自己的 takeaways，不重新读原文、不重新概括这一章。',
      parameters: {
        type: 'object',
        properties: { sectionIndex: { type: 'integer', description: '章节序号，省略则用读者当前章' } },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const target =
          typeof args?.sectionIndex === 'number' ? args.sectionIndex : (progress?.positionSectionIndex ?? progress?.sectionIndex ?? 0)
        requireReadable({ sectionIndex: target }, progress, { what: '汇总本章收口' })
        const items = (await library.takeaways(meta.id)).filter((item) => item.chapterIndex === target)
        if (items.length === 0) {
          return `第 ${target + 1} 章还没有任何收获记录。请读者先聊点什么，收口只从他自己说过的东西里长出来。`
        }
        const body = items
          .map((item) => `- [${item.type}] ${item.aiSummary}${item.userQuote ? `\n  读者原话：${clip(item.userQuote, 80)}` : ''}`)
          .join('\n')
        return `第 ${target + 1} 章，读者自己的收获记录（共 ${items.length} 条）：\n${body}\n\n请用它写三到五行的"本章收口"：这是读者自己的理解路径，不要重新概括原文，也不要补他没说过的观点。`
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'review_due',
      description:
        '列出到期（或还没复习过）的复习卡片。卡片由收获自动派生，只看读者自己的记录，不读原文。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '最多几张，默认 5' } },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const cards = (await library.cards(meta.id)).map((card) => ({ ...card, cardId: card.cardId ?? card.id }))
        const reviews = await library.reviews(meta.id)
        const limit = Math.min(Math.max(1, args?.limit ?? 5), 20)
        const due = cards
          .map((card) => ({ card, state: replay(reviewsFor(reviews, card.cardId)) }))
          .filter((entry) => entry.state.dueAt <= Date.now() && !entry.state.retired)
          .slice(0, limit)
        if (due.length === 0) return '现在没有到期的卡片。'
        return due
          .map(
            (entry, index) =>
              `${index + 1}. ${entry.card.front}\n   卡片 id：${entry.card.cardId}｜第 ${(entry.card.chapterIndex ?? 0) + 1} 章｜${describeDue(entry.state)}`,
          )
          .join('\n')
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'review_card',
      description:
        '记下一次复习决定：reread（想再读一遍）、settled（已经稳了）、got（很熟）。调度用 SM-2，由代码算，不经过模型。',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: '卡片 id' },
          outcome: { type: 'string', enum: ['reread', 'settled', 'got'] },
        },
        required: ['cardId', 'outcome'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const cards = (await library.cards(meta.id)).map((item) => ({ ...item, cardId: item.cardId ?? item.id }))
        const card = cards.find((item) => item.cardId === args?.cardId)
        if (!card) throw new Error(`没有这张卡片：${args?.cardId}`)
        const quality = args?.outcome === 'got' ? QUALITY.got : args?.outcome === 'reread' ? QUALITY.rethink : QUALITY.settled
        await library.addReview(meta.id, { cardId: card.cardId, quality, outcome: args?.outcome })
        const state = replay(reviewsFor(await library.reviews(meta.id), card.cardId))
        return `已记录：${card.front}\n下次复习：${describeDue(state)}`
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'reading_context',
      description:
        '汇总当前讨论该用的上下文：读者进度、已读章节摘要索引、以及（可选的）选中段落与检索片段。默认只需要在读原文前调用一次。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '读者这次问的话，用于检索已读范围内的相关段落' },
          includeWindow: { type: 'boolean', description: '是否带上当前选中段落' },
        },
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args) {
        const meta = await pickBook(library, state.activeBookId, args?.bookId)
        const progress = await progressOf(meta.id)
        const index = await summaryIndexText(library, meta.id, progress)
        const parts = [progressLine(progress, { bookTitle: meta.title, sectionCount: meta.chapterCount }), '', index]
        if (args?.includeWindow && state.lastSelection) {
          try {
            const window = await selectionWindow(library, meta.id, progress, state.lastSelection)
            parts.push('', '【选中原文】', window.text)
          } catch (error) {
            parts.push('', '【选中原文】进度门拒绝了这个位置，因此没有注入任何原文。')
          }
        }
        if (typeof args?.question === 'string' && args.question.length > 0) {
          const hits = await retrieveRead(library, cache, meta.id, progress, args.question, { limit: 4 })
          if (hits.length > 0) parts.push('', '【已读范围内的相关段落】', retrievalText(hits))
        }
        return parts.join('\n')
      },
    }),
  )

  return { dispose: () => disposers.forEach((dispose) => dispose()) }
}

/** @param {any[]} reviews @param {string} cardId */
function reviewsFor(reviews, cardId) {
  return reviews.filter((review) => (review.cardId ?? review.id) === cardId)
}
