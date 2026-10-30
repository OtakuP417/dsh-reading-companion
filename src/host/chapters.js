/**
 * Turn spine documents into the chapters the book says it has.
 *
 * A converted EPUB often packs a dozen chapters into one XHTML file: the file
 * list is an accident of the conversion, while the book's own table of
 * contents is what the reader recognises. Progress, per-chapter summaries and
 * the spoiler gate all want the latter, so the unit we index is the chapter —
 * and a chapter is a character range inside exactly one spine document.
 *
 * The split works by finding each TOC title as its own line, in document order,
 * and only ever moving forward. A title that cannot be found is not guessed at:
 * it merges into the chapter before it, because a wrong boundary would make the
 * gate refuse text the reader has actually read.
 */

/** Longer than this is a paragraph, not a heading — never match it. */
const MAX_TITLE_LENGTH = 120

/**
 * Chapters shorter than this are headings whose body lives elsewhere — the
 * tail of a converted book is full of them. They merge into the chapter before
 * them instead of becoming one-word "chapters" with their own summary.
 */
const MIN_CHAPTER_CHARS = 40

/**
 * Locate a chapter heading line at or after `from`.
 *
 * @param {string} text
 * @param {string} title
 * @param {number} from
 * @returns {number} index of the line start, or -1
 */
export function findTitleLine(text, title, from) {
  const wanted = String(title ?? '').trim()
  if (!wanted || wanted.length > MAX_TITLE_LENGTH) return -1

  for (const candidate of candidates(wanted)) {
    const needle = `\n${candidate}\n`
    const at = text.indexOf(needle, Math.max(0, from - 1))
    if (at !== -1) {
      const start = at + 1
      if (start >= from) return start
    }
    // A heading on the first line has no newline in front of it.
    if (from <= 0 && text.startsWith(`${candidate}\n`)) return 0
  }
  return -1
}

/** The same heading, written with the spacing a converter may have inserted. */
function candidates(title) {
  const out = [title]
  const squeezed = title.replace(/\s+/g, ' ')
  if (squeezed !== title) out.push(squeezed)
  const noSpace = squeezed.replace(/\s+/g, '')
  if (noSpace !== squeezed && noSpace.length > 1) out.push(noSpace)
  return out
}

/**
 * @param {{
 *   sections: { index: number, href: string, path: string, title: string, text: string }[],
 *   toc?: { title: string, sectionIndex: number, href: string }[],
 * }} parsed
 * @returns {{
 *   chapters: { index: number, title: string, docIndex: number, href: string, startChar: number, chars: number, text: string }[],
 *   stats: { docs: number, tocEntries: number, chapters: number, unmatched: string[] },
 * }}
 */
export function buildChapters(parsed) {
  const docs = Array.isArray(parsed?.sections) ? parsed.sections : []
  const toc = Array.isArray(parsed?.toc) ? parsed.toc : []

  /** @type {Map<number, { title: string, href: string }[]>} */
  const marksByDoc = new Map()
  for (const entry of toc) {
    if (!Number.isInteger(entry?.sectionIndex)) continue
    const list = marksByDoc.get(entry.sectionIndex) ?? []
    list.push({ title: entry.title ?? '', href: entry.href ?? '' })
    marksByDoc.set(entry.sectionIndex, list)
  }

  /** @type {{ index: number, title: string, docIndex: number, href: string, startChar: number, chars: number, text: string }[]} */
  const chapters = []
  const unmatched = []

  for (const doc of docs) {
    const marks = marksByDoc.get(doc.index) ?? []
    const text = doc.text ?? ''
    const docHref = doc.href ?? doc.path ?? ''
    const fallbackTitle = (doc.title || '').trim() || `第 ${chapters.length + 1} 章`
    if (marks.length === 0 || text.length === 0) {
      push(doc.index, fallbackTitle, docHref, text, 0, false)
      continue
    }

    let cursor = 0
    let title = fallbackTitle
    let href = docHref
    let found = 0

    for (const mark of marks) {
      const at = findTitleLine(text, mark.title, cursor)
      if (at === -1) {
        // The heading was rewritten or the anchor points elsewhere. Guess
        // nothing: the text stays with the chapter that already owns it.
        if (mark.title) unmatched.push(mark.title)
        continue
      }
      // Text before the first heading belongs to the document itself (cover,
      // front matter, a preamble), so it becomes a chapter of its own.
      if (at > cursor) push(doc.index, found === 0 ? fallbackTitle : title, href, text.slice(cursor, at), cursor, true)
      cursor = at
      title = mark.title || title
      href = mark.href || href
      found += 1
    }

    push(doc.index, found === 0 ? fallbackTitle : title, href, text.slice(cursor), cursor, true)
  }

  for (let i = 0; i < chapters.length; i += 1) chapters[i].index = i

  return {
    chapters,
    stats: { docs: docs.length, tocEntries: toc.length, chapters: chapters.length, unmatched },
  }

  /**
   * @param {number} docIndex
   * @param {string} chapterTitle
   * @param {string} chapterHref
   * @param {string} chapterText
   * @param {number} startChar
   * @param {boolean} mayMerge merge a heading-only stub into the chapter before it
   */
  function push(docIndex, chapterTitle, chapterHref, chapterText, startChar, mayMerge) {
    const body = chapterText.replace(/^\n+/, '').replace(/\s+$/, '')
    if (body.length === 0) return
    const previous = chapters[chapters.length - 1]
    if (mayMerge && body.length < MIN_CHAPTER_CHARS && previous && previous.docIndex === docIndex) {
      previous.text = `${previous.text}\n${body}`.trim()
      previous.chars = previous.text.length
      return
    }
    chapters.push({
      index: chapters.length,
      title: chapterTitle,
      docIndex,
      href: chapterHref,
      startChar,
      chars: body.length,
      text: body,
    })
  }
}
