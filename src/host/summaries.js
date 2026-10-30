/**
 * Lazy per-chapter summaries.
 *
 * One cheap call per chapter, started only when the reader has actually reached
 * that chapter, and never for a chapter ahead of the progress coordinate. The
 * result is appended to `summaries.jsonl`; a missing summary is a normal state
 * (the model is told to read the chapter with a tool instead), never an error.
 */

import { clip } from '../shared/retrieval.js'
import { summaryCeiling } from '../shared/spoiler.js'
import { resolveRoute, streamText } from './model.js'

const SUMMARY_SYSTEM = `你为一本正在被阅读的书做章节摘要索引。只根据给你的这一章原文写，不补充、不推测、不评价。
要求：不超过 120 个字；写清这一章"发生了什么、读者此刻知道什么"；不写伏笔、不写"接下来"，不评价好坏。`

/** @param {string} text */
function normalizeSummary(text) {
  const collapsed = String(text ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  const clipped = collapsed.length > 140 ? `${collapsed.slice(0, 138)}…` : collapsed
  return clipped
}

/**
 * @param {{
 *   ctx: any,
 *   library: import('./books.js').Library,
 *   config: any,
 * }} deps
 */
export function createSummaries(deps) {
  const { ctx, library, config } = deps
  /** @type {Set<string>} */
  const inflight = new Set()
  /** @type {Map<string, string>} */
  const lastError = new Map()
  let chain = Promise.resolve()

  /**
   * Generate one chapter summary. Callers must have checked the ceiling.
   * @param {string} bookId
   * @param {number} sectionIndex
   * @param {{ provider?: string, model?: string } | null} [preferred]
   */
  async function generateOne(bookId, sectionIndex, preferred = null) {
    const route = resolveRoute(ctx, config, preferred)
    if (!route) throw new Error('没有可用的模型路由，无法生成章节摘要')
    const sections = await library.sections(bookId)
    const section = sections.find((item) => item.index === sectionIndex)
    if (!section) throw new Error(`第 ${sectionIndex + 1} 章不存在`)
    const body = clip(section.text, 8000)
    const summary = normalizeSummary(
      await streamText(ctx, {
        provider: route.provider,
        model: route.model,
        system: SUMMARY_SYSTEM,
        prompt: `第 ${sectionIndex + 1} 章${section.title ? `「${section.title}」` : ''}原文：\n\n${body}\n\n请写这一章的摘要。`,
        maxTokens: 1200,
        temperature: 0.2,
      }),
    )
    if (!summary) throw new Error('模型没有返回摘要内容')
    await library.saveSummary(bookId, sectionIndex, { summary, title: section.title, model: route.model })
    return summary
  }

  /**
   * Bring the summary index up to the reader's chapter, in the background.
   * Never blocks a turn and never runs past the ceiling it was given.
   *
   * @param {string} bookId
   * @param {any} progress
   * @param {{ provider?: string, model?: string } | null} [preferred]
   */
  function ensure(bookId, progress, preferred = null) {
    const ceiling = summaryCeiling(progress)
    if (ceiling < 0) return Promise.resolve([])
    chain = chain
      .then(async () => {
        const existing = await library.summaries(bookId)
        for (let index = 0; index <= ceiling; index += 1) {
          if (existing.has(index)) continue
          const key = `${bookId}:${index}`
          if (inflight.has(key)) continue
          inflight.add(key)
          try {
            await generateOne(bookId, index, preferred)
            lastError.delete(key)
          } catch (error) {
            lastError.set(key, String(error?.message ?? error))
            // One failing chapter must not stop the rest of the index.
          } finally {
            inflight.delete(key)
          }
        }
        return []
      })
      .catch(() => [])
    return chain
  }

  /** @param {string} bookId */
  async function status(bookId) {
    const existing = await library.summaries(bookId)
    return {
      done: [...existing.keys()].sort((a, b) => a - b),
      pending: [...inflight].filter((key) => key.startsWith(`${bookId}:`)).map((key) => Number(key.split(':')[1])),
      errors: [...lastError.entries()].filter(([key]) => key.startsWith(`${bookId}:`)).map(([, message]) => message),
    }
  }

  return { ensure, generateOne, status }
}
