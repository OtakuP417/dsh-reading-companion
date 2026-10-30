/**
 * Tokenisation and hybrid scoring for the progress-aware retrieval arm.
 *
 * Everything here is pure and synchronous so that it can run inside the tool
 * call with no network. Chinese has no spaces, so a whitespace tokenizer
 * throws away most of the signal: we emit CJK unigrams *and* bigrams, plus
 * latin/digit words. The vector arm is a deterministic hashed feature vector
 * over the same tokens (optionally replaced by a real embedding that the host
 * attaches to each chunk), so hybrid scoring degrades gracefully offline.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
const WORD = /[a-z0-9]+(?:['’-][a-z0-9]+)*/g
const NOISE = /[\s\p{P}\p{S}]+/u

/**
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return text.normalize('NFKC').toLowerCase()
}

/**
 * Tokenise a passage.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const normalized = normalizeText(text)
  /** @type {string[]} */
  const tokens = []
  for (const match of normalized.matchAll(WORD)) {
    tokens.push(match[0])
  }
  // CJK runs: unigram + bigram.
  let run = ''
  const flush = () => {
    if (run.length === 0) return
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
    run = ''
  }
  for (const ch of normalized) {
    if (CJK.test(ch)) {
      run += ch
    } else {
      flush()
    }
  }
  flush()
  return tokens
}

/**
 * Sentence-ish split used by the chunker. Keeps the terminator with the
 * sentence so offsets stay exact.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  /** @type {string[]} */
  const sentences = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    current += ch
    const ends = ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '…' ||
      ch === '!' || ch === '?' || ch === ';' || ch === '\n' ||
      (ch === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1])))
    if (ends) {
      if (current.trim().length > 0) sentences.push(current)
      current = ''
    }
  }
  if (current.trim().length > 0) sentences.push(current)
  return sentences
}

/**
 * Split one chapter into retrieval chunks whose boundaries follow sentences.
 * Chunks never cross a chapter boundary: a chunk belongs to exactly one
 * `sectionIndex`, which is what makes the progress filter exact.
 *
 * @param {string} text            raw chapter text (offsets are into this string)
 * @param {number} sectionIndex
 * @param {{ targetChars?: number, maxChars?: number, overlapSentences?: number, cfi?: string }} [options]
 * @returns {{ id: string, sectionIndex: number, start: number, end: number, text: string }[]}
 */
export function chunkSection(text, sectionIndex, options = {}) {
  const target = options.targetChars ?? 420
  const max = options.maxChars ?? 900
  const sentences = splitSentences(text)
  /** @type {{ text: string, start: number }[]} */
  const withOffsets = []
  let cursor = 0
  for (const sentence of sentences) {
    withOffsets.push({ text: sentence, start: cursor })
    cursor += sentence.length
  }
  /** @type {{ id: string, sectionIndex: number, start: number, end: number, text: string }[]} */
  const chunks = []
  let buffer = ''
  let bufferStart = -1
  let index = 0
  const flush = () => {
    if (buffer.trim().length === 0) {
      buffer = ''
      bufferStart = -1
      return
    }
    chunks.push({
      id: `s${sectionIndex}c${index}`,
      sectionIndex,
      start: bufferStart,
      end: bufferStart + buffer.length,
      text: buffer,
    })
    index++
    buffer = ''
    bufferStart = -1
  }
  for (const sentence of withOffsets) {
    if (buffer.length > 0 && buffer.length + sentence.text.length > target) flush()
    if (bufferStart < 0) bufferStart = sentence.start
    buffer += sentence.text
    if (buffer.length >= max) flush()
  }
  flush()
  return chunks
}

/**
 * Deterministic hashed vector for the offline semantic arm (feature hashing).
 * @param {string[]} tokens
 * @param {number} [dim]
 * @returns {Float64Array}
 */
export function hashVector(tokens, dim = 512) {
  const vector = new Float64Array(dim)
  for (const token of tokens) {
    let hash = 2166136261
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    const bucket = (hash >>> 0) % dim
    vector[bucket] += 1
  }
  let norm = 0
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dim; i++) vector[i] /= norm
  return vector
}

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} cosine similarity in [0, 1] (negative clamped)
 */
export function cosine(a, b) {
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i++) dot += a[i] * b[i]
  return dot > 0 ? Math.min(1, dot) : 0
}

const K1 = 1.2
const B = 0.75

/**
 * An in-memory BM25 + vector index over one book's chunks.
 * The index is rebuilt from `chunks.json`; it never holds unread text at query
 * time because the caller filters the candidate list first.
 */
export class HybridIndex {
  /**
   * @param {{ id: string, sectionIndex: number, text: string, cfi?: string | null, embedding?: number[] | null }[]} chunks
   * @param {{ dim?: number }} [options]
   */
  constructor(chunks, options = {}) {
    this.dim = options.dim ?? 512
    this.docs = chunks.map((chunk) => {
      const tokens = tokenize(chunk.text)
      /** @type {Map<string, number>} */
      const termFreq = new Map()
      for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
      return {
        chunk,
        tokens,
        termFreq,
        length: tokens.length,
        vector: chunk.embedding && chunk.embedding.length > 0
          ? Float64Array.from(chunk.embedding)
          : hashVector(tokens, this.dim),
      }
    })
    /** @type {Map<string, number>} */
    this.docFreq = new Map()
    for (const doc of this.docs) {
      for (const term of doc.termFreq.keys()) {
        this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
      }
    }
    this.total = this.docs.length
    this.averageLength = this.total === 0
      ? 0
      : this.docs.reduce((sum, doc) => sum + doc.length, 0) / this.total
  }

  /**
   * @param {string} term
   * @returns {number}
   */
  idf(term) {
    const df = this.docFreq.get(term) ?? 0
    return Math.log(1 + (this.total - df + 0.5) / (df + 0.5))
  }

  /**
   * Score a pre-filtered candidate list. Filtering happens BEFORE this call and
   * inside the same entry function, so unread chunks are not in memory here.
   *
   * @param {string} query
   * @param {{ limit?: number, minScore?: number, bm25Weight?: number }} [options]
   * @returns {{ chunk: { id: string, sectionIndex: number, text: string, cfi?: string | null }, score: number, bm25: number, vector: number }[]}
   */
  search(query, options = {}) {
    const limit = options.limit ?? 5
    const minScore = options.minScore ?? 0
    const bm25Weight = options.bm25Weight ?? 0.7
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0 || this.docs.length === 0) return []
    const queryVector = hashVector(queryTokens, this.dim)
    const scored = this.docs.map((doc) => {
      let bm25 = 0
      for (const term of queryTokens) {
        const tf = doc.termFreq.get(term)
        if (!tf) continue
        const denominator = tf + K1 * (1 - B + B * (doc.length / (this.averageLength || 1)))
        bm25 += this.idf(term) * ((tf * (K1 + 1)) / denominator)
      }
      const vector = cosine(queryVector, doc.vector)
      const score = bm25Weight * (bm25 / (bm25 + 3)) + (1 - bm25Weight) * vector
      return { chunk: doc.chunk, score, bm25, vector }
    })
    return scored
      .filter((item) => item.score > minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}

/**
 * Trim a passage for the model context without cutting a word in half.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
export function clip(text, maxChars) {
  // Display/context helper, so it keeps the punctuation the author wrote: NOISE
  // is for tokenisation only. Running book text through it here used to turn
  // 「你自己去问他。」 into 「你自己去问他 」 inside summaries and card fronts.
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars - 1)}…`
}
