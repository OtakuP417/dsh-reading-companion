/**
 * The gate must be the first thing an unread anchor meets — before the
 * model-route check, before any text is assembled. This test mounts the real
 * HTTP handler with a stub library and asserts that ordering, plus the tool
 * path's own refusal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerRoutes } from '../src/host/routes.js'
import { registerTools } from '../src/host/tools.js'

const BOOK = { id: 'b1', title: '测试书', chapterCount: 4, sections: [{ index: 0, title: '一' }, { index: 1, title: '二' }] }

/** @param {string} method @param {string} url @param {unknown} [body] @param {Record<string,string>} [headers] */
function request(method, url, body, headers) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    on(event, handler) {
      if (event === 'data' && payload) handler(Buffer.from(payload))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  const res = {
    statusCode: 0,
    body: '',
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value
    },
    writeHead(status) {
      this.statusCode = status
      return this
    },
    end(chunk) {
      this.body = chunk ? String(chunk) : ''
    },
  }
  return { req, res }
}

function mount(progress) {
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: { register(route) { registered.push(route); return () => {} } },
    tools: { register(definition) { registered.push(definition); return () => {} } },
  }
  const library = {
    async list() { return [BOOK] },
    async meta(id) { return id === BOOK.id ? BOOK : null },
    async progress() { return progress },
  }
  const state = { activeBookId: BOOK.id, lastSelection: null }
  const config = {}
  const deps = {
    ctx,
    library,
    cache: { indexFor() { throw new Error('unread path must not build an index') } },
    summaries: { status() { return { generated: 0, total: 0, running: false } }, ensure() {} },
    config,
    state,
    persistActiveBook: async () => {},
  }
  const routes = registerRoutes(deps)
  return { routes, registered, state }
}

test('routes: an unread anchor is refused 403 even when no model route exists', async () => {
  const { routes } = mount({ sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 })
  const { req, res } = request('POST', '/__reading/ask', { sectionIndex: 3, question: '第四章写了什么？' })
  await routes.handler(req, res)
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`)
  assert.match(res.body, /进度门/)
  assert.doesNotMatch(res.body, /模型路由/)
})

test('routes: a readable anchor without a model route reports the model, not the gate', async () => {
  const { routes } = mount({ sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 })
  const { req, res } = request('POST', '/__reading/ask', { sectionIndex: 0, question: '信里写了什么？' })
  await routes.handler(req, res)
  assert.equal(res.statusCode, 503, `expected 503, got ${res.statusCode}: ${res.body}`)
  assert.match(res.body, /模型路由/)
})

test('routes: /note is refused for an unread cfi', async () => {
  const { routes } = mount({ sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 })
  const { req, res } = request('POST', '/__reading/note', { cfi: 'epubcfi(/6/8!/4/2/2:0)', text: 'x' })
  await routes.handler(req, res)
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`)
})

test('routes: asking without a selection falls back to where the reader is', async () => {
  // The panel advertises "不划线也可以问已读过的内容"; an empty anchor used to fail
  // closed as unknownTarget, which read to the reader as a bug.
  const { routes } = mount({ sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 })
  const { req, res } = request('POST', '/__reading/ask', { question: '这一章说了什么？' })
  await routes.handler(req, res)
  assert.equal(res.statusCode, 503, `expected 503 (no model route), got ${res.statusCode}: ${res.body}`)
  assert.match(res.body, /模型路由/)
})

test('routes: asking without a selection still fails closed when there is no progress', async () => {
  const { routes } = mount(null)
  const { req, res } = request('POST', '/__reading/ask', { question: '这一章说了什么？' })
  await routes.handler(req, res)
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.body}`)
  assert.match(res.body, /进度门/)
})

test('tools: read_text_window refuses an unread section and never touches the library', async () => {
  const registered = []
  const ctx = { tools: { register(definition) { registered.push(definition); return () => {} } } }
  const library = {
    async list() { return [BOOK] },
    async meta() { return BOOK },
    async progress() { return { sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 } },
    async textWindow() { throw new Error('library read must not happen for an unread section') },
  }
  const handle = registerTools({
    ctx,
    library,
    cache: { indexFor() { throw new Error('no index for unread') } },
    summaries: { ensure() {}, status() { return {} } },
    config: {},
    state: { activeBookId: BOOK.id, lastSelection: null },
  })
  const tool = registered.find((definition) => definition.name === 'read_text_window')
  assert.ok(tool, 'read_text_window must be registered')
  await assert.rejects(() => tool.execute({ sectionIndex: 3 }), (error) => {
    assert.equal(error.name, 'SpoilerGateError')
    assert.match(error.message, /进度门/)
    return true
  })
  handle.dispose()
})

test('takeaway: the anchor decides the chapter and an unread anchor is refused', async () => {
  const pushes = []
  const library = {
    async list() { return [BOOK] },
    async meta() { return BOOK },
    async progress() { return { sectionIndex: 1, positionSectionIndex: 1, sectionCount: 4 } },
    async takeaways() { return [] },
    async cards() { return [] },
    async reviews() { return [] },
    async addTakeaway(_bookId, record) { pushes.push(record); return { ...record, id: 'x1' } },
    async addCards() { return [] },
  }
  const routes = registerRoutes({
    ctx: { webServer: { register() { return () => {} } } },
    library,
    cache: {},
    summaries: { ensure() {}, status() { return {} } },
    config: {},
    state: { activeBookId: BOOK.id, lastSelection: null },
    persistActiveBook: async () => {},
  })

  const send = async (payload) => {
    const res = {
      statusCode: 0,
      headers: /** @type {Record<string, string>} */ ({}),
      body: '',
      setHeader(key, value) { this.headers[key] = value },
      end(value) { this.body = String(value ?? '') },
    }
    const req = { method: 'POST', url: '/__reading/takeaway', on() {}, destroy() {} }
    // Feed the body the way the handler reads it.
    const chunks = [Buffer.from(JSON.stringify(payload), 'utf8')]
    req.on = (event, listener) => {
      if (event === 'data') for (const chunk of chunks) queueMicrotask(() => listener(chunk))
      if (event === 'end') queueMicrotask(() => listener())
      return req
    }
    await routes.handler(req, res)
    return res
  }

  // Anchor contradicts the chapter number: refuse rather than pick one.
  const mismatch = await send({ bookId: BOOK.id, cfi: 'epubcfi(/6/8!/4/2/2:0)', chapterIndex: 1, aiSummary: '嗯' })
  assert.equal(mismatch.statusCode, 400, mismatch.body)

  // Unread anchor alone: the gate, not the caller's chapter number, decides.
  const unread = await send({ bookId: BOOK.id, cfi: 'epubcfi(/6/8!/4/2/2:0)', aiSummary: '嗯' })
  assert.equal(unread.statusCode, 403, unread.body)
  assert.equal(pushes.length, 0, 'nothing may be stored for an unread anchor')

  // Read anchor: stored, with the chapter taken from the CFI.
  const read = await send({ bookId: BOOK.id, cfi: 'epubcfi(/6/4!/4/2/2:0)', chapterIndex: 1, aiSummary: '她的停留像是拖延决定。' })
  assert.equal(read.statusCode, 200, read.body)
  assert.equal(pushes[0].chapterIndex, 1)
  assert.equal(pushes[0].cfi, 'epubcfi(/6/4!/4/2/2:0)')
})

test('import: a CJK file name arrives percent-encoded and is decoded once', async () => {
  const seen = []
  const library = {
    async list() { return [] },
    async meta() { return null },
    async importFile(bytes, options) {
      seen.push({ size: bytes.length, fileName: options?.fileName })
      return { id: 'b9', title: '灯下的约定', chapterCount: 1, format: 'epub', warnings: [] }
    },
  }
  const routes = registerRoutes({
    ctx: { webServer: { register() { return () => {} } } },
    library,
    cache: {},
    summaries: { ensure() {}, status() { return {} } },
    config: {},
    state: { activeBookId: null, lastSelection: null },
    persistActiveBook: async () => {},
  })

  const res = {
    statusCode: 0,
    headers: /** @type {Record<string, string>} */ ({}),
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = String(value ?? '') },
  }
  // fetch refuses to send a raw CJK header value at all, so the client
  // percent-encodes it; the host must undo exactly that.
  const header = encodeURIComponent('灯下的约定.epub')
  assert.equal(/^[\x20-\x7e]*$/.test(header), true, 'the header must stay ISO-8859-1')

  const chunks = [Buffer.from([0x50, 0x4b, 0x03, 0x04])]
  const req = {
    method: 'POST',
    url: '/__reading/import',
    headers: { 'content-type': 'application/epub+zip', 'x-file-name': header },
    destroy() {},
    on(event, listener) {
      if (event === 'data') for (const chunk of chunks) queueMicrotask(() => listener(chunk))
      if (event === 'end') queueMicrotask(() => listener())
      return req
    },
  }
  await routes.handler(req, res)
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(seen, [{ size: 4, fileName: '灯下的约定.epub' }])

  // A raw name (older client) or a broken escape still reaches the importer.
  const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const req2 = {
    ...req,
    headers: { 'content-type': 'application/epub+zip', 'x-file-name': 'book.epub' },
    on(event, listener) {
      if (event === 'data') queueMicrotask(() => listener(raw))
      if (event === 'end') queueMicrotask(() => listener())
      return req2
    },
  }
  const res2 = { ...res, statusCode: 0, body: '' }
  await routes.handler(req2, res2)
  assert.equal(res2.statusCode, 200, res2.body)
  assert.equal(seen[1].fileName, 'book.epub')
})
