/**
 * A chapter is a table-of-contents entry, not a spine document.
 *
 * Converted EPUBs pack a dozen chapters into one XHTML file, so measuring
 * progress in documents unlocks chapters the reader has not reached. These
 * tests pin the split, the merge of heading-only stubs, and the migration of a
 * library that was indexed when a document *was* a chapter.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildChapters } from '../src/host/chapters.js'
import { chaptersInDoc, resolveChapterFromHref, resolveChapterIndex, Library } from '../src/host/books.js'
import { Store, readJson, writeJson } from '../src/host/store.js'
import { buildEpub } from '../src/host/epub-build.js'
import { parseEpub } from '../src/host/epub.js'

/** Two spine documents; the first holds three chapters, the second one. */
const PARSED = {
  sections: [
    {
      index: 0,
      href: 'OEBPS/part1.xhtml',
      title: '第一部分',
      text: [
        '第一章',
        '这是第一章的正文，写得很长，长到远远超过四十个字符这个下限，这样它就不会被切章逻辑当成只有标题的残章并进上一章里去。',
        '第二章',
        '这是第二章的正文，同样写得很长，长度足足有六十多个字符，足够让切章逻辑承认它是一个独立的章节，而不是上一章的尾巴。',
        '第三章',
        '这是第三章的正文，也要写得足够长，否则它会被并进第二章，测试里就会少算一章，断言也就对不上了。再多写一些字，务必稳稳超过四十个字符的下限。',
      ].join('\n'),
    },
    {
      index: 1,
      href: 'OEBPS/part2.xhtml',
      title: '第二部分',
      text: ['第四章', '这是第四章的正文，在第二个文档里，长度同样要超过四十个字符，免得被上一章吞掉。'].join('\n'),
    },
  ],
  toc: [
    { index: 0, title: '第一章', sectionIndex: 0, href: 'OEBPS/part1.xhtml#c1' },
    { index: 1, title: '第二章', sectionIndex: 0, href: 'OEBPS/part1.xhtml#c2' },
    { index: 2, title: '第三章', sectionIndex: 0, href: 'OEBPS/part1.xhtml#c3' },
    // A title the document does not actually contain: it must not cut anything.
    { index: 3, title: '不存在的标题', sectionIndex: 0, href: 'OEBPS/part1.xhtml#c9' },
    { index: 4, title: '第四章', sectionIndex: 1, href: 'OEBPS/part2.xhtml#c4' },
  ],
}

test('chapters: the split follows the table of contents, not the spine', () => {
  const { chapters, stats } = buildChapters(PARSED)
  assert.equal(stats.docs, 2)
  assert.equal(chapters.length, 4, '第一章/第二章/第三章/第四章')
  assert.deepEqual(
    chapters.map((chapter) => chapter.docIndex),
    [0, 0, 0, 1],
    'three chapters share the first document',
  )
  assert.equal(chapters[0].title, '第一章')
  assert.match(chapters[1].text, /这是第二章的正文/)
  assert.equal(chapters[3].title, '第四章')
  assert.deepEqual(stats.unmatched, ['不存在的标题'], 'a title the document lacks cuts nothing')
})

test('chapters: a heading whose body is missing joins the chapter before it', () => {
  const parsed = {
    sections: [
      {
        index: 0,
        href: 'a.xhtml',
        title: 'A',
        text: [
          '第一章',
          '这是第一章的正文，写得很长，长到远远超过四十个字符这个下限，这样它就不会被切章逻辑当成只有标题的残章并进上一章里去。',
          '第二章',
          '第三章',
          '这是第三章的正文，也要写得足够长，否则它会被并进第二章，测试里就会少算一章，断言也就对不上了。',
        ].join('\n'),
      },
    ],
    toc: [
      { index: 0, title: '第一章', sectionIndex: 0, href: 'a.xhtml#1' },
      { index: 1, title: '第二章', sectionIndex: 0, href: 'a.xhtml#2' },
      { index: 2, title: '第三章', sectionIndex: 0, href: 'a.xhtml#3' },
    ],
  }
  const { chapters } = buildChapters(parsed)
  assert.equal(chapters.length, 2, '第二章 只有标题、没有正文，因此不单独成章')
  assert.match(chapters[1].text, /第三章/)
})

test('chapters: resolveChapterFromHref prefers an exact entry, then the document', () => {
  const sections = [
    { index: 0, title: '一', docIndex: 0, href: 'OEBPS/part1.xhtml#c1' },
    { index: 1, title: '二', docIndex: 0, href: 'OEBPS/part1.xhtml#c2' },
    { index: 2, title: '三', docIndex: 1, href: 'OEBPS/part2.xhtml#c3' },
  ]
  assert.equal(resolveChapterFromHref(sections, 'OEBPS/part1.xhtml#c2', 0), 1)
  // An href we only know by document: the deepest chapter of that document.
  assert.equal(resolveChapterFromHref(sections, 'OEBPS/part1.xhtml#gone', 0), 1)
  // No href at all: fall back to the spine document.
  assert.equal(resolveChapterFromHref(sections, null, 1), 2)
  assert.equal(resolveChapterFromHref(sections, null, 9), null)
  assert.equal(chaptersInDoc(sections, 0).length, 2)
})

test('chapters: a bare CFI resolves to the last chapter of its document', () => {
  const sections = [
    { index: 0, title: '一', docIndex: 0, href: 'a.xhtml#1' },
    { index: 1, title: '二', docIndex: 1, href: 'b.xhtml#2' },
    { index: 2, title: '三', docIndex: 1, href: 'b.xhtml#3' },
  ]
  // epubcfi(/6/4) is spine item 1 (1-based, even steps).
  assert.equal(resolveChapterIndex(sections, { cfi: 'epubcfi(/6/4!/4/2/2:0)' }), 2)
  assert.equal(resolveChapterIndex(sections, { sectionIndex: 0 }), 0)
  assert.equal(resolveChapterIndex(sections, {}), null)
})

test('chapters: an old document-level library is re-cut and its progress lifted', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'drc-chapters-'))
  try {
    const store = new Store({ root })
    await store.ensureLayout()
    const library = new Library(store)
    const epub = buildEpub({
      title: '两章书',
      author: '某人',
      language: 'zh',
      identifier: 'urn:uuid:chapters-test',
      sections: [
        { title: '开始', text: '第一章\n这是第一章的正文，写得足够长，可以当作一章。' },
        { title: '继续', text: '第二章\n这是第二章的正文，也足够长，可以独立成章。' },
      ],
    })
    const meta = await library.importEpub(epub, { fileName: 'two.epub' })
    const chapters = await library.sections(meta.id)
    assert.equal(chapters.length, 2, 'two documents, two chapters')

    // Rewind the library to the old shape: one section per document.
    const parsed = parseEpub(epub)
    const legacy = parsed.sections.map((section) => ({
      index: section.index,
      href: section.href,
      title: section.title,
      chars: section.chars,
      text: section.text,
    }))
    await writeJson(store.bookPath(meta.id, 'sections.json'), legacy)
    await writeJson(store.bookPath(meta.id, 'chunks.json'), [])
    const legacyMeta = await readJson(store.bookPath(meta.id, 'meta.json'), null)
    delete legacyMeta.chaptersVersion
    delete legacyMeta.docCount
    legacyMeta.sections = legacy.map(({ index, href, title, chars }) => ({ index, href, title, chars }))
    await writeJson(store.bookPath(meta.id, 'meta.json'), legacyMeta)
    // The reader had reached the second document.
    await writeJson(store.progressPath(meta.id), {
      bookId: meta.id,
      cfi: 'epubcfi(/6/4!/4/2/2:0)',
      sectionIndex: 1,
      positionSectionIndex: 1,
      chapterTitle: null,
      sectionCount: 2,
      updatedAt: '2026-10-01T00:00:00.000Z',
    })

    const fresh = new Library(store)
    const recut = await fresh.sections(meta.id)
    assert.equal(recut.length, 2)
    assert.ok(recut.every((chapter) => typeof chapter.docIndex === 'number'), 'every chapter knows its document')

    const progress = await fresh.progress(meta.id)
    assert.equal(progress.chaptersVersion, 2)
    assert.equal(progress.sectionCount, 2)
    assert.equal(progress.sectionIndex, 1, 'the ceiling covers the whole document that was read')
    assert.equal(progress.cfi, 'epubcfi(/6/4!/4/2/2:0)', 'the anchor is kept')
    assert.ok(progress.migratedAt)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
