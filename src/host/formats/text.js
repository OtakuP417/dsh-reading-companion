/**
 * Plain-text family: .txt, .md/.markdown, .html/.htm.
 *
 * Splitting is heuristic on purpose — there is no structure to trust — but the
 * result only has to be *good enough to anchor in*: a section is a chapter, and
 * the reader's position is compared chapter by chapter.
 */

const CHAPTER_LINE =
  /^\s*(?:第[0-9零〇一二三四五六七八九十百千两]{1,12}[章节回卷部篇集幕]|(?:Chapter|CHAPTER|Part|PART)\s+(?:\d{1,4}|[IVXLC]{1,7})\b|序章|序幕|楔子|引子|尾声|终章|后记|番外|前言|自序)/

const HEADING_MD = /^(#{1,2})\s+(.+?)\s*#*\s*$/

/** Decode text bytes without guessing wrong: UTF-8 first, then GB18030 (CJK books). */
export function decodeText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3))
  }
  for (const encoding of ['utf-8', 'gb18030', 'big5']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buf)
    } catch {
      /* try the next one */
    }
  }
  return new TextDecoder('utf-8').decode(buf)
}

function cleanTitle(line) {
  return line.replace(HEADING_MD, '$2').replace(/^#+\s*/, '').trim().slice(0, 60)
}

function trimBlank(lines) {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

/** Group text lines into sections at chapter-looking lines. @param {string} text */
export function splitByChapters(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const sections = []
  let title = ''
  let current = []

  const flush = () => {
    const body = trimBlank(current).join('\n').trim()
    if (body) sections.push({ title, text: body })
    current = []
  }

  for (const line of lines) {
    if (CHAPTER_LINE.test(line) && line.trim().length <= 40) {
      flush()
      title = cleanTitle(line)
      continue
    }
    current.push(line)
  }
  flush()
  return sections
}

/** Keep chunks small enough to be a real "chapter" when a file has no headings. */
function splitBySize(text, size = 7000) {
  const paragraphs = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const out = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length + 2 > size && buffer) {
      out.push({ title: '', text: buffer })
      buffer = ''
    }
    buffer += (buffer ? '\n\n' : '') + paragraph
  }
  if (buffer) out.push({ title: '', text: buffer })
  return out
}

export function sectionsFromText(text) {
  const chapters = splitByChapters(text)
  const filled = chapters.filter((s) => s.text.length > 0)
  if (filled.length >= 2) return filled
  const sized = splitBySize(text).filter((s) => s.text.length > 0)
  if (sized.length > 0) return sized
  const only = String(text ?? '').trim()
  return only ? [{ title: '', text: only }] : []
}

export function sectionsFromMarkdown(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  // Prefer the shallowest heading the document actually uses: a book with `#`
  // chapters should not be cut apart at every `##`, while a document of only
  // `##` headings still needs them.
  const level = /^#[ \t]+\S/m.test(raw) ? 1 : 2
  const heading = new RegExp(`^#{${level}}[ \\t]+(.+?)[ \\t]*#*[ \\t]*$`)
  const deeper = new RegExp(`^#{${level + 1},6}[ \\t]+`)
  const lines = raw.split('\n')
  const sections = []
  let title = ''
  let current = []
  const flush = () => {
    const body = trimBlank(current).join('\n').trim()
    if (body) sections.push({ title, text: body })
    current = []
  }
  for (const line of lines) {
    const match = heading.exec(line)
    if (match) {
      flush()
      title = match[1].trim().slice(0, 60)
      continue
    }
    // deeper headings and everything else stay in the body
    current.push(line.replace(deeper, ''))
  }
  flush()
  if (sections.length === 0) return sectionsFromText(raw)
  return sections
}

const BLOCK_END = /<\/(?:p|div|h[1-6]|li|blockquote|section|article|tr|pre)>/gi

/** HTML → sections keyed on <h1>/<h2>, with the markup flattened to text. */
export function sectionsFromHtml(html) {
  const source = String(html ?? '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, _level, inner) => {
      return `\n\n@@CHAPTER@@${stripTags(inner)}\n\n`
    })
    .replace(BLOCK_END, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  const text = decodeEntities(source)

  const sections = []
  let title = ''
  let current = []
  const flush = () => {
    const body = trimBlank(current).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (body) sections.push({ title, text: body })
    current = []
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('@@CHAPTER@@')) {
      flush()
      title = line.slice('@@CHAPTER@@'.length).trim().slice(0, 60)
      continue
    }
    current.push(line)
  }
  flush()
  if (sections.length === 0) return sectionsFromText(text)
  return sections
}

function stripTags(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '')
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
}

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}
