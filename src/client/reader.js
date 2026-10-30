/**
 * foliate-js wiring.
 *
 * Kept in one class so the React layer never touches foliate's internals: it
 * opens a book, restores a CFI, reports relocations, and turns a DOM selection
 * into a CFI. Everything CFI-shaped comes from foliate's own toolchain — the
 * plugin never invents a position, which is the whole point of anchoring to CFI
 * instead of a percentage.
 */

import { makeBook, View } from '../../vendor/foliate-js/view.js'
import { Overlayer } from '../../vendor/foliate-js/overlayer.js'
import { spineIndexOf } from '../shared/cfi.js'

let defined = false
function ensureDefined() {
  if (defined) return
  if (!customElements.get('foliate-view')) customElements.define('foliate-view', View)
  defined = true
}

export class Reader {
  /** @param {HTMLElement} host */
  constructor(host) {
    ensureDefined()
    this.host = host
    this.view = null
    this.book = null
    /** @type {Set<string>} */
    this.highlighted = new Set()
    this.fontSize = 18
    this.ready = false
    this.resizeObserver = null
    this.layoutKey = null
  }

  /**
   * @param {string} url
   * @param {{ cfi?: string | null, onRelocate?: (detail: any) => void, onSelection?: (payload: any) => void, onError?: (error: Error) => void }} options
   */
  async open(url, options = {}) {
    this.destroy()
    const view = new View()
    view.style.display = 'block'
    view.style.width = '100%'
    view.style.height = '100%'
    this.host.textContent = ''
    this.host.appendChild(view)
    this.view = view

    view.addEventListener('relocate', (event) => {
      const detail = event.detail
      options.onRelocate?.({
        cfi: detail.cfi,
        sectionIndex: typeof detail.section?.current === 'number' ? detail.section.current : null,
        fraction: detail.fraction ?? null,
        label: detail.tocItem?.label ?? null,
      })
    })

    view.addEventListener('load', (event) => {
      const { doc, index } = event.detail
      this.#attachSelection(doc, index, options.onSelection)
    })

    view.addEventListener('draw-annotation', (event) => {
      const { draw } = event.detail
      draw(Overlayer.highlight, { color: '#e9c46a', padding: 2 })
    })

    try {
      const book = await makeBook(url)
      this.book = book
      await view.open(book)
      this.#applyLayout()
      this.#watchWidth()
      this.applyFontSize(this.fontSize)
      const location = options.cfi ?? null
      await view.init({ lastLocation: location, showTextStart: !location })
      this.ready = true
      if (location) await view.goTo(location).catch(() => {})
      return book
    } catch (error) {
      this.ready = false
      options.onError?.(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  /** @param {Document} doc @param {number} index @param {(payload: any) => void} [onSelection] */
  #attachSelection(doc, index, onSelection) {
    if (!onSelection) return
    const report = () => {
      const selection = doc.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
      const quote = selection.toString().trim()
      if (quote.length === 0) return
      const range = selection.getRangeAt(0)
      let cfi = null
      try {
        cfi = this.view?.getCFI(index, range) ?? null
      } catch {
        cfi = null
      }
      onSelection({ cfi, sectionIndex: index, quote: quote.slice(0, 1200), rect: range.getBoundingClientRect?.() ?? null })
    }
    doc.addEventListener('mouseup', () => window.setTimeout(report, 0))
    doc.addEventListener('touchend', () => window.setTimeout(report, 0))
  }

  /**
   * foliate's paginator divides the page into `ceil(container / max-inline-size)`
   * columns, and the container itself may grow to `max-inline-size × max-column-count`.
   * With the shipped defaults (720px × 2) a ~900px panel turns into two ~330px
   * columns, so a short chapter fills one column and leaves the other blank —
   * which reads as "too much empty space". Keep a single column and let it use
   * the panel width, and only split in two when the panel is genuinely wide.
   */
  #applyLayout() {
    const renderer = this.view?.renderer
    if (!renderer || typeof renderer.setAttribute !== 'function') return
    const width = Math.round(this.host.clientWidth || this.host.getBoundingClientRect?.().width || 0)
    if (width <= 0) return
    const columns = width >= 1300 ? 2 : 1
    const inline = columns === 2 ? 640 : Math.max(480, Math.min(780, width - 8))
    const key = `${columns}:${Math.round(inline / 20) * 20}`
    if (key === this.layoutKey) return
    this.layoutKey = key
    try {
      renderer.setAttribute('max-column-count', String(columns))
      renderer.setAttribute('max-inline-size', `${Math.round(inline / 20) * 20}px`)
      renderer.setAttribute('gap', '5%')
      renderer.setAttribute('margin', '36px')
    } catch {
      // a renderer that does not accept these attributes keeps foliate's defaults
    }
  }

  #watchWidth() {
    if (this.resizeObserver || typeof ResizeObserver === 'undefined') return
    let timer = null
    this.resizeObserver = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => this.#applyLayout(), 140)
    })
    this.resizeObserver.observe(this.host)
  }

  /** @param {number} size */
  applyFontSize(size) {
    this.fontSize = size
    const css = `html { font-size: ${size}px } body { line-height: 1.75 }`
    try {
      this.view?.renderer?.setStyles(['', css])
    } catch {
      // a renderer without setStyles (fixed layout) simply keeps its own type
    }
  }

  /**
   * Jump to an anchor. A CFI is tried first (it is the real coordinate); when
   * foliate cannot resolve it — an older book file, a hand-built section CFI —
   * the spine index inside the CFI is still a correct fallback, and a stale
   * anchor must never break the panel.
   * @param {string} cfi
   */
  async goTo(cfi) {
    if (!this.view || !this.ready) return
    try {
      await this.view.goTo(cfi)
      return
    } catch {
      // fall through to the chapter
    }
    const section = spineIndexOf(cfi)
    if (section !== null) {
      try {
        await this.view.goTo(section)
      } catch {
        // unparsable/stale anchor: stay where the reader is
      }
    }
  }

  async next() {
    await this.view?.next?.()
  }

  async prev() {
    await this.view?.prev?.()
  }

  /**
   * Draw every stored highlight, and keep drawing them across re-layout.
   * @param {{ cfi: string }[]} notes
   */
  async showHighlights(notes) {
    if (!this.view) return
    for (const note of notes) {
      if (!note?.cfi || this.highlighted.has(note.cfi)) continue
      this.highlighted.add(note.cfi)
      try {
        await this.view.addAnnotation({ value: note.cfi })
      } catch {
        this.highlighted.delete(note.cfi)
      }
    }
  }

  destroy() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.layoutKey = null
    if (this.view) {
      try {
        this.view.remove()
      } catch {
        // already gone
      }
    }
    this.view = null
    this.book = null
    this.highlighted.clear()
    this.ready = false
    this.host.textContent = ''
  }
}
