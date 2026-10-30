/**
 * Client-bundle smoke test.
 *
 * A throwing component blanks its whole slot entry, so the cheapest way to
 * catch that failure mode without a browser is to execute the BUILT bundle the
 * way the module loader does — factory with a `require` — and render what it
 * registers. It cannot prove the panel looks right; it proves the panel mounts.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToString } from 'react-dom/server'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8')

// The bundle expects the loader's environment: a `window`, a module factory
// hook, and a document it may add one <style> to.
const registrations = []
const styles = []
let factory = null
const window = {
  __ModuleLoader__: {
    load({ id, factory: component }) {
      registrations.push(id)
      factory = component
    },
  },
}
const document = {
  getElementById: () => null,
  createElement: () => ({ set textContent(value) { styles.push(value) }, id: '' }),
  head: { appendChild: () => {} },
}
globalThis.window = window
globalThis.document = document
// The reader half of the bundle evaluates DOM constants at module scope; the
// smoke test only needs the module graph to load, not those nodes to exist.
globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4, SHOW_CDATA_SECTION: 8 }
globalThis.HTMLElement = class {}
globalThis.customElements = { define: () => {}, get: () => undefined }
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 0))

new Function('window', 'document', source)(window, document)

assert.equal(registrations.length, 1, 'the bundle registers exactly one module')
assert.ok(factory, 'the module factory was captured')

const exportsObject = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
assert.equal(typeof exportsObject.apply, 'function', 'the module exports apply()')
assert.ok(exportsObject.inject.includes('slots'), 'it injects the slot service')

const seats = []
const ctx = {
  locale: {
    register: () => {},
    bind: () => (key) => key,
    getLanguage: () => 'zh',
  },
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      seats.push({ options, component })
      return () => {}
    },
  },
  effect: (fn) => fn(),
}
exportsObject.apply(ctx)

const byName = (name) => seats.find((seat) => seat.options.name === name)
assert.ok(byName('sidebar.panellist'), 'a sidebar rail row is registered')
assert.ok(byName('main'), 'the main-column page is registered')
assert.equal(byName('main').options.key, byName('sidebar.panellist').options.id, 'the row and the page share one id')
assert.equal(typeof byName('sidebar.panellist').options.label, 'function')

const icon = renderToString(React.createElement(byName('sidebar.panellist').component, { size: 16 }))
assert.match(icon, /^<svg/, 'the rail row renders an svg glyph')

const page = renderToString(React.createElement(byName('main').component, {}))
assert.match(page, /把一本书拖进来/, 'the page renders its empty state')
assert.ok(page.length > 400, 'the page has real markup')
assert.ok(styles.length > 0 && /--dsw-alias-/.test(styles.join('')), 'styling goes through theme tokens')

console.log(`client bundle: ${registrations[0]} — 1 module, 2 seats, icon + page render, ${styles[0].length} bytes of css`)
console.log('client smoke: PASS')
