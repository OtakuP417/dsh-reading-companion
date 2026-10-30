/**
 * CBZ (comic archive): the pages are images, so there is no text to discuss.
 * The book is still readable — every page becomes one fixed section with the
 * image dropped in — but the AI layers must be told the text is absent rather
 * than inventing a summary of a cover.
 */

import { readCentralDirectory, readEntry } from '../zip.js'

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i

function mediaType(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'avif') return 'image/avif'
  return 'application/octet-stream'
}

/** Natural sort so page-10 comes after page-9. */
function pageOrder(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * @param {Buffer} bytes
 * @returns {{ title: string, author: string, language: string, textless: true,
 *   sections: { title: string, html: string }[],
 *   resources: { href: string, mediaType: string, bytes: Buffer }[] }}
 */
export function parseCbz(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const { entries } = readCentralDirectory(buf)
  const pages = [...entries.keys()].filter((name) => IMAGE_EXT.test(name)).sort(pageOrder)
  if (pages.length === 0) throw new Error('这个 CBZ 里没有图片页面')

  const resources = []
  const sections = []
  pages.forEach((name, index) => {
    const href = `page-${String(index + 1).padStart(4, '0')}${name.slice(name.lastIndexOf('.'))}`
    resources.push({ href, mediaType: mediaType(name), bytes: Buffer.from(readEntry(buf, entries.get(name))) })
    sections.push({
      title: `第 ${index + 1} 页`,
      html: `<div style="text-align:center"><img src="${href}" alt="第 ${index + 1} 页" style="max-width:100%;height:auto"/></div>`,
    })
  })

  return { title: '', author: '', language: 'zh', textless: true, sections, resources }
}
