// Smoke-test the BUILT bundle (lib/index.js) with a fake host context.
//
// This is the last line of defence before shipping: the unit tests import the
// sources, and the live harness talks to a real host, but neither proves that
// the artifact esbuild produced still contains the gate. This script loads the
// artifact, mounts it, and runs the two things that must never regress —
// the read-through gate and a model-free review loop.
//
//   node scripts/verify-bundle.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dataDir = mkdtempSync(join(tmpdir(), 'reading-bundle-'))
const plugin = await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const tools = new Map()
const listeners = []
const services = {
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) }, guard: (fn) => { listeners.push(fn); return () => {} } },
  systemPrompt: { section: () => () => {} },
  llm: { stream: async function* () { yield { type: 'text-delta', text: '（这是假的模型回答）' }; yield { type: 'finish', reason: { kind: 'stop' } } } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
}

const ctx = {
  get: (name) => services[name],
  reflect: { get: (name) => services[name] },
  inject: (names, callback) => {
    const scope = expose({
      get: (name) => services[name],
      effect: (factory) => { const dispose = factory(); return () => dispose?.() },
    })
    callback(scope)
  },
  effect: (factory) => { const dispose = factory(); return () => dispose?.() },
  on: () => () => {},
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}

let handler = null
services.webServer = { register: (route) => { handler = route.handler; return () => { handler = null } } }

// A real cordis context exposes every service as a property as well as through
// get()/reflect.get(); the plugin may use either, so the fakes must too.
function expose(target) {
  for (const name of Object.keys(services)) {
    Object.defineProperty(target, name, { get: () => services[name], configurable: true })
  }
  return target
}
expose(ctx)

plugin.apply(ctx, { dataDir })
check('bundle exports apply()', typeof plugin.apply === 'function')
check('bundle registered the tools', tools.size >= 8, `${tools.size} tools`)

// The plugin keeps no book yet: every gated tool must fail closed, not open.
const window = tools.get('read_text_window')
let refused = null
try {
  await window.execute({ sectionIndex: 3 }, { name: 'read_text_window', arguments: { sectionIndex: 3 } })
} catch (error) {
  refused = error
}
// With no book on the shelf the tool cannot read anything either: refusing is
// the only acceptable answer, and the text must not be a spoiler.
check('gated tool refuses with no progress', Boolean(refused) && !/SPOILER/.test(String(refused?.message ?? refused)), String(refused?.message ?? refused).slice(0, 80))

const guardRefusal = listeners[0]?.({ name: 'read_text_window', arguments: { sectionIndex: 3 } })
check('guard denies an unread target synchronously', typeof guardRefusal === 'string' && guardRefusal.length > 0, String(guardRefusal ?? '').slice(0, 60))

const allowed = listeners[0]?.({ name: 'reading_progress', arguments: {} })
check('guard lets an ungated tool through', allowed === undefined)

// The HTTP handler must exist and answer, so the client half has a channel.
check('webServer route registered', typeof handler === 'function')
const fakeResponse = () => {
  const chunks = []
  return { statusCode: 0, headers: {}, setHeader() {}, end(value) { chunks.push(String(value ?? '')) }, json() { return JSON.parse(chunks.join('')) } }
}
const response = fakeResponse()
await handler({ url: '/__reading/state', method: 'GET', headers: {}, on() {} }, response)
check('GET /state answers', response.statusCode === 200 && response.json().ok === true, String(response.statusCode))

// ---- a whole reading loop through the built artifact ----------------------
// Sources are covered by the unit tests and the live harness covers a real
// host; this closes the gap in between: the artifact must still read an EPUB,
// gate on progress, and derive distinguishable cards.
function fakeRequest(url, method, body, headers = {}) {
  const buffer = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  const handlers = { data: [], end: [], error: [] }
  const req = {
    url,
    method,
    headers,
    on(event, callback) {
      if (!handlers[event]) handlers[event] = []
      handlers[event].push(callback)
      if (event === 'end') {
        queueMicrotask(() => {
          if (buffer) for (const notify of handlers.data) notify(buffer)
          for (const notify of handlers.end) notify()
        })
      }
      return req
    },
    destroy() {},
  }
  return req
}

async function call(method, path, body, headers) {
  const res = fakeResponse()
  await handler(fakeRequest(`/__reading${path}`, method, body, headers), res)
  return res
}

const epubPath = process.env.READING_EPUB ?? join(import.meta.dirname, '..', '..', 'samples', 'test-book.epub')
if (existsSync(epubPath)) {
  const imported = await call('POST', '/import', readFileSync(epubPath), { 'x-file-name': 'test-book.epub' })
  const bookId = imported.json()?.bookId
  check('built artifact imports an EPUB', imported.statusCode === 200 && typeof bookId === 'string', String(bookId))

  const progressed = await call('POST', '/progress', { bookId, cfi: 'epubcfi(/6/4!/4/2/2:0)', positionSectionIndex: 1, chapterTitle: '第二章' })
  check('progress advances the read-through ceiling', progressed.json()?.progress?.sectionIndex === 1, JSON.stringify(progressed.json()?.progress?.sectionIndex))

  const quote = '老板只说，你自己去问他。'
  const takeaway = async (summary) => (await call('POST', '/takeaway', { bookId, type: '疑问', cfi: 'epubcfi(/6/4!/4/2/2:0)', userQuote: quote, aiSummary: summary })).json()
  await takeaway('老板在替谁挡着——也许不是挡她。')
  await takeaway('这句是让她自己面对，还是把她推出去。')

  const cards = (await call('GET', `/cards?bookId=${encodeURIComponent(bookId)}`)).json()?.cards ?? []
  check('two takeaways become two cards', cards.length === 2, `${cards.length} cards`)
  check('their fronts differ', new Set(cards.map((card) => card.front)).size === cards.length, cards.map((card) => card.front).join(' | ').slice(0, 90))
  check('the reader\'s own question is on the front', cards.every((card) => card.front.includes(quote.slice(0, 6)) && card.front.includes('——')))
} else {
  console.log(`SKIP  epub fixture not found at ${epubPath}`)
}

rmSync(dataDir, { recursive: true, force: true })
const failed = checks.filter((entry) => !entry.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
