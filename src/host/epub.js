/**
 * EPUB → sectioned plain text, without dependencies.
 *
 * The reader renders the book with foliate-js in the browser; the Host only
 * needs the *text* of each spine item so it can chunk it, summarise it and
 * retrieve from it. Section index here is exactly the foliate-js spine index,
 * which is also the index embedded in an EPUB CFI — that identity is what makes
 * the spoiler gate's chapter comparison meaningful.
 */

import path from 'node:path'
import { readZip, readZipFile } from './zip.js'

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  deg: '°',
  laquo: '«',
  raquo: '»',
}

/** @param {string} text */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    const named = ENTITIES[body.toLowerCase()]
    return named ?? match
  })
}

/**
 * Strip markup down to readable text while keeping paragraph structure.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let text = String(html ?? '')
  text = text.replace(/<\?xml[\s\S]*?\?>/g, '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|head|svg)\b[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figcaption|dd|dt|pre)>/gi, '\n\n')
  text = text.replace(/<hr\b[^>]*>/gi, '\n\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  text = text.replace(/\r\n?/g, '\n')
  text = text.replace(/\u00a0/g, ' ')
  text = text.replace(/[ \t\f\v]+/g, ' ')
  text = text.replace(/ *\n */g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * Pull one attribute out of a tag's source text.
 * @param {string} tag
 * @param {string} name
 */
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const match = re.exec(tag)
  if (!match) return null
  return decodeEntities(match[2] ?? match[3] ?? '')
}

/**
 * Resolve an href against the directory of the referencing document, keeping
 * the fragment off. Returns a normalized archive path.
 * @param {string} base  archive-relative path of the referencing file
 * @param {string} href
 */
export function resolveHref(base, href) {
  const clean = href.split('#')[0]
  if (!clean) return ''
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    decoded = clean
  }
  const dir = path.posix.dirname(base)
  return path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decoded))
}

/** Normalize a path for comparison (decode + drop leading ./). */
function normPath(value) {
  let out = value
  try {
    out = decodeURIComponent(value)
  } catch {
    out = value
  }
  return out.replace(/^\.\//, '')
}

/**
 * Parse an OPF package document.
 * @param {string} opfText
 * @param {string} opfPath
 */
export function parseOpf(opfText, opfPath) {
  const titleMatch = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opfText)
  const creatorMatch = /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opfText)
  const languageMatch = /<dc:language[^>]*>([\s\S]*?)<\/dc:language>/i.exec(opfText)
  const title = titleMatch ? htmlToText(titleMatch[1]).trim() : ''
  const author = creatorMatch ? htmlToText(creatorMatch[1]).trim() : ''

  /** @type {Map<string, { href: string, path: string, mediaType: string, properties: string }>} */
  const manifest = new Map()
  for (const tag of opfText.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (!id || !href) continue
    manifest.set(id, {
      href,
      path: resolveHref(opfPath, href),
      mediaType: attr(tag, 'media-type') ?? '',
      properties: attr(tag, 'properties') ?? '',
    })
  }

  /** @type {{ idref: string, linear: boolean }[]} */
  const spine = []
  for (const tag of opfText.match(/<itemref\b[^>]*>/gi) ?? []) {
    const idref = attr(tag, 'idref')
    if (!idref) continue
    spine.push({ idref, linear: (attr(tag, 'linear') ?? 'yes').toLowerCase() !== 'no' })
  }

  const tocId = attr((/<spine\b[^>]*>/i.exec(opfText) ?? [''])[0], 'toc')

  return {
    title,
    author,
    language: languageMatch ? htmlToText(languageMatch[1]).trim() : '',
    manifest,
    spine,
    tocId: tocId || null,
    opfPath,
  }
}

/**
 * Read navigation titles out of the EPUB 3 nav document or the EPUB 2 NCX.
 * @param {Map<string, Buffer>} files
 * @param {ReturnType<typeof parseOpf>} opf
 * @returns {Map<string, string>} archive path (no fragment) → title
 */
function readTocTitles(files, opf) {
  /** @type {Map<string, string>} */
  const titles = new Map()

  const navItem = [...opf.manifest.values()].find((item) => /\bnav\b/.test(item.properties))
  if (navItem) {
    const bytes = files.get(navItem.path)
    if (bytes) {
      const html = bytes.toString('utf8')
      const navBlock = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][\s\S]*?<\/nav>/i.exec(html) ?? /<nav\b[\s\S]*?<\/nav>/i.exec(html)
      if (navBlock) {
        for (const tag of navBlock[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
          const open = /<a\b[^>]*>/i.exec(tag)?.[0] ?? ''
          const href = attr(open, 'href')
          const label = htmlToText(tag).trim()
          if (!href || !label) continue
          const target = resolveHref(navItem.path, href)
          if (!titles.has(target)) titles.set(target, label)
        }
      }
    }
  }

  if (titles.size === 0) {
    const ncxItem =
      (opf.tocId ? opf.manifest.get(opf.tocId) : null) ??
      [...opf.manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncxItem) {
      const bytes = files.get(ncxItem.path)
      if (bytes) {
        const xml = bytes.toString('utf8')
        for (const block of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
          const label = htmlToText(/<text>([\s\S]*?)<\/text>/i.exec(block)?.[1] ?? '').trim()
          const src = attr(/<content\b[^>]*>/i.exec(block)?.[0] ?? '', 'src')
          if (!label || !src) continue
          const target = resolveHref(ncxItem.path, src)
          if (!titles.has(target)) titles.set(target, label)
        }
      }
    }
  }

  return titles
}

/**
 * Collect the book's own table of contents, in reading order.
 *
 * One entry per navigation target, fragments kept: the panel uses them to jump,
 * and the count is what tells a reader whether "5 sections" is the whole book.
 *
 * @param {Map<string, Buffer>} files
 * @param {ReturnType<typeof parseOpf>} opf
 * @returns {{ title: string, target: string, fragment: string }[]}
 */
function readTocEntries(files, opf) {
  /** @type {{ title: string, target: string, fragment: string }[]} */
  const entries = []

  const navItem = [...opf.manifest.values()].find((item) => /\bnav\b/.test(item.properties))
  if (navItem) {
    const bytes = files.get(navItem.path)
    if (bytes) {
      const html = bytes.toString('utf8')
      const navBlock = /<nav\b[^>]*epub:type\s*=\s*["']toc["'][\s\S]*?<\/nav>/i.exec(html) ?? /<nav\b[\s\S]*?<\/nav>/i.exec(html)
      for (const tag of navBlock?.[0].match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
        const open = /<a\b[^>]*>/i.exec(tag)?.[0] ?? ''
        const href = attr(open, 'href')
        const title = htmlToText(tag).trim()
        if (!href || !title || href.startsWith('http')) continue
        const [pathPart, fragment = ''] = href.split('#')
        entries.push({
          title,
          target: resolveHref(navItem.path, pathPart),
          fragment: decodeFragment(fragment),
        })
      }
    }
  }

  if (entries.length === 0) {
    const ncxItem =
      (opf.tocId ? opf.manifest.get(opf.tocId) : null) ??
      [...opf.manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml')
    if (ncxItem) {
      const bytes = files.get(ncxItem.path)
      if (bytes) {
        const xml = bytes.toString('utf8')
        for (const block of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
          const title = htmlToText(/<text>([\s\S]*?)<\/text>/i.exec(block)?.[1] ?? '').trim()
          const src = attr(/<content\b[^>]*>/i.exec(block)?.[0] ?? '', 'src')
          if (!title || !src) continue
          const [pathPart, fragment = ''] = src.split('#')
          entries.push({
            title,
            target: resolveHref(ncxItem.path, pathPart),
            fragment: decodeFragment(fragment),
          })
        }
      }
    }
  }

  return entries
}

/** Fragments in EPUBs are percent-encoded often enough to matter. */
function decodeFragment(fragment) {
  if (!fragment) return ''
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

/**
 * Parse an EPUB container into spine sections with plain text.
 *
 * @param {Buffer} bytes
 * @returns {{
 *   title: string, author: string, language: string, chapterCount: number,
 *   sections: { index: number, href: string, path: string, title: string, chars: number, text: string }[],
 * }}
 */
export function parseEpub(bytes) {
  const files = readZip(bytes)
  const container = files.get('META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')
  const rootfile = /<rootfile\b[^>]*full-path\s*=\s*["']([^"']+)["']/i.exec(container.toString('utf8'))
  if (!rootfile) throw new Error('不是有效的 EPUB：container.xml 里没有 rootfile')
  const opfPath = normPath(rootfile[1])
  const opfBytes = files.get(opfPath) ?? files.get(rootfile[1])
  if (!opfBytes) throw new Error(`不是有效的 EPUB：找不到 ${opfPath}`)
  const opfText = opfBytes.toString('utf8')
  const opf = parseOpf(opfText, opfPath)
  const tocTitles = readTocTitles(files, opf)
  const tocEntries = readTocEntries(files, opf)

  const sections = []
  for (const spineItem of opf.spine) {
    const item = opf.manifest.get(spineItem.idref)
    if (!item) continue
    if (item.mediaType && !/html|xml/.test(item.mediaType)) continue
    const fileBytes = files.get(item.path) ?? files.get(item.href)
    if (!fileBytes) continue
    const text = htmlToText(fileBytes.toString('utf8'))
    sections.push({
      index: sections.length,
      href: item.href,
      path: item.path,
      title: tocTitles.get(normPath(item.path)) ?? tocTitles.get(item.href) ?? '',
      chars: text.length,
      text,
    })
  }

  if (sections.length === 0) throw new Error('这个 EPUB 没有可读的正文章节')

  // Chapters whose title the TOC did not give us fall back to the first
  // sentence, which is a far better label than "第 3 章".
  for (const section of sections) {
    if (section.title) continue
    const firstLine = section.text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
    section.title = firstLine ? firstLine.slice(0, 24) : ''
  }

  // The book's own navigation, mapped onto the spine sections we index. A
  // converted book often has one huge spine file holding a dozen chapters, so
  // this list — not `chapterCount` — is what the reader recognises as the book.
  const sectionByPath = new Map(sections.map((section) => [normPath(section.path), section]))
  const toc = []
  for (const entry of tocEntries) {
    const section = sectionByPath.get(normPath(entry.target))
    if (!section) continue
    if (toc.length >= 500) break
    toc.push({
      index: toc.length,
      title: entry.title,
      sectionIndex: section.index,
      // The renderer resolves a TOC href against the OPF, so this must be the
      // archive path (`OEBPS/chapter1.xhtml`), not the manifest's relative href.
      href: entry.fragment ? `${section.path}#${entry.fragment}` : section.path,
    })
  }

  return {
    title: opf.title || '未命名书籍',
    author: opf.author || '',
    language: opf.language || '',
    chapterCount: sections.length,
    sections,
    toc,
  }
}

export { readZipFile }
