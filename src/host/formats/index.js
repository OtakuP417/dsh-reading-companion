/**
 * Format dispatch: everything the reader can import, normalized into one EPUB.
 *
 * Why normalize instead of teaching the indexer every container: the renderer
 * (foliate-js) and the indexer must agree on what "section 3" means, or the
 * progress gate compares two different books. Authoring our own EPUB makes that
 * agreement structural rather than a maintenance promise.
 */

import { buildEpub } from '../epub-build.js'
import { readCentralDirectory } from '../zip.js'
import { decodeText, sectionsFromHtml, sectionsFromMarkdown, sectionsFromText } from './text.js'
import { parseFb2 } from './fb2.js'
import { parseMobi } from './mobi.js'
import { parseCbz } from './cbz.js'

export const SUPPORTED_EXTENSIONS = [
  '.epub', '.fb2', '.fbz', '.mobi', '.azw', '.prc', '.txt', '.md', '.markdown', '.html', '.htm', '.cbz',
]

export const FORMAT_LABEL = {
  epub: 'EPUB',
  fb2: 'FB2',
  mobi: 'MOBI',
  txt: '纯文本',
  markdown: 'Markdown',
  html: 'HTML',
  cbz: '漫画压缩包',
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** @param {Buffer} buf */
function looksLikeZip(buf) {
  return buf.length > 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)
}

/** @param {Buffer} buf */
function looksLikeMobi(buf) {
  return buf.length > 68 && buf.subarray(60, 68).toString('latin1') === 'BOOKMOBI'
}

/** @param {Buffer} buf */
function looksLikePdf(buf) {
  return buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

/**
 * @param {Buffer} bytes
 * @param {string} fileName
 * @returns {string} one of 'epub' | 'fb2' | 'mobi' | 'txt' | 'markdown' | 'html' | 'cbz' | 'pdf' | 'azw3' | 'unknown'
 */
export function detectFormat(bytes, fileName = '') {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const lower = String(fileName).toLowerCase()
  const ext = lower.slice(lower.lastIndexOf('.'))

  if (ext === '.pdf' || looksLikePdf(buf)) return 'pdf'
  if (ext === '.epub') return 'epub'
  if (ext === '.fb2' || ext === '.fbz') return 'fb2'
  if (ext === '.azw3') return 'azw3'
  if (['.mobi', '.azw', '.prc'].includes(ext)) return 'mobi'
  if (ext === '.cbz') return 'cbz'
  if (['.txt', '.text', '.log'].includes(ext)) return 'txt'
  if (['.md', '.markdown'].includes(ext)) return 'markdown'
  if (['.html', '.htm', '.xhtml'].includes(ext)) return 'html'

  if (looksLikeMobi(buf)) return 'mobi'
  if (looksLikeZip(buf)) {
    // EPUB keeps its mimetype as the first, stored entry; FBZ carries an .fb2
    if (buf.subarray(30, 38).toString('latin1') === 'mimetype') {
      const nameLength = buf.readUInt16LE(26)
      const mime = buf.subarray(30, 30 + nameLength).toString('latin1')
      if (mime === 'mimetype') {
        const value = buf
          .subarray(30 + nameLength + buf.readUInt16LE(28), 30 + nameLength + buf.readUInt16LE(28) + 20)
          .toString('latin1')
        if (value.startsWith('application/epub+zip')) return 'epub'
      }
    }
    try {
      const { entries } = readCentralDirectory(buf)
      const names = [...entries.keys()]
      if (names.some((name) => /\.fb2$/i.test(name))) return 'fb2'
      if (names.some((name) => /\.(jpe?g|png|gif|webp)$/i.test(name))) return 'cbz'
      if (names.some((name) => /\.(x?html|opf)$/i.test(name))) return 'epub'
    } catch {
      /* not a zip we understand */
    }
  }
  if (buf.length > 200 && /<FictionBook\b/i.test(buf.subarray(0, 4000).toString('utf8'))) return 'fb2'
  return 'unknown'
}

/**
 * Normalize any supported file into EPUB bytes plus what the caller needs to
 * label it. Throws with a user-facing Chinese message on anything unsupported.
 *
 * @param {Buffer} bytes
 * @param {{ fileName?: string }} [options]
 * @returns {{ epub: Buffer, format: string, title: string, author: string, language: string, textless: boolean, warnings: string[] }}
 */
export function normalizeToEpub(bytes, { fileName = '' } = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const format = detectFormat(buf, fileName)
  const warnings = []
  const baseName = String(fileName).replace(/\.[^.]+$/, '').trim() || '未命名'

  if (format === 'epub') {
    return { epub: buf, format, title: '', author: '', language: '', textless: false, warnings }
  }
  if (format === 'pdf') {
    throw new Error('PDF 暂不支持：这个版本的阅读器没有内置 PDF 文本层。可以先转成 EPUB 再导入。')
  }
  if (format === 'azw3') {
    throw new Error('AZW3 暂不支持：它的正文是碎片索引，需要先转成 EPUB 或旧版 MOBI 再导入。')
  }
  if (format === 'unknown') {
    throw new Error('认不出这个文件格式。目前支持 EPUB、MOBI、FB2/FBZ、TXT、Markdown、HTML、CBZ。')
  }

  if (format === 'mobi') {
    const book = parseMobi(buf)
    warnings.push('MOBI 只保留文字，图片不会带过来。')
    return {
      epub: buildEpub({
        title: book.title || baseName,
        author: book.author,
        language: book.language,
        sections: book.sections,
      }),
      format,
      ...book,
      textless: false,
      warnings,
    }
  }

  if (format === 'fb2') {
    const xml = readFb2Source(buf, fileName)
    const book = parseFb2(xml)
    return {
      epub: buildEpub({
        title: book.title || baseName,
        author: book.author,
        language: book.language,
        sections: book.sections,
      }),
      format,
      title: book.title,
      author: book.author,
      language: book.language,
      textless: false,
      warnings,
    }
  }

  if (format === 'cbz') {
    const book = parseCbz(buf)
    return {
      epub: buildEpub({
        title: book.title || baseName,
        sections: book.sections,
        resources: book.resources,
      }),
      format,
      title: book.title,
      author: '',
      language: 'zh',
      textless: true,
      warnings,
    }
  }

  const text = decodeText(buf)
  const sections =
    format === 'markdown'
      ? sectionsFromMarkdown(text)
      : format === 'html'
        ? sectionsFromHtml(text)
        : sectionsFromText(text)
  if (sections.length === 0) throw new Error('这个文件里没有可读的正文')
  const title = sections[0]?.title?.trim() || baseName
  return {
    epub: buildEpub({ title, sections }),
    format,
    title,
    author: '',
    language: 'zh',
    textless: false,
    warnings,
  }
}

/** An .fbz is a zip holding one .fb2; a bare .fb2 is the XML itself. */
function readFb2Source(buf, fileName) {
  const lower = String(fileName).toLowerCase()
  if (lower.endsWith('.fbz') || (looksLikeZip(buf) && !lower.endsWith('.fb2'))) {
    const { entries } = readCentralDirectory(buf)
    const name = [...entries.keys()].find((entry) => /\.fb2$/i.test(entry))
    if (!name) throw new Error('这个 FBZ 里没有 .fb2 文件')
    const entry = entries.get(name)
    return decodeText(readEntry(buf, entry))
  }
  return decodeText(buf)
}
