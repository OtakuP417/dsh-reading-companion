import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCfi,
  compareCfi,
  describeCfi,
  formatCfi,
  isCfi,
  normalizeCfi,
  parseCfi,
  spineIndexOf,
  tryParseCfi,
} from '../src/shared/cfi.js'
import {
  describeProgress,
  filterReadable,
  gateTarget,
  isCfiReadable,
  requireReadable,
  resolveSectionIndex,
  summaryCeiling,
} from '../src/shared/spoiler.js'
import { HybridIndex, chunkSection, clip, splitSentences, tokenize } from '../src/shared/retrieval.js'
import { deriveCards, isTakeaway, takeawayId } from '../src/shared/cards.js'
import { QUALITY, applyReview, describeDue, dueCards, replay, retire } from '../src/shared/scheduler.js'

const DAY = 24 * 60 * 60 * 1000

test('cfi: parses the canonical form', () => {
  const parsed = parseCfi('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/3:10)')
  assert.equal(parsed.range, false)
  assert.equal(parsed.base.paths.length, 2)
  assert.equal(parsed.base.offset, 10)
  assert.deepEqual(
    parsed.base.paths[0].map((step) => step.index),
    [6, 4],
  )
  assert.deepEqual(
    parsed.base.paths[1].map((step) => step.index),
    [4, 10, 3],
  )
  assert.equal(parsed.base.paths[0][1].id, 'chap01ref')
})

test('cfi: spine index from the itemref step', () => {
  assert.equal(spineIndexOf('epubcfi(/6/2[cover]!/4/2/2)'), 0)
  assert.equal(spineIndexOf('epubcfi(/6/4[chap01ref]!/4/2/2/1:0)'), 1)
  assert.equal(spineIndexOf('epubcfi(/6/28!/4/2)'), 13)
})

test('cfi: spine index tolerates a package path without the /6 prefix', () => {
  assert.equal(spineIndexOf('epubcfi(/4/10!/4/2)'), 4)
})

test('cfi: formatting is stable and drops assertions', () => {
  const parsed = parseCfi('epubcfi(/6/4[chap01ref]!/4[body01]/10[p-5]/3:10)')
  assert.equal(formatCfi(parsed), 'epubcfi(/6/4!/4/10/3:10)')
  assert.equal(normalizeCfi('epubcfi(/6/4[x]!/4[body01]/10[p-5]/3:10)'), 'epubcfi(/6/4!/4/10/3:10)')
})

test('cfi: ranges keep all three segments', () => {
  const parsed = parseCfi('epubcfi(/6/14[chap05ref]!/4[body01]/10[para05]/1:3,/1:3,/3:4)')
  assert.equal(parsed.range, true)
  assert.ok(parsed.start && parsed.end)
  assert.equal(formatCfi(parsed), 'epubcfi(/6/14!/4/10/1:3,/1:3,/3:4)')
})

test('cfi: comparison orders by section then by path then offset', () => {
  const early = 'epubcfi(/6/2!/4/2/1:0)'
  const laterChapter = 'epubcfi(/6/6!/4/2/1:0)'
  const laterParagraph = 'epubcfi(/6/2!/4/2/2/1:0)'
  const laterOffset = 'epubcfi(/6/2!/4/2/1:50)'
  assert.equal(compareCfi(early, laterChapter), -1)
  assert.equal(compareCfi(laterChapter, early), 1)
  assert.equal(compareCfi(early, laterParagraph), -1)
  assert.equal(compareCfi(early, laterOffset), -1)
  assert.equal(compareCfi(early, early), 0)
  assert.equal(compareCfi(early, 'epubcfi('), null)
})

test('cfi: garbage is rejected, not guessed at', () => {
  for (const bad of ['', 'epubcfi()', '/6/2!/4', 'epubcfi(/6/x)', 'epubcfi(/6/2!', null, 42]) {
    assert.equal(tryParseCfi(/** @type {any} */ (bad)), null)
  }
  assert.equal(isCfi('epubcfi(/6/2!/4/2)'), true)
  assert.equal(isCfi('hello'), false)
  assert.throws(() => parseCfi('epubcfi(/6/x!/4)'))
})

test('cfi: build + describe round-trip', () => {
  const built = buildCfi(3, [
    { index: 4, id: null, isText: false },
    { index: 2, id: null, isText: false },
    { index: 1, id: null, isText: true },
  ], 7)
  assert.equal(built, 'epubcfi(/6/8!/4/2/1:7)')
  assert.deepEqual(describeCfi(built), { cfi: built, sectionIndex: 3, offset: 7, steps: [4, 2, 1] })
})

test('gate: fails closed with no progress', () => {
  const decision = gateTarget({ cfi: 'epubcfi(/6/2!/4/2)' }, null)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'no-progress')
})

test('gate: boundary chapter is readable, later chapter is not', () => {
  const progress = { sectionIndex: 4, cfi: 'epubcfi(/6/10!/4/2/1:0)', chapterTitle: '第五章' }
  assert.equal(gateTarget({ sectionIndex: 4 }, progress).allowed, true)
  assert.equal(gateTarget({ sectionIndex: 3 }, progress).allowed, true)
  assert.equal(gateTarget({ sectionIndex: 5 }, progress).allowed, false)
  assert.equal(gateTarget({ sectionIndex: 5 }, progress).code, 'unread')
  assert.equal(gateTarget({ cfi: 'epubcfi(/6/12!/4/2)' }, progress).allowed, false)
  assert.equal(gateTarget({ cfi: 'epubcfi(/6/10!/4/2)' }, progress).allowed, true)
})

test('gate: unknown target is denied instead of allowed', () => {
  const progress = { sectionIndex: 4 }
  const decision = gateTarget({ cfi: 'not-a-cfi' }, progress)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, 'unknown-target')
  assert.equal(resolveSectionIndex({ sectionIndex: 0, cfi: 'epubcfi(/6/2!/4)' }), 0)
  // The CFI is the coordinate; a contradicting chapter number fails closed.
  assert.equal(resolveSectionIndex({ sectionIndex: 2, cfi: 'epubcfi(/6/2!/4)' }), null)
})

test('gate: strict mode excludes the boundary chapter itself', () => {
  const progress = { sectionIndex: 4 }
  assert.equal(gateTarget({ sectionIndex: 4 }, progress, { allowAtBoundary: false }).allowed, false)
})

test('gate: requireReadable throws a named error', () => {
  assert.throws(() => requireReadable({ sectionIndex: 9 }, { sectionIndex: 1 }), /进度门拒绝/)
})

test('gate: filterReadable never returns unread chunks', () => {
  const chunks = [0, 1, 2, 3, 4].map((sectionIndex) => ({ id: `c${sectionIndex}`, sectionIndex }))
  assert.deepEqual(filterReadable(chunks, { sectionIndex: 2 }).map((c) => c.id), ['c0', 'c1', 'c2'])
  assert.deepEqual(filterReadable(chunks, null), [])
  assert.equal(summaryCeiling({ sectionIndex: 3 }), 3)
  assert.equal(summaryCeiling(null), -1)
})

test('gate: isCfiReadable and describeProgress', () => {
  const progress = { sectionIndex: 1, chapterTitle: '第二章', cfi: 'epubcfi(/6/4!/4/2)' }
  assert.equal(isCfiReadable('epubcfi(/6/4!/4/2/1:0)', progress), true)
  assert.equal(isCfiReadable('epubcfi(/6/8!/4/2/1:0)', progress), false)
  assert.match(describeProgress(progress, { bookTitle: '长夜', sectionCount: 12 }), /第 2 章「第二章」/)
  assert.match(describeProgress(null), /尚未/)
})

test('prompt: a ceiling the reader scrolled past is described with its own title', () => {
  const progress = {
    sectionIndex: 3,
    positionSectionIndex: 1,
    chapterTitle: '第二章 旧账',
    ceilingTitle: '第四章 未读的那一夜',
    sectionCount: 4,
  }
  const line = describeProgress(progress, { bookTitle: '站一会儿', sectionCount: 4 })
  assert.match(line, /第 4 章「第四章 未读的那一夜」/)
  assert.match(line, /现在停在第 2 章「第二章 旧账」/)
  assert.match(line, /可取范围 = 第 1 章至第 4 章/)
  // Without a stored ceiling title it must not borrow the position's, which
  // produced "已读到第 4 章「第二章 旧账」".
  const bare = describeProgress({ sectionIndex: 3, positionSectionIndex: 1, chapterTitle: '第二章 旧账' })
  assert.doesNotMatch(bare, /第 4 章「第二章 旧账」/)
  assert.match(bare, /第 4 章，现在停在第 2 章「第二章 旧账」/)
})

test('tokenize: cjk unigrams and bigrams, latin words', () => {
  const tokens = tokenize('光的折射 refracts the light 2024')
  assert.ok(tokens.includes('光'))
  assert.ok(tokens.includes('光的'))
  assert.ok(tokens.includes('折射'))
  assert.ok(tokens.includes('refracts'))
  assert.ok(tokens.includes('2024'))
  assert.deepEqual(tokenize(''), [])
})

test('chunkSection: chunks stay inside one chapter and keep offsets', () => {
  const text = Array.from({ length: 20 }, (_, i) => `第${i}句话说了一些内容，用来测试分块。`).join('')
  const chunks = chunkSection(text, 7, { targetChars: 60, maxChars: 120 })
  assert.ok(chunks.length > 2)
  for (const chunk of chunks) {
    assert.equal(chunk.sectionIndex, 7)
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text)
  }
  assert.equal(chunks[0].start, 0)
  assert.equal(chunks.at(-1).end, text.length)
})

test('splitSentences keeps terminators and clip collapses whitespace', () => {
  assert.deepEqual(splitSentences('一。二！三'), ['一。', '二！', '三'])
  assert.equal(clip('  a \n\n b ', 10), 'a b')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
  // Book text keeps its punctuation: clip is for display, not tokenisation.
  assert.equal(clip('老板只说，你去问他。', 40), '老板只说，你去问他。')
})

test('hybrid index: only the given candidates are scored', () => {
  const chunks = [
    { id: 'a', sectionIndex: 0, text: '光在同种均匀介质中沿直线传播。', cfi: 'epubcfi(/6/2!/4/2)' },
    { id: 'b', sectionIndex: 0, text: '影子是光被不透明物体遮挡形成的。' },
    { id: 'c', sectionIndex: 5, text: '光速在真空中约为每秒三十万公里，这是后文的伏笔。' },
  ]
  const all = new HybridIndex(chunks).search('光 传播', { limit: 3 })
  assert.ok(all.length >= 1)
  const readable = chunks.filter((chunk) => chunk.sectionIndex <= 0)
  const gated = new HybridIndex(readable).search('光 传播', { limit: 3 })
  assert.deepEqual(gated.map((hit) => hit.chunk.id).sort(), ['a', 'b'])
  assert.ok(gated.every((hit) => hit.chunk.id !== 'c'))
})

test('hybrid index: empty query and empty corpus are safe', () => {
  assert.deepEqual(new HybridIndex([]).search('光'), [])
  assert.deepEqual(new HybridIndex([{ id: 'a', sectionIndex: 0, text: 'x' }]).search('   '), [])
})

test('cards: every takeaway type yields an anchored card', () => {
  const base = {
    id: 't1',
    cfi: 'epubcfi(/6/4!/4/2/1:3)',
    chapterIndex: 1,
    userQuote: '为什么影子边缘是模糊的？',
    aiSummary: '因为光源不是点光源，半影区让边缘变软。讨论到这里停住了。',
    createdAt: 1700000000000,
  }
  for (const type of ['理解', '疑问', '联想', '评价']) {
    const cards = deriveCards({ ...base, type })
    assert.ok(cards.length >= 1 && cards.length <= 3, `${type} produced ${cards.length}`)
    for (const card of cards) {
      assert.equal(card.cfi, base.cfi)
      assert.equal(card.takeawayId, 't1')
      assert.ok(card.front.length > 0 && card.back.length > 0)
      assert.ok(card.id.startsWith('t1:'))
    }
  }
})

test('cards: derivation is idempotent and skips empty summaries', () => {
  const takeaway = {
    id: 't2', type: '理解', cfi: 'epubcfi(/6/2!/4/2)', chapterIndex: 0,
    userQuote: null, aiSummary: '折射率决定偏折程度。', createdAt: 1,
  }
  assert.deepEqual(deriveCards(takeaway), deriveCards(takeaway))
  assert.deepEqual(deriveCards({ ...takeaway, aiSummary: '   ' }), [])
})

test('cards: two questions about the same sentence do not read as one card', () => {
  const shared = {
    type: '疑问',
    cfi: 'epubcfi(/6/4!/4/2/1:3)',
    chapterIndex: 1,
    userQuote: '老板只说，你自己去问他。',
    createdAt: 1700000000000,
  }
  const first = deriveCards({ ...shared, id: 't1', aiSummary: '老板在替谁挡着——也许不是挡她。' })[0]
  const second = deriveCards({ ...shared, id: 't2', aiSummary: '这句是让她自己面对，还是把她推出去。' })[0]
  assert.notEqual(first.front, second.front)
  assert.ok(first.front.includes('你自己去问他'))
  assert.ok(first.front.includes('替谁挡'))
})

test('cards: takeaway ids are stable within a minute and vetting catches junk', () => {
  const input = { type: '理解', cfi: 'epubcfi(/6/2!/4/2)', aiSummary: 'x', createdAt: 1700000000000 }
  assert.equal(takeawayId(input), takeawayId({ ...input, createdAt: 1700000001000 }))
  assert.notEqual(takeawayId(input), takeawayId({ ...input, aiSummary: 'y' }))
  assert.equal(isTakeaway({ type: '理解', cfi: 'epubcfi(/6/2!/4)', aiSummary: 'x', chapterIndex: 0 }), true)
  assert.equal(isTakeaway({ type: '随便', cfi: 'epubcfi(/6/2!/4)', aiSummary: 'x', chapterIndex: 0 }), false)
  assert.equal(isTakeaway({ type: '理解', cfi: 'pct:20', aiSummary: 'x', chapterIndex: 0 }), false)
})

test('scheduler: first review schedules a day out, second a long gap', () => {
  const now = 1700000000000
  const first = applyReview({ interval: 0, factor: 2.5, repetitions: 0, dueAt: 0 }, QUALITY.got, now)
  assert.equal(first.interval, 1)
  assert.equal(first.dueAt, now + DAY)
  const second = applyReview(first, QUALITY.got, now + DAY)
  assert.equal(second.interval, 6)
  assert.ok(second.repetitions >= 1)
  const third = applyReview(second, QUALITY.got, now + 7 * DAY)
  assert.ok(third.interval > second.interval)
})

test('scheduler: a bad review resets the interval', () => {
  const now = 1700000000000
  const mature = { interval: 40, factor: 2.5, repetitions: 5, dueAt: now }
  const reset = applyReview(mature, 2, now)
  assert.equal(reset.interval, 1)
  assert.equal(reset.repetitions, 0)
})

test('scheduler: replay and retirement', () => {
  const now = 1700000000000
  const events = [
    { at: now, quality: 5 },
    { at: now + 2 * DAY, quality: 3 },
  ]
  const state = replay(events)
  assert.ok(state.dueAt > now + 2 * DAY)
  const retired = retire(state, now)
  assert.equal(retired.retired, true)
  assert.equal(dueCards([{ id: 'a', state: retired }], now + 30 * DAY).length, 0)
  assert.match(describeDue(retired), /收起/)
  assert.match(describeDue({ ...state, dueAt: now - 1 }), /现在/)
  assert.equal(dueCards([{ id: 'a', state: { ...state, dueAt: now - 1 } }], now).length, 1)
  assert.equal(dueCards([{ id: 'a', state: { ...state, dueAt: now - 1 } }, { id: 'b', state: { ...state, dueAt: now + 9 * DAY } }], now).length, 1)
  assert.equal(dueCards([{ id: 'a', state }], now).length, 0)
})
