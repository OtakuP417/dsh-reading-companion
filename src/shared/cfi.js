/**
 * EPUB CFI utilities — pure functions, no platform dependency.
 *
 * A CFI is the ONLY stable anchor this plugin uses for positions in a book.
 * Never percentages, never character indexes: both drift when the reader
 * changes font size, window width or device.
 *
 * Grammar handled here (the subset every real EPUB producer emits):
 *
 *   epubcfi(/6/4[chap01ref]!/4[body01]/10[p-5]/1:37)
 *   epubcfi(/6/4!/4/2,/1:0,/1:52)              ← range: parent, start, end
 *   epubcfi(/6/2[cover]!/4/2/2)
 *
 * Structure: a "path" is a list of steps; `/` steps are integers where even
 * numbers address element children (2 = first child, 4 = second, ...) and odd
 * numbers address text nodes / character positions. `[foo]` are assertions
 * (ids, mostly) and `:n` at the end of a path is a character offset. `!`
 * separates the package-document path from the path inside the content
 * document ("indirection").
 */

/** @typedef {{ index: number, id: string | null, isText: boolean }} CfiStep */
/** @typedef {{ paths: CfiStep[][], offset: number | null }} CfiSegment */
/**
 * @typedef {Object} ParsedCfi
 * @property {string} raw
 * @property {boolean} range
 * @property {CfiSegment} base
 * @property {CfiSegment | null} start
 * @property {CfiSegment | null} end
 */

const INTEGER = /^\d+$/

class CfiError extends Error {
  constructor(message, raw) {
    super(message)
    this.name = 'CfiError'
    this.cfi = raw
  }
}

/**
 * Split a string on a delimiter, ignoring delimiters inside `[...]` assertions.
 * @param {string} input
 * @param {string} delimiter
 * @returns {string[]}
 */
function splitTop(input, delimiter) {
  /** @type {string[]} */
  const out = []
  let depth = 0
  let current = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '[') depth++
    else if (ch === ']') depth = Math.max(0, depth - 1)
    if (ch === delimiter && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/**
 * Parse one step (`4[chap01]`).
 * @param {string} token
 * @param {string} raw
 * @returns {CfiStep}
 */
function parseStep(token, raw) {
  const match = /^(\d+)(?:\[([^\]]*)\])?$/.exec(token)
  if (match === null) {
    throw new CfiError(`invalid CFI step "${token}"`, raw)
  }
  const index = Number(match[1])
  return { index, id: match[2] ?? null, isText: index % 2 === 1 }
}

/**
 * Parse one path piece (`/4[body01]/10[p-5]`), optionally ending with `:offset`.
 * @param {string} piece
 * @param {string} raw
 * @returns {{ steps: CfiStep[], offset: number | null }}
 */
function parsePath(piece, raw) {
  let body = piece
  /** @type {number | null} */
  let offset = null
  const offsetMatch = /:(\d+)$/.exec(body)
  if (offsetMatch !== null && body.startsWith('/')) {
    offset = Number(offsetMatch[1])
    body = body.slice(0, offsetMatch.index)
  } else if (body.startsWith(':') && INTEGER.test(body.slice(1))) {
    // A relative range endpoint may be written as ":12" (bare text offset).
    offset = Number(body.slice(1))
    body = ''
  }
  /** @type {CfiStep[]} */
  const steps = []
  if (body.length > 0) {
    if (!body.startsWith('/')) throw new CfiError(`invalid CFI path "${piece}"`, raw)
    for (const token of body.split('/').slice(1)) {
      if (token.length === 0) continue
      steps.push(parseStep(token, raw))
    }
  }
  return { steps, offset }
}

/**
 * Parse one segment (comma-separated piece of the CFI). A segment may contain
 * one indirection (`!`) and therefore one or two paths.
 * @param {string} segment
 * @param {string} raw
 * @returns {CfiSegment}
 */
function parseSegment(segment, raw) {
  if (segment.length === 0) throw new CfiError('empty CFI segment', raw)
  /** @type {CfiStep[][]} */
  const paths = []
  let offset = null
  const pieces = splitTop(segment, '!')
  for (const piece of pieces) {
    const parsed = parsePath(piece, raw)
    if (parsed.steps.length > 0) paths.push(parsed.steps)
    if (parsed.offset !== null) offset = parsed.offset
  }
  if (paths.length === 0) throw new CfiError(`CFI segment has no steps: "${segment}"`, raw)
  return { paths, offset }
}

/**
 * Parse an `epubcfi(...)` string.
 * @param {string} cfi
 * @returns {ParsedCfi}
 */
export function parseCfi(cfi) {
  if (typeof cfi !== 'string') throw new CfiError('CFI must be a string', String(cfi))
  const trimmed = cfi.trim()
  const match = /^epubcfi\((.*)\)$/s.exec(trimmed)
  if (match === null) throw new CfiError(`not an epubcfi: "${trimmed.slice(0, 80)}"`, cfi)
  const inner = match[1]
  const segments = splitTop(inner, ',')
  if (segments.length !== 1 && segments.length !== 3) {
    throw new CfiError(`CFI must have 1 or 3 segments, got ${segments.length}`, cfi)
  }
  const base = parseSegment(segments[0], cfi)
  if (segments.length === 1) {
    return { raw: cfi, range: false, base, start: null, end: null }
  }
  return {
    raw: cfi,
    range: true,
    base,
    start: parseSegment(segments[1], cfi),
    end: parseSegment(segments[2], cfi),
  }
}

/**
 * True when the string looks like a CFI (cheap check for tool arguments).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCfi(value) {
  return typeof value === 'string' && /^epubcfi\(.+\)$/s.test(value.trim())
}

/**
 * Parse or return null instead of throwing — for untrusted input.
 * @param {unknown} value
 * @returns {ParsedCfi | null}
 */
export function tryParseCfi(value) {
  if (!isCfi(value)) return null
  try {
    return parseCfi(/** @type {string} */ (value))
  } catch {
    return null
  }
}

/**
 * Format a segment back to text.
 * @param {CfiSegment} segment
 * @returns {string}
 */
function formatSegment(segment) {
  return segment.paths
    .map((steps) => steps.map((step) => `/${step.index}`).join(''))
    .join('!') + (segment.offset !== null ? `:${segment.offset}` : '')
}

/**
 * Format a parsed CFI back to an `epubcfi(...)` string (assertions dropped:
 * they are identity hints, not coordinates).
 * @param {ParsedCfi} parsed
 * @returns {string}
 */
export function formatCfi(parsed) {
  const body = parsed.range
    ? `${formatSegment(parsed.base)},${formatSegment(parsed.start)},${formatSegment(parsed.end)}`
    : formatSegment(parsed.base)
  return `epubcfi(${body})`
}

/**
 * Normalised form for comparisons and de-duplication.
 * @param {string | ParsedCfi} input
 * @returns {string | null}
 */
export function normalizeCfi(input) {
  const parsed = typeof input === 'string' ? tryParseCfi(input) : input
  if (parsed === null) return null
  return formatCfi(parsed)
}

/**
 * The package-document steps of the base path (the part before `!`).
 * @param {ParsedCfi} parsed
 * @returns {CfiStep[]}
 */
export function packageSteps(parsed) {
  return parsed.base.paths[0] ?? []
}

/**
 * The steps inside the content document (the part after `!`), or the tail of
 * the package path when the CFI has no indirection.
 * @param {ParsedCfi} parsed
 * @returns {CfiStep[]}
 */
export function contentSteps(parsed) {
  const local = parsed.base.paths[1]
  if (local !== undefined) return local
  return (parsed.base.paths[0] ?? []).slice(2)
}

/**
 * Spine (reading-order) index addressed by a CFI, 0-based.
 *
 * `<spine>` is the third element child of `<package>` in the OPF, so the canon
 * path is `/6/2`, `/6/4`, … where the second step encodes `2 * (index + 1)`.
 * Foliate/EPUB.js section indexes use the same spine order, which is what makes
 * a CFI comparable with `progress.sectionIndex`.
 *
 * @param {string | ParsedCfi} input
 * @returns {number | null} null when the CFI cannot be attributed to a spine item
 */
export function spineIndexOf(input) {
  const parsed = typeof input === 'string' ? tryParseCfi(input) : input
  if (parsed === null) return null
  const steps = packageSteps(parsed)
  if (steps.length === 0) return null
  const spinePos = steps.findIndex((step) => step.index === 6)
  let itemref = null
  if (spinePos >= 0 && steps.length > spinePos + 1) {
    itemref = steps[spinePos + 1]
  } else if (steps.length >= 2) {
    itemref = steps[steps.length - 1]
  }
  if (itemref === null || itemref.isText) return null
  const index = itemref.index / 2 - 1
  return index >= 0 ? index : null
}

/**
 * Compare two step lists lexicographically.
 * @param {CfiStep[]} a
 * @param {CfiStep[]} b
 * @returns {number}
 */
function compareSteps(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a[i].index !== b[i].index) return a[i].index < b[i].index ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Compare two CFIs, both in the same book.
 * @param {string | ParsedCfi} left
 * @param {string | ParsedCfi} right
 * @returns {number | null} -1/0/1, or null when either side is unparsable
 */
export function compareCfi(left, right) {
  const a = typeof left === 'string' ? tryParseCfi(left) : left
  const b = typeof right === 'string' ? tryParseCfi(right) : right
  if (a === null || b === null) return null
  const sectionA = spineIndexOf(a)
  const sectionB = spineIndexOf(b)
  if (sectionA !== null && sectionB !== null && sectionA !== sectionB) {
    return sectionA < sectionB ? -1 : 1
  }
  const steps = compareSteps(contentSteps(a), contentSteps(b))
  if (steps !== 0) return steps
  const offsetA = a.base.offset ?? 0
  const offsetB = b.base.offset ?? 0
  if (offsetA === offsetB) return 0
  return offsetA < offsetB ? -1 : 1
}

/**
 * Sort key usable with `Array.prototype.sort` (CFI string ordering).
 * @param {string} cfi
 * @returns {string} a comparable string; unparsable CFIs sort last
 */
export function cfiSortKey(cfi) {
  const parsed = tryParseCfi(cfi)
  if (parsed === null) return '\uffff'
  const section = spineIndexOf(parsed) ?? 0
  const width = 10
  const spine = String(section).padStart(width, '0')
  const steps = contentSteps(parsed)
    .map((step) => String(step.index).padStart(width, '0'))
    .join('.')
  const offset = String(parsed.base.offset ?? 0).padStart(width, '0')
  return `${spine}|${steps}|${offset}`
}

/**
 * Build a minimal, valid CFI from a spine index and content steps.
 * Used when the plugin needs an anchor it did not receive from the reader.
 * @param {number} sectionIndex
 * @param {CfiStep[]} [steps]
 * @param {number | null} [offset]
 * @returns {string}
 */
export function buildCfi(sectionIndex, steps = [], offset = null) {
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) {
    throw new CfiError(`invalid section index: ${sectionIndex}`, '')
  }
  const spinePath = `/6/${2 * (sectionIndex + 1)}`
  const local = steps.map((step) => `/${step.index}`).join('')
  const suffix = offset !== null ? `:${offset}` : ''
  return `epubcfi(${spinePath}!${local || '/4'}${suffix})`
}

/**
 * Structural description used in logs, tool output and the model context.
 * @param {string} cfi
 * @returns {{ cfi: string, sectionIndex: number | null, offset: number | null, steps: number[] } | null}
 */
export function describeCfi(cfi) {
  const parsed = tryParseCfi(cfi)
  if (parsed === null) return null
  return {
    cfi: formatCfi(parsed),
    sectionIndex: spineIndexOf(parsed),
    offset: parsed.base.offset,
    steps: contentSteps(parsed).map((step) => step.index),
  }
}

export { CfiError }
