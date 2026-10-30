/**
 * Mounts the whole Host half the way DSH does — with a fake ctx — and drives it
 * through its real entry points (HTTP handler, tool definitions, guard). The
 * point is not to re-test units: it is to prove that *every* way text can reach
 * the model is behind the progress gate, and that nothing beyond the reader's
 * ceiling is ever shown to the model even when it is asked for.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply } from '../src/index.js'
import { Store, writeJson } from '../src/host/store.js'

const BOOK = 'b1'
const SENTINEL = 'SPOILER-MARKER-ZZZ'

const SECTIONS = [
  { index: 0, title: '第一章 灯下的约定', text: '灯还亮着。她把那封信压在茶杯下面。信里只有两行字，字迹很急。' },
  { index: 1, title: '第二章 旧账', text: '第二天她去了城西那条街。老板只说，你自己去问他。她没有立刻走。' },
  { index: 2, title: '第三章 站一会儿', text: '她在门口站了一会儿，没有敲门。' },
  { index: 3, title: '第四章 未读的那一夜', text: `${SENTINEL} 账本最后一页写着与她自己相同的姓。` },
]

async function setup({ ceiling = 1, withModel = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'reading-plugin-'))
  const store = new Store({ root })
  await store.ensureLayout()
  await mkdir(store.bookDir(BOOK), { recursive: true })
  await writeJson(path.join(store.bookDir(BOOK), 'meta.json'), {
    id: BOOK,
    title: '站一会儿',
    chapterCount: SECTIONS.length,
    sections: SECTIONS.map(({ index, title, text }) => ({ index, title, chars: text.length })),
    importedAt: new Date().toISOString(),
  })
  await writeJson(path.join(store.bookDir(BOOK), 'sections.json'), SECTIONS.map((section) => ({ ...section })))
  await writeJson(store.progressPath(BOOK), {
    bookId: BOOK,
    cfi: 'epubcfi(/6/4!/4/2/2:0)',
    sectionIndex: ceiling,
    positionSectionIndex: ceiling,
    chapterTitle: SECTIONS[ceiling].title,
    sectionCount: SECTIONS.length,
    updatedAt: new Date().toISOString(),
  })

  /** Every message body sent to the model, for leak checks. */
  const prompts = []
  const registered = { tools: [], guard: null, routes: null, section: null }

  const services = {
    systemPrompt: {
      section(definition) {
        registered.section = definition
        return () => {}
      },
    },
    llm: {
      async *stream(options) {
        prompts.push(options.messages.map((message) => message.content.map((part) => part.text).join('')).join('\n---\n'))
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '你在柜台前停住的那一下，比问出口的话更说明问题。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agentDefaultModel: withModel ? { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) } : undefined,
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
      guard(guard) {
        registered.guard = guard
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registered.routes = route
        return () => {}
      },
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    // DSH exposes services both as direct properties and through get(); the
    // plugin uses both forms, so the fake must answer both.
    get tools() {
      return services.tools
    },
    get webServer() {
      return services.webServer
    },
    get llm() {
      return services.llm
    },
    get agentDefaultModel() {
      return services.agentDefaultModel
    },
    get(name) {
      return services[name]
    },
    inject(names, callback) {
      if (names.every((n) => services[n])) callback(ctx)
      return () => {}
    },
    effect(factory) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }

  apply(ctx, { dataDir: root })

  const handler = registered.routes?.handler
  assert.ok(handler, 'the plugin must register its HTTP route')

  /** @param {string} method @param {string} url @param {unknown} [body] */
  const request = async (method, url, body) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = {
      method,
      url,
      headers: { 'content-type': 'application/json' },
      on(event, fn) {
        if (event === 'data' && payload) fn(Buffer.from(payload))
        if (event === 'end') fn()
        return req
      },
      destroy() {},
    }
    const res = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(chunk) {
        this.body = chunk ? String(chunk) : ''
      },
    }
    await handler(req, res)
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
  }

  return { root, store, registered, prompts, request }
}

test('stage 2: an unread anchor is refused and the model is never called', async () => {
  const { request, prompts } = await setup({ ceiling: 1 })

  const refused = await request('POST', '/__reading/ask', {
    bookId: BOOK,
    sectionIndex: 3,
    quote: '账本最后一页',
    question: '第四章到底写了什么？',
  })
  assert.equal(refused.status, 403, `expected 403, got ${refused.status}: ${JSON.stringify(refused.json)}`)
  assert.equal(prompts.length, 0, 'no model call may happen for an unread anchor')
})

test('stage 2: a read anchor is answered from the injected window only', async () => {
  const { request, prompts } = await setup({ ceiling: 1 })

  const answered = await request('POST', '/__reading/ask', {
    bookId: BOOK,
    sectionIndex: 1,
    quote: '你自己去问他',
    question: '老板为什么不肯直说？',
  })
  assert.equal(answered.status, 200, `expected 200, got ${answered.status}: ${JSON.stringify(answered.json)}`)
  assert.ok(answered.json.reply.length > 0, 'the reply must reach the panel')
  assert.equal(prompts.length, 1)

  const prompt = prompts[0]
  assert.ok(prompt.includes('你自己去问他'), 'the injected window must contain the selected sentence')
  assert.ok(prompt.includes('第 1 章') || prompt.includes('第 2 章'), 'the summary index must name read chapters')
  assert.ok(!prompt.includes(SENTINEL), 'unread original text must never reach the model')
  assert.ok(!prompt.includes('账本最后一页'), 'unread text must not leak through retrieval either')
})

test('stage 2: chapter summaries are generated only up to the ceiling', async () => {
  const { request, prompts } = await setup({ ceiling: 1 })
  await request('POST', '/__reading/summaries', { bookId: BOOK })

  // Summary generation is deliberately non-blocking, so wait for it to land.
  for (let i = 0; i < 40 && prompts.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(prompts.length >= 1, 'the summary pass must call the model for read chapters')
  for (const prompt of prompts) {
    assert.ok(!prompt.includes(SENTINEL), 'a summary prompt must never contain unread text')
    assert.ok(!prompt.includes('账本最后一页'), 'unread chapters must have no summary material')
  }
})

test('stage 2: the synchronous guard refuses an unread tool call before it runs', async () => {
  const { registered } = await setup({ ceiling: 1 })
  assert.ok(typeof registered.guard === 'function', 'the plugin must install a tool guard')

  const refusal = registered.guard({ name: 'read_text_window', arguments: { sectionIndex: 3 } })
  assert.equal(typeof refusal, 'string', 'a denial is a refusal string')
  assert.match(refusal, /拒绝|进度/)

  const allowed = registered.guard({ name: 'read_text_window', arguments: { sectionIndex: 1 } })
  assert.equal(allowed, undefined, 'a read-range call must pass the guard')
})

test('stage 3: a takeaway is stored, carded, and closable with no model call', async () => {
  const { request, registered } = await setup({ ceiling: 1 })

  const save = registered.tools.find((tool) => tool.name === 'save_takeaway')
  assert.ok(save, 'save_takeaway must be registered')
  const text = await save.execute({
    type: '理解',
    sectionIndex: 1,
    cfi: 'epubcfi(/6/4!/4/2/2:60)',
    userQuote: '你自己去问他',
    aiSummary: '她其实早就知道那笔账和她有关，只是还在等一个不必开口的答案。',
  })
  assert.match(text, /已存下一条「理解」收获/)
  assert.match(text, /复习卡片/)

  const listed = await request('GET', '/__reading/state')
  assert.equal(listed.status, 200)
  assert.ok(listed.json.takeaways.length >= 1, 'the takeaway must be queryable through the panel snapshot')
  assert.ok(listed.json.cards.length >= 1, 'a takeaway must yield at least one card')
  const card = listed.json.cards[0]
  assert.ok(card.cardId, 'cards carry their id')
  assert.match(card.cfi, /^epubcfi\(/, 'a card keeps its CFI anchor for one-click jump')

  const closing = await request('POST', '/__reading/closing', { bookId: BOOK, sectionIndex: 1 })
  assert.equal(closing.status, 200)
  assert.ok(closing.json.text.length > 0)
})

test('stage 4: review schedules with the model disconnected', async () => {
  const { request, registered } = await setup({ ceiling: 1 })
  const save = registered.tools.find((tool) => tool.name === 'save_takeaway')
  await save.execute({ type: '疑问', sectionIndex: 1, aiSummary: '老板那句"你自己去问他"，是不是也在替她父亲保留体面？' })

  const before = await request('GET', '/__reading/state')
  const card = before.json.cards[0]
  assert.equal(card.schedule.due, true, 'a fresh card is due now')

  const reviewed = await request('POST', '/__reading/review', { bookId: BOOK, cardId: card.cardId, outcome: 'settled' })
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json))
  const after = reviewed.json.cards.find((item) => item.cardId === card.cardId)
  assert.equal(after.schedule.repetitions, 1)
  assert.equal(after.schedule.due, false, 'a reviewed card is scheduled forward')
  assert.ok(after.schedule.label.length > 0)
})

test('stage 4: a model rewrite is opt-in, and review still works without a model', async () => {
  const withModel = await setup({ ceiling: 1 })
  const save = withModel.registered.tools.find((tool) => tool.name === 'save_takeaway')
  await save.execute({ type: '联想', sectionIndex: 1, aiSummary: '她"没有立刻走"，让我想到自己有时也靠停留拖延决定。' })
  const state = await withModel.request('GET', '/__reading/state')
  const card = state.json.cards[0]
  const rewrite = await withModel.request('POST', '/__reading/rephrase', { bookId: BOOK, cardId: card.cardId, mode: 'split' })
  assert.equal(rewrite.status, 200, JSON.stringify(rewrite.json))
  assert.ok(rewrite.json.text.length > 0)

  // Same book, no model route at all: the rewrite degrades, review does not.
  const offline = await setup({ ceiling: 1, withModel: false })
  const saveOffline = offline.registered.tools.find((tool) => tool.name === 'save_takeaway')
  await saveOffline.execute({ type: '联想', sectionIndex: 1, aiSummary: '她"没有立刻走"，让我想到自己有时也靠停留拖延决定。' })
  const offlineState = await offline.request('GET', '/__reading/state')
  const offlineCard = offlineState.json.cards[0]
  assert.ok(offlineCard, 'cards must still be derived without a model')
  const degraded = await offline.request('POST', '/__reading/rephrase', { bookId: BOOK, cardId: offlineCard.cardId, mode: 'rephrase' })
  assert.equal(degraded.status, 200)
  assert.equal(degraded.json.modelFree, true)
  assert.match(degraded.json.note, /模型路由/)

  const reviewed = await offline.request('POST', '/__reading/review', { bookId: BOOK, cardId: offlineCard.cardId, outcome: 'got' })
  assert.equal(reviewed.status, 200)
  assert.equal(reviewed.json.cards[0].schedule.repetitions, 1)
})
