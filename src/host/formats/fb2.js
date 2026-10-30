/**
 * FictionBook 2 (.fb2 / .fbz): XML, so the interesting part is only which
 * `<section>` is a chapter and what its title is. Nested sections are flattened
 * in document order — the reader should be able to move chapter by chapter
 * without meeting a chapter that is just a container for other chapters.
 */

import { decodeEntities } from './text.js'

/**
 * Top-level `<section>` blocks of a fragment, nesting-aware.
 * Returns both the inner body and the full span (tags included).
 * @param {string} xml
 */
export function findSections(xml) {
  const out = []
  const tag = /<\/?section\b[^>]*>/gi
  let depth = 0
  let start = 0
  let startTagEnd = 0
  let match
  while ((match = tag.exec(xml)) !== null) {
    const closing = match[0][1] === '/'
    if (!closing) {
      if (depth === 0) {
        start = match.index
        startTagEnd = match.index + match[0].length
      }
      depth++
      continue
    }
    depth--
    if (depth < 0) depth = 0
    if (depth === 0) {
      out.push({
        full: xml.slice(start, match.index + match[0].length),
        inner: xml.slice(startTagEnd, match.index),
      })
    }
  }
  return out
}

function innerOf(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)
  return match ? match[1] : ''
}

function textOf(fragment) {
  return decodeEntities(
    String(fragment ?? '')
      .replace(/<empty-line\b[^>]*\/?>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstLine(fragment) {
  const text = textOf(innerOf(fragment, 'title'))
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? ''
  )
}

/** Body text of one section: nested sections and title blocks removed. */
function bodyText(sectionXml) {
  let body = sectionXml
  for (const nested of findSections(body)) body = body.replace(nested.full, '')
  body = body.replace(/<title\b[\s\S]*?<\/title>/gi, '')
  const blockTag = /<(p|subtitle|v|text-author|epigraph|cite|poem|stanza)\b[^>]*>([\s\S]*?)<\/\1>/gi
  const parts = []
  let match
  while ((match = blockTag.exec(body)) !== null) {
    const text = textOf(match[2])
    if (text) parts.push(text)
  }
  if (parts.length === 0) return textOf(body)
  return parts.join('\n\n')
}

/**
 * Walk sections depth-first: a parent's own prose becomes its entry, then its
 * children follow, so a nest never swallows the chapters under it.
 * @param {string} xml
 * @param {{ title: string, text: string }[]} out
 */
function collectSections(xml, out) {
  for (const section of findSections(xml)) {
    const text = bodyText(section.inner)
    if (text) out.push({ title: firstLine(section.inner) || '', text })
    collectSections(section.inner, out)
  }
}

/**
 * @param {string} xml FB2 document text
 * @returns {{ title: string, author: string, language: string, sections: { title: string, text: string }[] }}
 */
export function parseFb2(xml) {
  const source = String(xml ?? '').replace(/^\uFEFF/, '')
  if (!/<FictionBook\b/i.test(source)) throw new Error('不是有效的 FB2：缺少 FictionBook 根元素')

  const description = innerOf(source, 'description')
  const titleTag = innerOf(description, 'book-title')
  const authorTag = innerOf(description, 'author')
  const author = [
    innerOf(authorTag, 'first-name'),
    innerOf(authorTag, 'middle-name'),
    innerOf(authorTag, 'last-name'),
  ]
    .map((part) => textOf(part))
    .filter(Boolean)
    .join(' ')
  const language = textOf(innerOf(description, 'lang')) || 'zh'

  const bodies = []
  const bodyRegex = /<body\b([^>]*)>([\s\S]*?)<\/body>/gi
  let bodyMatch
  while ((bodyMatch = bodyRegex.exec(source)) !== null) {
    const attrs = bodyMatch[1] ?? ''
    if (/name\s*=\s*["'](notes|comments|footnotes)["']/i.test(attrs)) continue
    bodies.push(bodyMatch[2])
  }
  if (bodies.length === 0) throw new Error('这个 FB2 没有正文')

  const sections = []
  for (const body of bodies) {
    const before = sections.length
    collectSections(body, sections)
    if (sections.length === before) {
      const text = bodyText(body)
      if (text) sections.push({ title: firstLine(body) || '', text })
    }
  }

  if (sections.length === 0) throw new Error('这个 FB2 没有可读的正文')
  return { title: textOf(titleTag) || '未命名', author, language, sections }
}
