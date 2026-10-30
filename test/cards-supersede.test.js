import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store, writeJson } from '../src/host/store.js'
import { Library } from '../src/host/books.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reading-cards-supersede-'))
  const store = new Store({ root })
  const library = new Library(store)
  return { root, store, library, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const BOOK = 'b1'
const CFI = 'epubcfi(/6/4!/4/2/1:3)'

test('store: a root passed as a bare string is honoured, never silently replaced', () => {
  const root = mkdtempSync(join(tmpdir(), 'reading-store-root-'))
  try {
    assert.equal(new Store(root).root, root)
    assert.equal(new Store({ root }).root, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cards: a re-derived card supersedes its old wording instead of duplicating', async () => {
  const { root, store, library, cleanup } = fixture()
  try {
    await store.ensureLayout()
    await writeJson(join(root, 'books', BOOK, 'meta.json'), { id: BOOK, title: 't', chapterCount: 2, sections: [] })

    await library.addCards(BOOK, [
      { id: 't1:1', takeawayId: 't1', front: 'old wording', back: 'same back', cfi: CFI, chapterIndex: 0, kind: 'question' },
    ])
    assert.equal((await library.cards(BOOK)).length, 1)

    // Rules improved: same id, new wording. The log grows, the reader still sees one card.
    await library.addCards(BOOK, [
      { id: 't1:1', takeawayId: 't1', front: 'new wording', back: 'same back', cfi: CFI, chapterIndex: 0, kind: 'question' },
    ])
    const cards = await library.cards(BOOK)
    assert.equal(cards.length, 1)
    assert.equal(cards[0].front, 'new wording')

    // Identical re-derivation is a no-op.
    const before = (await library.cards(BOOK)).length
    await library.addCards(BOOK, [
      { id: 't1:1', takeawayId: 't1', front: 'new wording', back: 'same back', cfi: CFI, chapterIndex: 0, kind: 'question' },
    ])
    assert.equal((await library.cards(BOOK)).length, before)
  } finally {
    cleanup()
  }
})
