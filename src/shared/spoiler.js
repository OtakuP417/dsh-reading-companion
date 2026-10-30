/**
 * The spoiler gate — the load-bearing safety rule of this plugin.
 *
 * "不是靠提示词祈祷模型守规矩，而是在函数入口拒绝": every read path into a book
 * (retrieval, tool call, chapter-summary lookup) goes through `gateTarget` or
 * `filterReadable` BEFORE it touches any text. The functions are pure, so the
 * rule can be unit-tested without a DSH host, and they fail closed: a target we
 * cannot attribute to a chapter is denied, never allowed "just in case".
 *
 * The single coordinate is `progress.sectionIndex` — the spine index of the
 * paragraph the reader last saw. Nothing else is trusted.
 */

import { spineIndexOf, tryParseCfi } from './cfi.js'

/** @typedef {{ cfi?: string | null, sectionIndex?: number | null }} GateTarget */
/** @typedef {{ sectionIndex: number, cfi?: string | null, chapterTitle?: string | null }} Progress */

export const GATE_CODES = /** @type {const} */ ({
  allowed: 'allowed',
  noProgress: 'no-progress',
  unknownTarget: 'unknown-target',
  unread: 'unread',
  disabled: 'disabled',
})

/**
 * @typedef {Object} GateDecision
 * @property {boolean} allowed
 * @property {'allowed'|'no-progress'|'unknown-target'|'unread'|'disabled'} code
 * @property {number | null} sectionIndex
 * @property {number | null} readThrough
 * @property {string} reason              human/model readable, never contains unread text
 */

/**
 * @param {number | null} sectionIndex
 * @param {number | null} readThrough
 * @param {GateDecision['code']} code
 * @param {string} reason
 * @returns {GateDecision}
 */
function decision(sectionIndex, readThrough, code, reason) {
  return { allowed: code === GATE_CODES.allowed, code, sectionIndex, readThrough, reason }
}

/**
 * Resolve the chapter a target points at: an explicit `sectionIndex` wins, a
 * CFI is parsed when there is none.
 * @param {GateTarget} target
 * @returns {number | null}
 */
export function resolveSectionIndex(target) {
  if (target === null || target === undefined) return null
  const explicit =
    typeof target.sectionIndex === 'number' && Number.isInteger(target.sectionIndex) && target.sectionIndex >= 0
      ? target.sectionIndex
      : null
  const anchored = typeof target.cfi === 'string' && target.cfi.length > 0 ? spineIndexOf(target.cfi) : null
  // The CFI is the coordinate, so it wins when both are present. A chapter
  // number that contradicts the anchor means the caller is confused about which
  // position it is asking for; answering either one would be a guess, and a
  // guess on the wrong side of the boundary is exactly the leak this gate
  // exists to prevent. Fail closed instead.
  if (anchored !== null) {
    if (explicit !== null && explicit !== anchored) return null
    return anchored
  }
  return explicit
}

/**
 * May the reader's context read text at `target`?
 *
 * @param {GateTarget} target
 * @param {Progress | null | undefined} progress
 * @param {{ enabled?: boolean, allowAtBoundary?: boolean }} [options]
 *        `enabled:false` is the escape hatch for the review/cards layer, which
 *        only reads the reader's own takeaways (no book text at all).
 *        `allowAtBoundary` (default true) keeps the current chapter readable —
 *        the reader is in it, so discussing it cannot spoil anything ahead.
 * @returns {GateDecision}
 */
export function gateTarget(target, progress, options = {}) {
  if (options.enabled === false) {
    return decision(resolveSectionIndex(target ?? {}), null, GATE_CODES.disabled, '进度门已关闭（仅限不读取原文的环节）')
  }
  const readThrough =
    progress && typeof progress.sectionIndex === 'number' && Number.isInteger(progress.sectionIndex)
      ? progress.sectionIndex
      : null
  if (readThrough === null) {
    return decision(
      resolveSectionIndex(target ?? {}),
      null,
      GATE_CODES.noProgress,
      '这本书还没有可靠的进度记录，因此没有任何一章可以当作“已读”。先让读者打开书、翻到自己的位置。',
    )
  }
  const sectionIndex = resolveSectionIndex(target ?? {})
  if (sectionIndex === null) {
    return decision(
      null,
      readThrough,
      GATE_CODES.unknownTarget,
      `无法把这个位置归属到某一章（进度：第 ${readThrough + 1} 章）。拒绝访问。`,
    )
  }
  const limit = options.allowAtBoundary === false ? readThrough - 1 : readThrough
  if (sectionIndex > limit) {
    return decision(
      sectionIndex,
      readThrough,
      GATE_CODES.unread,
      `第 ${sectionIndex + 1} 章在读者进度（第 ${readThrough + 1} 章）之后，未读原文与未读摘要都不在可取范围内。`,
    )
  }
  return decision(sectionIndex, readThrough, GATE_CODES.allowed, '在读范围内')
}

/**
 * Convenience wrapper that throws a typed error — call it at the entry of any
 * function that is about to read book text.
 * @param {GateTarget} target
 * @param {Progress | null | undefined} progress
 * @param {{ enabled?: boolean, allowAtBoundary?: boolean, what?: string }} [options]
 * @returns {GateDecision}
 */
export function requireReadable(target, progress, options = {}) {
  const result = gateTarget(target, progress, options)
  if (!result.allowed) {
    const error = new Error(`${options.what ?? '读取原文'}被进度门拒绝：${result.reason}`)
    error.name = 'SpoilerGateError'
    // @ts-expect-error augmenting a standard Error
    error.code = result.code
    // @ts-expect-error augmenting a standard Error
    error.gate = result
    throw error
  }
  return result
}

/**
 * Filter a chunk list down to the readable range. The filter lives HERE and is
 * called from inside the retrieval entry point, so a later refactor cannot
 * forget it: candidates outside the progress coordinate never reach the scorer.
 *
 * @template {{ sectionIndex: number }} T
 * @param {T[]} chunks
 * @param {Progress | null | undefined} progress
 * @param {{ allowAtBoundary?: boolean }} [options]
 * @returns {T[]}
 */
export function filterReadable(chunks, progress, options = {}) {
  const readThrough = progress?.sectionIndex
  if (typeof readThrough !== 'number' || !Number.isInteger(readThrough)) return []
  const limit = options.allowAtBoundary === false ? readThrough - 1 : readThrough
  return chunks.filter((chunk) => typeof chunk.sectionIndex === 'number' && chunk.sectionIndex <= limit)
}

/**
 * The highest chapter index that may be summarised: the reader's chapter.
 * Summaries of later chapters must not exist at all ("想剧透也没材料").
 * @param {Progress | null | undefined} progress
 * @returns {number} -1 when there is no progress
 */
export function summaryCeiling(progress) {
  const readThrough = progress?.sectionIndex
  if (typeof readThrough !== 'number' || !Number.isInteger(readThrough)) return -1
  return readThrough
}

/**
 * Does this CFI sit inside the readable range?
 * @param {string} cfi
 * @param {Progress | null | undefined} progress
 * @returns {boolean}
 */
export function isCfiReadable(cfi, progress) {
  const parsed = tryParseCfi(cfi)
  if (parsed === null) return false
  return gateTarget({ cfi }, progress).allowed
}

/**
 * Compact, model-facing statement of the boundary. Injected into the system
 * prompt so the model knows exactly where "now" is (and that the map of the
 * book ends there).
 * @param {Progress | null | undefined} progress
 * @param {{ chapterTitle?: string | null, bookTitle?: string | null, sectionCount?: number | null }} [extra]
 * @returns {string}
 */
export function describeProgress(progress, extra = {}) {
  const readThrough = progress?.sectionIndex
  if (typeof readThrough !== 'number' || !Number.isInteger(readThrough)) {
    return '读者尚未给出进度：这本书没有任何一章处于“已读”状态，先邀请读者打开书、翻到自己的位置。'
  }
  const book = extra.bookTitle ? `《${extra.bookTitle}》` : '本书'
  const position = progress?.positionSectionIndex
  const sameSpot = typeof position !== 'number' ? true : position === readThrough
  // The ceiling is a high-water mark, so its chapter is not necessarily the
  // chapter the reader is looking at. Naming the position's title as the
  // ceiling's produces the absurd "已读到第 4 章「第二章 旧账」".
  const ceilingTitle =
    (typeof progress?.ceilingTitle === 'string' && progress.ceilingTitle.length > 0 ? progress.ceilingTitle : null) ??
    (sameSpot ? (progress?.chapterTitle ?? extra.chapterTitle ?? null) : null)
  const total = extra.sectionCount
  const where = ceilingTitle ? `第 ${readThrough + 1} 章「${ceilingTitle}」` : `第 ${readThrough + 1} 章`
  const tail = total ? `（全书 ${total} 章）` : ''
  const now =
    !sameSpot && typeof position === 'number'
      ? `，现在停在第 ${position + 1} 章${progress?.chapterTitle ? `「${progress.chapterTitle}」` : ''}`
      : ''
  return `${book}${tail}：读者已读到${where}${now}。可取范围 = 第 1 章至第 ${readThrough + 1} 章；此后各章的原文与摘要都不存在于你的上下文里。`
}
