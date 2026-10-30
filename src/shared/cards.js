/**
 * Card generation — pure rules, no model.
 *
 * The requirement is explicit: the base layer of review must not depend on a
 * model being available. So a takeaway (which the reader produced by reading
 * and discussing) is turned into cards by deterministic rules keyed on its
 * `type`, and every card keeps the CFI of the paragraph it came from so the
 * back side can jump straight there. A model may later *rephrase* a card, but
 * cards exist without it.
 *
 * Card shape (front = a question/one idea, back = anchor + the reader's own
 * discussion summary):
 *   { id, takeawayId, front, back, cfi, chapterIndex, kind, createdAt }
 */

import { splitSentences, clip } from './retrieval.js'

export const TAKEAWAY_TYPES = /** @type {const} */ (['理解', '疑问', '联想', '评价'])

/** Deterministic and idempotent: re-deriving a takeaway yields the same ids. */
const MAX_CARDS = 3

/**
 * @typedef {Object} Takeaway
 * @property {string} id
 * @property {'理解'|'疑问'|'联想'|'评价'} type
 * @property {string} cfi
 * @property {number} chapterIndex
 * @property {string | null} [userQuote]
 * @property {string} aiSummary
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Card
 * @property {string} id
 * @property {string} takeawayId
 * @property {string} front
 * @property {string} back
 * @property {string} cfi
 * @property {number} chapterIndex
 * @property {string} kind
 * @property {number} createdAt
 */

/**
 * Pick the "one idea" a card should test: the first clause of the summary,
 * shortened at a natural boundary when possible.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function coreOf(text, max = 46) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const head = collapsed.slice(0, max)
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('。'), head.lastIndexOf('、'))
  return (cut > max * 0.4 ? head.slice(0, cut) : head) + '…'
}

/**
 * @param {Takeaway} takeaway
 * @returns {Card[]}
 */
export function deriveCards(takeaway) {
  const summary = (takeaway.aiSummary ?? '').trim()
  if (summary.length === 0) return []
  const quote = (takeaway.userQuote ?? '').trim()
  const core = coreOf(summary)
  const base = {
    takeawayId: takeaway.id,
    cfi: takeaway.cfi,
    chapterIndex: takeaway.chapterIndex,
    createdAt: takeaway.createdAt,
  }
  /** @type {Card[]} */
  const cards = []
  const add = (/** @type {string} */ kind, /** @type {string} */ front, /** @type {string} */ back) => {
    if (cards.length >= MAX_CARDS) return
    cards.push({
      id: `${takeaway.id}:${cards.length + 1}`,
      ...base,
      front,
      back,
      kind,
    })
  }

  switch (takeaway.type) {
    case '理解':
      add('recall', `不看书，把这点讲清楚：${core}`, summary)
      break
    case '疑问':
      // The reader's own question has to be on the front, not just the sentence
      // that made him ask it: several takeaways can share one quote, and then a
      // quote-only front would read as the same card three times over.
      add(
        'question',
        quote.length > 0 ? `「${clip(quote, 28)}」——${core}` : `你当时的疑问：${core}`,
        summary,
      )
      break
    case '联想':
      add('connect', `「${core}」让你想到了什么？`, summary)
      break
    case '评价':
      add('judge', `你当时的判断是：${core} —— 现在还是这个判断吗？`, summary)
      break
    default:
      add('recall', core, summary)
  }

  // A long summary carries more than one idea: split the rest into extra
  // cards, but never more than MAX_CARDS in total.
  const sentences = splitSentences(summary).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0)
  for (let i = 1; i < sentences.length && cards.length < MAX_CARDS; i++) {
    const sentence = sentences[i]
    if (sentence.length < 12) continue
    add('detail', `这一点你怎么理解：${coreOf(sentence)}`, `${summary}\n\n（出自本次讨论的第 ${i + 1} 句）`)
  }
  return cards
}

/**
 * Stable id for a takeaway — derived from its content so re-closing the same
 * discussion does not duplicate the log (append-only, but not append-junk).
 * @param {{ type: string, cfi: string, aiSummary: string, createdAt: number }} input
 * @returns {string}
 */
export function takeawayId(input) {
  let hash = 2166136261
  const material = `${input.type}\u0000${input.cfi}\u0000${input.aiSummary}\u0000${Math.floor(input.createdAt / 60000)}`
  for (let i = 0; i < material.length; i++) {
    hash ^= material.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `t${(hash >>> 0).toString(36)}`
}

/**
 * Is this a well-formed takeaway? Used to vet model output before it is stored.
 * @param {unknown} value
 * @returns {value is Takeaway}
 */
export function isTakeaway(value) {
  if (value === null || typeof value !== 'object') return false
  const candidate = /** @type {Record<string, unknown>} */ (value)
  return (
    typeof candidate.type === 'string' &&
    TAKEAWAY_TYPES.includes(/** @type {'理解'} */ (candidate.type)) &&
    typeof candidate.cfi === 'string' &&
    candidate.cfi.startsWith('epubcfi(') &&
    typeof candidate.aiSummary === 'string' &&
    candidate.aiSummary.trim().length > 0 &&
    typeof candidate.chapterIndex === 'number'
  )
}
