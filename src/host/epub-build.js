/**
 * Author an EPUB 3 out of plain sections.
 *
 * Every non-EPUB format the reader can open is normalized into one of these
 * files first, so the rest of the plugin only ever deals with EPUB: one
 * renderer, one spine numbering, one CFI space. That identity is what makes
 * the progress gate meaningful across formats.
 */

import { writeZip } from './zip-write.js'

const XML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

/** @param {unknown} text */
export function escapeXml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch])
}

/** Escape text for XHTML bodies, keeping `\n` as paragraph breaks. */
function paragraphs(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeXml(block).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
}

function chapterDocument(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<style>body{font-family:serif;line-height:1.7;margin:0 4%;}h1,h2{font-weight:600;}p{margin:0 0 .8em;text-indent:2em;}</style>
</head>
<body>
${body}
</body>
</html>`
}

/**
 * @param {{
 *   title: string,
 *   author?: string,
 *   language?: string,
 *   identifier?: string,
 *   sections: { title?: string, html?: string, text?: string }[],
 *   resources?: { href: string, mediaType: string, bytes: Buffer }[],
 * }} input
 * @returns {Buffer} EPUB bytes
 */
export function buildEpub(input) {
  const title = String(input.title ?? '').trim() || '未命名'
  const author = String(input.author ?? '').trim()
  const language = String(input.language ?? 'zh').trim() || 'zh'
  const identifier = input.identifier ?? `urn:dsh-reading:${Date.now().toString(36)}`
  const sections = (input.sections ?? []).filter(Boolean)
  if (sections.length === 0) throw new Error('没有可以放进书的正文')

  const resources = input.resources ?? []
  const chapterFiles = []
  const navItems = []

  sections.forEach((section, index) => {
    const file = `chap-${String(index + 1).padStart(3, '0')}.xhtml`
    chapterFiles.push(file)
    navItems.push({ label: section.title?.trim() || `第 ${index + 1} 节`, href: file })
  })

  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...chapterFiles.map(
      (file, index) =>
        `<item id="c${index + 1}" href="${file}" media-type="application/xhtml+xml"/>`,
    ),
    ...resources.map(
      (res, index) =>
        `<item id="r${index + 1}" href="${escapeXml(res.href)}" media-type="${escapeXml(res.mediaType)}"/>`,
    ),
  ]

  const spine = chapterFiles.map((_, index) => `<itemref idref="c${index + 1}"/>`).join('\n    ')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    ${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ''}
    <dc:language>${escapeXml(language)}</dc:language>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh">
<head><meta charset="utf-8"/><title>目录</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>目录</h1>
  <ol>
    ${navItems.map((item) => `<li><a href="${item.href}">${escapeXml(item.label)}</a></li>`).join('\n    ')}
  </ol>
</nav>
</body>
</html>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  const entries = [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf, compress: true },
    { name: 'OEBPS/nav.xhtml', data: nav, compress: true },
  ]

  sections.forEach((section, index) => {
    const body = section.html ?? paragraphs(section.text ?? '')
    const heading = section.title ? `<h1>${escapeXml(section.title)}</h1>\n` : ''
    entries.push({
      name: `OEBPS/${chapterFiles[index]}`,
      data: chapterDocument(section.title ?? '', heading + body),
      compress: true,
    })
  })

  for (const res of resources) {
    entries.push({ name: `OEBPS/${res.href}`, data: res.bytes, compress: true })
  }

  return writeZip(entries)
}
