import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detectFormat, normalizeToEpub } from '../src/host/formats/index.js'
import { parseEpub } from '../src/host/epub.js'
import { writeZip } from '../src/host/zip-write.js'
import { Library } from '../src/host/books.js'
import { Store } from '../src/host/store.js'

const SAMPLES = new URL('../../samples/', import.meta.url)

async function tempLibrary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drc-formats-'))
  const store = new Store({ root })
  await store.ensureLayout()
  return { root, store, library: new Library(store) }
}

const TXT = [
  '第一章 灯下的约定',
  '',
  '灯还亮着。她把那封信压在茶杯下面。',
  '',
  '第二章 旧账',
  '',
  '老板只说，你自己去问他。',
  '',
  '第三章 站一会儿',
  '',
  '她在门口站了一会儿。',
].join('\n')

const FB2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description><title-info>
    <book-title>测试小说</book-title>
    <author><first-name>某</first-name><last-name>作者</last-name></author>
    <lang>zh</lang>
  </title-info></description>
  <body>
    <section><title><p>第一章</p></title><p>第一段。</p><p>第二段。</p></section>
    <section><title><p>第二章</p></title><p>另一段。</p>
      <section><title><p>第二章之一</p></title><p>内层段落。</p></section>
    </section>
  </body>
</FictionBook>`

const HTML = `<!doctype html><html><head><title>网页小说</title></head><body>
<h1>第一章 开始</h1><p>第一段 &amp; 实体。</p><p>第二段。</p>
<h1>第二章 继续</h1><p>第三段。</p>
</body></html>`

const MD = ['# 第一章', '', '第一段，带标点。', '', '## 小节', '', '小节正文。', '', '# 第二章', '', '第二段。'].join('\n')

test('formats: txt is split on chapter headings and round-trips through our EPUB', async () => {
  const { library } = await tempLibrary()
  const meta = await library.importFile(Buffer.from(TXT, 'utf8'), { fileName: 'novel.txt' })
  assert.equal(meta.format, 'txt')
  assert.equal(meta.chapterCount, 3)
  assert.deepEqual(meta.sections.map((s) => s.title), ['第一章 灯下的约定', '第二章 旧账', '第三章 站一会儿'])
  const sections = await library.sections(meta.id)
  assert.match(sections[1].text, /你自己去问他/)
})

test('formats: markdown keeps deep headings as body text', async () => {
  const { library } = await tempLibrary()
  const meta = await library.importFile(Buffer.from(MD, 'utf8'), { fileName: 'notes.md' })
  assert.equal(meta.format, 'markdown')
  assert.equal(meta.chapterCount, 2)
  const sections = await library.sections(meta.id)
  assert.match(sections[0].text, /小节正文/)
})

test('formats: html becomes one section per heading', async () => {
  const { library } = await tempLibrary()
  const meta = await library.importFile(Buffer.from(HTML, 'utf8'), { fileName: 'page.html' })
  assert.equal(meta.format, 'html')
  assert.equal(meta.chapterCount, 2)
  const sections = await library.sections(meta.id)
  assert.match(sections[0].text, /第一段 & 实体/)
})

test('formats: fb2 flattens nested sections in document order', async () => {
  const { library } = await tempLibrary()
  const meta = await library.importFile(Buffer.from(FB2, 'utf8'), { fileName: 'book.fb2' })
  assert.equal(meta.format, 'fb2')
  assert.equal(meta.title, '测试小说')
  assert.equal(meta.chapterCount, 3)
  const sections = await library.sections(meta.id)
  assert.deepEqual(sections.map((s) => s.title), ['第一章', '第二章', '第二章之一'])
  assert.match(sections[1].text, /另一段/)
})

test('formats: a real MOBI imports with text and reports its image loss', async () => {
  const bytes = await fs.readFile(new URL('alice.mobi', SAMPLES))
  const { library } = await tempLibrary()
  const meta = await library.importFile(bytes, { fileName: 'alice.mobi' })
  assert.equal(meta.format, 'mobi')
  assert.equal(meta.textless, false)
  assert.ok(meta.chapterCount > 5, `expected many sections, got ${meta.chapterCount}`)
  assert.match(meta.warnings.join(';'), /图片不会带过来/)
  const sections = await library.sections(meta.id)
  const joined = sections.map((s) => s.text).join('\n')
  assert.match(joined, /Alice/)
  // The gate reads section indexes off this text, so it has to be real prose.
  assert.ok(joined.length > 50_000, `expected substantial text, got ${joined.length}`)
})

test('formats: cbz pages become image sections and the book is textless', async () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100' +
      '05fe02fea7f5c60000000049454e44ae426082',
    'hex',
  )
  const bytes = writeZip([
    { name: 'page-2.png', data: png },
    { name: 'page-1.png', data: png },
  ])
  const { library } = await tempLibrary()
  const meta = await library.importFile(bytes, { fileName: 'comic.cbz' })
  assert.equal(meta.format, 'cbz')
  assert.equal(meta.textless, true)
  assert.equal(meta.chapterCount, 2)
  assert.deepEqual(meta.sections.map((s) => s.title), ['第 1 页', '第 2 页'])
})

test('formats: unsupported containers are refused with a readable message', async () => {
  assert.throws(
    () => normalizeToEpub(Buffer.from('%PDF-1.7 something'), { fileName: 'x.pdf' }),
    /PDF 暂不支持/,
  )
  assert.throws(() => normalizeToEpub(Buffer.from('random bytes here'), { fileName: 'x.zzz' }), /认不出这个文件格式/)
  assert.throws(() => normalizeToEpub(Buffer.from('BOOKMOBInonsense'), { fileName: 'a.azw3' }), /AZW3 暂不支持/)
})

test('formats: detection does not trust the extension alone', async () => {
  assert.equal(detectFormat(Buffer.from('%PDF-1.4 x'), 'mystery'), 'pdf')
  const epub = await fs.readFile(new URL('test-book.epub', SAMPLES))
  assert.equal(detectFormat(epub, 'no-extension'), 'epub')
  // A zip of images without an .opf is a comic, not a broken EPUB.
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const cbz = writeZip([{ name: 'p1.png', data: png }])
  assert.equal(detectFormat(cbz, 'blob'), 'cbz')
})

test('formats: a normalized EPUB is a valid EPUB our own parser reads back', async () => {
  const { epub } = normalizeToEpub(Buffer.from(TXT, 'utf8'), { fileName: 'novel.txt' })
  const parsed = parseEpub(epub)
  assert.equal(parsed.title, '第一章 灯下的约定')
  assert.equal(parsed.sections.length, 3)
  assert.match(parsed.sections[0].text, /灯还亮着/)
  // mimetype must be the first, stored entry or readers refuse the file
  assert.equal(epub.subarray(30, 38).toString('latin1'), 'mimetype')
})
