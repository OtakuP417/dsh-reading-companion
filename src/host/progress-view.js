/**
 * Presentation helpers for the progress coordinate.
 *
 * `progress.sectionIndex` is the read-through ceiling; `progress.positionSectionIndex`
 * is where the reader's viewport is right now. They differ whenever the reader
 * scrolls back, and the difference is exactly what the panel shows: "读到第 5 章"
 * next to "现在在第 3 章".
 */

/**
 * @param {any} progress
 * @param {any} meta
 */
export function resolvedReadthrough(progress, meta) {
  if (!progress) return null
  const sections = Array.isArray(meta?.sections) ? meta.sections : []
  const ceiling = typeof progress.sectionIndex === 'number' ? progress.sectionIndex : null
  const position = typeof progress.positionSectionIndex === 'number' ? progress.positionSectionIndex : ceiling
  const chapterCount = typeof meta?.chapterCount === 'number' ? meta.chapterCount : sections.length
  return {
    ceiling,
    position,
    chapterCount,
    ceilingTitle: ceiling !== null ? (sections[ceiling]?.title ?? null) : null,
    positionTitle: position !== null ? (sections[position]?.title ?? null) : null,
    atCeiling: ceiling !== null && position === ceiling,
    updatedAt: progress.updatedAt ?? null,
  }
}

/**
 * One line for the panel header.
 * @param {ReturnType<typeof resolvedReadthrough>} view
 */
export function readthroughLine(view) {
  if (!view || view.ceiling === null) return '还没有开始读'
  const head = `已读到第 ${view.ceiling + 1} 章${view.ceilingTitle ? `「${view.ceilingTitle}」` : ''}`
  if (view.atCeiling) return head
  return `${head} · 现在在第 ${view.position + 1} 章`
}
