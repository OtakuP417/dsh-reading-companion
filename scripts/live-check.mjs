// Live acceptance run against a real DSH host that has this bundle installed.
//
// It drives the plugin over its own HTTP surface, which is the same code the
// client half calls, so it exercises the gate, the guidance, takeaways, cards
// and scheduling end to end — with real model calls when the host has a route.
//
// Preconditions: `samples/test-book.epub` is imported and the reader's progress
// sits on chapter 2 (sectionIndex 1). See docs/verification.md.
//
//   READING_BASE=http://127.0.0.1:35933 READING_COOKIE=/path/to/cookie.txt \
//     node scripts/live-check.mjs
import { readFileSync } from 'node:fs'

const base = `${process.env.READING_BASE ?? 'http://127.0.0.1:35933'}/__reading`
const cookiePath = process.env.READING_COOKIE ?? 'C:/Users/Furina/AppData/Local/Temp/dsh-cookie.txt'
const cookie = readFileSync(cookiePath, 'utf8').trim()
const BOOK = process.env.READING_BOOK ?? '站一会儿-771e7cbb'
const READ = process.env.READING_READ_CFI ?? 'epubcfi(/6/4!/4/2/2:0)'
const UNREAD = process.env.READING_UNREAD_CFI ?? 'epubcfi(/6/8!/4/2/2:0)'

async function call(method, path, body) {
  const init = { method, headers: { cookie } }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(base + path, init)
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: response.status, json, text }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// ---- stage 2: the gate, then discussion -----------------------------------
const unread = await call('POST', '/ask', { bookId: BOOK, cfi: UNREAD, sectionIndex: 3, question: '账本最后一页写的是谁的名字？' })
check('unread /ask refused with 403', unread.status === 403, unread.json?.error ?? unread.text.slice(0, 80))
check('unread refusal names no unread content', !/SPOILER|姓|账本最后一页写着/.test(unread.text), '')

const read = await call('POST', '/ask', { bookId: BOOK, cfi: READ, sectionIndex: 1, quote: '老板只说，你自己去问他。', question: '老板为什么不肯把话说清楚？他是在护着谁吗？' })
const reply = read.json?.reply ?? ''
check('read /ask answered', read.status === 200 && reply.length > 20, `${read.status} ${reply.slice(0, 40)}`)
check('answer is grounded in the injected window', read.json?.usedWindow === true, JSON.stringify(read.json?.sections))
check('answer asks something back', /[？?]/.test(reply), '')
check('answer never leaks chapter four', !/SPOILER|账本最后一页|姓是一样的/.test(reply), '')

// ---- stage 3: takeaways ---------------------------------------------------
const unreadTakeaway = await call('POST', '/takeaway', { bookId: BOOK, cfi: UNREAD, aiSummary: '不该存进去。' })
check('unread takeaway refused', unreadTakeaway.status === 403, unreadTakeaway.json?.error ?? '')

const mismatch = await call('POST', '/takeaway', { bookId: BOOK, cfi: UNREAD, chapterIndex: 1, aiSummary: '不该存进去。' })
check('anchor/chapter mismatch refused', mismatch.status === 400, mismatch.json?.error ?? '')

const takeaway = await call('POST', '/takeaway', {
  bookId: BOOK,
  type: '疑问',
  cfi: READ,
  chapterIndex: 1,
  userQuote: '老板只说，你自己去问他。',
  aiSummary: '老板替谁挡着——也许不是挡她，是替她父亲挡。',
})
check('read takeaway stored', takeaway.status === 200 && Boolean(takeaway.json?.takeaway?.id), takeaway.json?.error ?? '')
const takeawayId = takeaway.json?.takeaway?.id

const closing = await call('POST', '/closing', { bookId: BOOK, sectionIndex: 1 })
const closingText = closing.json?.text ?? closing.json?.error ?? ''
check('chapter closing produced', closing.status === 200 && closingText.length > 10, closingText.slice(0, 60))
check('closing stays in the reader\'s own terms', !/SPOILER|账本最后一页/.test(closingText), '')

// ---- stage 4: cards, scheduling, opt-in model help ------------------------
const cards = await call('GET', `/cards?bookId=${encodeURIComponent(BOOK)}`)
const list = cards.json?.cards ?? []
check('cards derived from the takeaway', list.length >= 1 && list.length <= 6, `${list.length} cards`)
check('every card has a real id', list.every((card) => card.cardId && !card.cardId.includes('undefined')), list.map((c) => c.cardId).join(','))
check('every card carries a CFI', list.every((card) => typeof card.cfi === 'string' && card.cfi.startsWith('epubcfi(')), '')

const first = list[0]
const reviewed = await call('POST', '/review', { bookId: BOOK, cardId: first.cardId, outcome: 'got' })
check('review advances the schedule', reviewed.status === 200 && (reviewed.json?.cards?.find((c) => c.cardId === first.cardId)?.schedule?.repetitions ?? 0) >= 1, '')

const rephrase = await call('POST', '/rephrase', { bookId: BOOK, cardId: first.cardId, mode: 'split' })
check('model rewrite works on request', rephrase.status === 200 && (rephrase.json?.text ?? '').length > 0, (rephrase.json?.text ?? rephrase.json?.note ?? '').slice(0, 60))

// ---- stage 2 part one: summaries only up to the reader's chapter ----------
await call('POST', '/summaries', { bookId: BOOK })
let summaryState = null
for (let attempt = 0; attempt < 20; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const state = await call('GET', '/state')
  summaryState = state.json?.summaries
  const pending = summaryState?.pending?.length ?? 0
  if (pending === 0 && (summaryState?.done?.length ?? 0) >= 2) break
}
const done = (summaryState?.done ?? []).map((item) => (typeof item === 'number' ? item : item?.sectionIndex))
check('summaries generated for read chapters', done.includes(0) && done.includes(1), JSON.stringify(done))
check('no summary exists for an unread chapter', !done.includes(2) && !done.includes(3), JSON.stringify(done))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
