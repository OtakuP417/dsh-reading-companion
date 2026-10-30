/**
 * The review layer must work with no model at all: takeaways are stored by the
 * discussion path, cards are derived by pure rules, and scheduling is SM-2 over
 * an append-only review log. This test exercises that whole chain on a real
 * Store in a temp directory — no ctx, no llm, no network.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Store, writeJson } from '../src/host/store.js'
import { Library } from '../src/host/books.js'
import { deriveCards, takeawayId } from '../src/shared/cards.js'
import { QUALITY, replay, dueCards } from '../src/shared/scheduler.js'

const BOOK = 'b1'

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'reading-cards-'))
  const store = new Store({ root })
  await store.ensureLayout()
  const library = new Library(store)
  await writeJson(path.join(store.bookDir(BOOK), 'meta.json'), {
    id: BOOK,
    title: '测试书',
    chapterCount: 4,
    sections: [{ index: 0, title: '一' }, { index: 1, title: '二' }],
    importedAt: new Date().toISOString(),
  })
  return { store, library }
}

/** @param {Partial<any>} [overrides] */
function makeTakeaway(overrides = {}) {
  const base = {
    type: '疑问',
    cfi: 'epubcfi(/6/4!/4/2/2:120)',
    chapterIndex: 1,
    userQuote: '你自己去问他',
    aiSummary: '这句话说明街上的人都知道那笔账是什么，只有她不知道。她站在柜台前看了很久，也许是在想自己要不要成为那个去问的人。',
    createdAt: '2026-10-30T03:10:00.000Z',
  }
  const takeaway = { ...base, ...overrides }
  return { ...takeaway, id: takeawayId(takeaway) }
}

test('review: a takeaway yields cards, stores them, and dedupes on re-derive', async () => {
  const { library } = await setup()
  const takeaway = await library.addTakeaway(BOOK, makeTakeaway())
  const cards = deriveCards(takeaway)
  assert.ok(cards.length >= 1 && cards.length <= 3, `expected 1..3 cards, got ${cards.length}`)
  for (const card of cards) {
    assert.equal(card.cfi, takeaway.cfi, 'every card must carry the takeaway CFI')
    assert.equal(card.chapterIndex, 1)
    assert.ok(card.front.length > 0 && card.back.length > 0)
  }

  const created = await library.addCards(BOOK, cards)
  assert.equal(created.length, cards.length, 'first derivation must create the cards')

  const again = await library.addCards(BOOK, deriveCards(takeaway))
  assert.deepEqual(again, [], 're-deriving the same takeaway must not duplicate cards')

  const stored = await library.cards(BOOK)
  assert.equal(stored.length, cards.length)
  for (const card of stored) {
    assert.ok(card.cardId, 'stored cards carry an id (cardId)')
    assert.equal(card.cfi, takeaway.cfi)
  }
})

test('review: SM-2 scheduling advances from the append-only review log', async () => {
  const { library } = await setup()
  const takeaway = await library.addTakeaway(BOOK, makeTakeaway())
  const [card] = await library.addCards(BOOK, deriveCards(takeaway))
  const cards = (await library.cards(BOOK)).map((item) => ({ ...item, cardId: item.cardId ?? item.id }))

  // Before any review the card is due right away (dueCards works on decorated entries).
  const decorate = () => cards.map((item) => ({ card: item, state: replay((reviewsCache ?? []).filter((review) => review.cardId === item.cardId)) }))
  let reviewsCache = await library.reviews(BOOK)
  const before = dueCards(decorate(), Date.now(), { limit: 10 }).map((entry) => entry.card.cardId)
  assert.ok(before.includes(card), 'a fresh card is due immediately')

  const t0 = Date.parse('2026-10-30T04:00:00.000Z')
  await library.addReview(BOOK, { cardId: card, quality: QUALITY.settled, outcome: 'settled' })
  reviewsCache = await library.reviews(BOOK)
  const first = replay(reviewsCache.filter((review) => review.cardId === card))
  assert.equal(first.repetitions, 1)
  assert.ok(first.dueAt > t0, 'first review schedules forward')

  // A second pass a day later stretches the interval; a bad pass resets it.
  await library.addReview(BOOK, { cardId: card, quality: QUALITY.got, outcome: 'got' })
  reviewsCache = await library.reviews(BOOK)
  const second = replay(reviewsCache.filter((review) => review.cardId === card))
  assert.equal(second.repetitions, 2)
  assert.ok(second.interval > first.interval, `interval must grow: ${first.interval} -> ${second.interval}`)

  // The log is append-only: both reviews are still there.
  const log = await readFile(path.join(library.store.logPath('reviews', BOOK)), 'utf8')
  assert.equal(log.trim().split('\n').length, 2)
})

test('review: cards survive a restart because they come off disk', async () => {
  const { store, library } = await setup()
  const takeaway = await library.addTakeaway(BOOK, makeTakeaway())
  await library.addCards(BOOK, deriveCards(takeaway))

  const reopened = new Library(new Store({ root: store.root }))
  const cards = await reopened.cards(BOOK)
  assert.ok(cards.length >= 1)
  assert.ok(cards.every((card) => typeof card.cfi === 'string' && card.cfi.startsWith('epubcfi(')))
})

test('takeaways always get an id, so re-derivation never mints cards named "undefined"', async () => {
  const { library } = await setup()
  const saved = await library.addTakeaway(BOOK, {
    type: '理解',
    cfi: 'epubcfi(/6/4!/4/2/2:0)',
    chapterIndex: 1,
    aiSummary: '她问"是什么账"的时候，其实已经知道家里有笔没结的账。',
  })
  assert.ok(saved.id, 'a stored takeaway must carry an id')
  assert.doesNotMatch(saved.id, /undefined/)
  const first = deriveCards(saved)
  assert.ok(first.length >= 1)
  for (const card of first) assert.ok(card.id.startsWith(`${saved.id}:`), card.id)
  const again = deriveCards({ ...saved })
  assert.deepEqual(again.map((card) => card.id), first.map((card) => card.id))
})

test('progress: the ceiling keeps its own chapter title when the reader scrolls back', async () => {
  const { library } = await setup()
  const first = await library.saveProgress(BOOK, {
    cfi: 'epubcfi(/6/4!/4/2/2:0)',
    positionSectionIndex: 1,
    chapterTitle: '二',
  })
  assert.equal(first.sectionIndex, 1)
  assert.equal(first.ceilingTitle, '二')

  // Going back to chapter one must NOT rename the ceiling to chapter one.
  const back = await library.saveProgress(BOOK, {
    cfi: 'epubcfi(/6/2!/4/2/2:0)',
    positionSectionIndex: 0,
    chapterTitle: '一',
  })
  assert.equal(back.sectionIndex, 1, 'the ceiling never shrinks')
  assert.equal(back.positionSectionIndex, 0)
  assert.equal(back.chapterTitle, '一')
  assert.equal(back.ceilingTitle, '二', 'the high-water chapter keeps its name')
})
