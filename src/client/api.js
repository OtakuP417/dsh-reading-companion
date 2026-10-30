/**
 * The panel's only channel to the Host half.
 *
 * Everything goes through `/__reading/*` on this same origin, so no CORS, no
 * second server, and no import of any DSH client package.
 */

const BASE = '/__reading'

/** @param {string} path @param {RequestInit} [init] */
async function request(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { ok: false, error: text.slice(0, 400) }
  }
  if (!response.ok || body?.ok === false) {
    const error = new Error(body?.error ?? `请求失败（${response.status}）`)
    // @ts-expect-error extra field on Error
    error.code = body?.code ?? null
    // @ts-expect-error extra field on Error
    error.status = response.status
    throw error
  }
  return body
}

export const api = {
  state: () => request('/state'),
  setActive: (bookId) => request('/active', { method: 'POST', body: JSON.stringify({ bookId }) }),
  /** @param {File} file */
  async importFile(file) {
    const bytes = await file.arrayBuffer()
    const response = await fetch(`${BASE}/import`, {
      method: 'POST',
      headers: {
        'content-type': 'application/epub+zip',
        // Header values are ISO-8859-1 (ByteString); a CJK file name would make
        // fetch throw before the request is sent. Percent-encode it instead.
        'x-file-name': encodeURIComponent(file.name),
      },
      body: bytes,
    })
    const body = await response.json()
    if (!response.ok || body?.ok === false) throw new Error(body?.error ?? '导入失败')
    return body
  },
  bookUrl: (bookId) => `${BASE}/book/${encodeURIComponent(bookId)}/file`,
  saveProgress: (payload) => request('/progress', { method: 'POST', body: JSON.stringify(payload) }),
  selection: (payload) => request('/selection', { method: 'POST', body: JSON.stringify(payload) }),
  ask: (payload) => request('/ask', { method: 'POST', body: JSON.stringify(payload) }),
  saveNote: (payload) => request('/note', { method: 'POST', body: JSON.stringify(payload) }),
  saveTakeaway: (payload) => request('/takeaway', { method: 'POST', body: JSON.stringify(payload) }),
  closing: (payload) => request('/closing', { method: 'POST', body: JSON.stringify(payload) }),
  takeaways: () => request('/takeaways'),
  cards: () => request('/cards'),
  review: (payload) => request('/review', { method: 'POST', body: JSON.stringify(payload) }),
  refreshSummaries: (bookId) => request('/summaries', { method: 'POST', body: JSON.stringify({ bookId }) }),
  rephrase: (payload) => request('/rephrase', { method: 'POST', body: JSON.stringify(payload) }),
}
