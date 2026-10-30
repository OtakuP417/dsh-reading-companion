/**
 * Spaced-repetition scheduling.
 *
 * The algorithm is NOT written here: it is the vendored SuperMemo-2
 * implementation (`vendor/supermemo2/sm2.js`, MIT, (c) 2016 Niven Su). This
 * module only adapts it to the plugin's data model:
 *
 *   review log (append-only)  ──replay──▶  scheduling state  ──▶  due queue
 *
 * Keeping the state *derived* is what lets the store stay append-only ("只增不减"):
 * nothing is ever mutated in place, the schedule is recomputed from events.
 * No model is involved at any point — review keeps working with every model
 * call disabled, which is a hard requirement for this layer.
 */

import sm2 from '../../vendor/supermemo2/sm2.js'

export const QUALITY = /** @type {const} */ ({
  /** "还要再想想" — the reader wants this takeaway again soon. */
  rethink: 3,
  /** "先放着" — seen, keep it in rotation. */
  settled: 4,
  /** "已经想明白了" — push it far out. */
  got: 5,
})

/** A brand-new card is due immediately. */
export const INITIAL_STATE = /** @type {const} */ ({
  interval: 0,
  factor: 2.5,
  repetitions: 0,
  dueAt: 0,
})

const DAY = 24 * 60 * 60 * 1000
const RETIRE_AFTER_DAYS = 3650

/**
 * @typedef {Object} CardState
 * @property {number} interval   days
 * @property {number} factor     SM-2 easiness factor
 * @property {number} repetitions successful reviews so far
 * @property {number} dueAt      epoch ms
 * @property {boolean} [retired]
 */

/**
 * Apply one review event with the vendored SM-2 implementation.
 *
 * @param {CardState} state
 * @param {number} quality 0..5 (see QUALITY)
 * @param {number} [now] epoch ms
 * @returns {CardState}
 */
export function applyReview(state, quality, now = Date.now()) {
  const current = state ?? INITIAL_STATE
  if (current.retired) return current
  const clamped = Math.max(0, Math.min(5, Math.round(quality)))
  const result = sm2(clamped, current.interval === 0 ? null : current.interval, current.factor)
  const interval = Math.max(1, Math.round(result.schedule))
  return {
    interval,
    factor: result.factor,
    repetitions: clamped < 3 ? 0 : (current.repetitions ?? 0) + 1,
    dueAt: now + interval * DAY,
  }
}

/**
 * Mark a card as retired ("不用再提") — it stays in the log, it just stops
 * being scheduled. Append-only: this is an event, not a deletion.
 * @param {CardState} state
 * @returns {CardState}
 */
export function retire(state, now = Date.now()) {
  return {
    ...(state ?? INITIAL_STATE),
    retired: true,
    dueAt: now + RETIRE_AFTER_DAYS * DAY,
  }
}

/**
 * Replay a review log into a schedule state.
 * Events: `{ at, quality }` for a review, `{ at, action: 'retire' }` for retirement,
 * `{ at, action: 'initial' }` ignored (implicit). `at` may be epoch ms or an ISO
 * string — the store writes ISO timestamps, so it must be normalised here.
 *
 * @param {{ at: number | string, quality?: number, action?: string }[]} events
 * @returns {CardState}
 */
export function replay(events) {
  /** @type {CardState} */
  let state = { ...INITIAL_STATE, dueAt: 0 }
  const normalized = (events ?? []).map((event) => ({ ...event, at: toEpoch(event.at) }))
  const sorted = normalized.sort((a, b) => a.at - b.at)
  for (const event of sorted) {
    if (event.action === 'retire') {
      state = retire(state, event.at)
      continue
    }
    if (typeof event.quality === 'number') {
      state = applyReview(state, event.quality, event.at)
    }
  }
  return state
}

/** @param {number | string | undefined} value @returns {number} */
function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/**
 * Cards whose `dueAt` has passed, oldest first. Retired cards never surface.
 * @param {{ id: string, state: CardState }[]} cards
 * @param {number} now
 * @param {{ limit?: number }} [options]
 * @returns {{ id: string, state: CardState }[]}
 */
export function dueCards(cards, now = Date.now(), options = {}) {
  const limit = options.limit ?? 20
  return cards
    .filter((card) => !card.state?.retired && card.state.dueAt <= now)
    .sort((a, b) => a.state.dueAt - b.state.dueAt)
    .slice(0, limit)
}

/**
 * Human-facing next-due description (used by the client and the model).
 * @param {CardState} state
 * @param {number} [now]
 * @returns {string}
 */
export function describeDue(state, now = Date.now()) {
  if (!state) return '未安排'
  if (state.retired) return '已收起'
  const delta = state.dueAt - now
  if (delta <= 0) return '现在可以回顾'
  const days = Math.round(delta / DAY)
  if (days <= 1) return '明天'
  if (days < 30) return `${days} 天后`
  return `${Math.round(days / 30)} 个月后`
}
