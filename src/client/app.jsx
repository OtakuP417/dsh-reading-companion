/**
 * The reading panel.
 *
 * Three things share one screen, in the order the reader needs them: the book,
 * the conversation about the sentence under their eyes, and the review entry
 * that sits next to "继续阅读" rather than in a module of its own.
 *
 * No DSH client package is imported here — only `react`, handed in by the
 * module factory — and every colour comes from a `--dsw-alias-*` token.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api.js'
import { Reader } from './reader.js'

const TAKEAWAY_TYPES = ['理解', '疑问', '联想', '评价']

const FORMAT_LABEL = { mobi: 'MOBI', fb2: 'FB2', txt: 'TXT', markdown: 'MD', html: 'HTML', cbz: 'CBZ', epub: 'EPUB' }

const cx = (...names) => names.filter(Boolean).join(' ')

/** @param {{ label: string, onClick: () => void, active?: boolean, disabled?: boolean, primary?: boolean, title?: string }} props */
function Btn({ label, onClick, active, disabled, primary, title }) {
  return (
    <button
      type="button"
      className={cx('drc-btn', active && 'drc-btn-active', primary && 'drc-btn-primary')}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
    >
      {label}
    </button>
  )
}

/** @param {{ view: any }} props */
function ProgressLine({ view }) {
  if (!view || view.ceiling === null) return <span className="drc-dim">还没开始读</span>
  return (
    <span className="drc-progress">
      <span>已读到第 {view.ceiling + 1} 章</span>
      {view.ceilingTitle ? <span className="drc-dim">「{view.ceilingTitle}」</span> : null}
      {view.atCeiling ? null : <span className="drc-dim">· 现在在第 {view.position + 1} 章</span>}
      <span className="drc-dim">（共 {view.chapterCount} 章）</span>
    </span>
  )
}

export default function App() {
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [tab, setTab] = useState('discuss')
  const [fontSize, setFontSize] = useState(18)
  const [messages, setMessages] = useState([])
  const [selection, setSelection] = useState(null)
  const [draft, setDraft] = useState('')
  const [summaries, setSummaries] = useState(null)
  const [askedWithoutWindow, setAskedWithoutWindow] = useState(false)
  const [note, setNote] = useState(null)

  const hostRef = useRef(null)
  const readerRef = useRef(null)
  const saveTimer = useRef(null)
  const fileRef = useRef(null)
  const activeBookRef = useRef(null)

  const books = snapshot?.books ?? []
  const activeBookId = snapshot?.activeBookId ?? null
  const progressView = snapshot?.progress?.readthrough ?? null
  const bookInfo = snapshot?.book ?? null
  const textless = bookInfo?.textless === true
  const cards = snapshot?.cards ?? []
  const takeaways = snapshot?.takeaways ?? []
  const dueCount = snapshot?.dueCount ?? 0

  const refresh = useCallback(async () => {
    try {
      const next = await api.state()
      setSnapshot(next)
      return next
    } catch (e) {
      setError(String(e.message ?? e))
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // ---- the reader ---------------------------------------------------------
  const openBook = useCallback(
    async (bookId, cfi) => {
      if (!hostRef.current) return
      if (!readerRef.current) readerRef.current = new Reader(hostRef.current)
      setBusy('正在打开这本书…')
      try {
        await readerRef.current.open(api.bookUrl(bookId), {
          cfi: cfi ?? null,
          onRelocate: (detail) => {
            if (!detail?.cfi) return
            if (saveTimer.current) window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(() => {
              void api
                .saveProgress({
                  bookId,
                  cfi: detail.cfi,
                  positionSectionIndex: detail.sectionIndex ?? undefined,
                  chapterTitle: detail.label ?? undefined,
                })
                .then((result) => {
                  setSnapshot((prev) => (prev ? { ...prev, progress: { ...prev.progress, ...result.progress } } : prev))
                })
                .catch(() => {})
            }, 500)
          },
          onSelection: (payload) => {
            setSelection(payload)
            void api.selection({ bookId, ...payload }).catch(() => {})
          },
          onError: (e) => setError(`打不开这本书：${e.message}`),
        })
        readerRef.current.applyFontSize(fontSize)
        const notes = (await api.state()).notes ?? []
        await readerRef.current.showHighlights(notes)
      } catch (e) {
        setError(String(e?.message ?? e))
      } finally {
        setBusy(null)
      }
    },
    [fontSize],
  )

  useEffect(() => {
    if (!activeBookId || !hostRef.current) return
    if (activeBookRef.current === activeBookId) return
    activeBookRef.current = activeBookId
    void openBook(activeBookId, snapshot?.progress?.cfi ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBookId])

  useEffect(() => () => readerRef.current?.destroy(), [])

  // Poll the summary index while the reader is ahead of it; summaries are
  // generated in the background and must never block reading.
  useEffect(() => {
    if (!activeBookId) return undefined
    const timer = window.setInterval(() => {
      void api
        .state()
        .then((next) => setSummaries(next.summaries))
        .catch(() => {})
    }, 8000)
    return () => window.clearInterval(timer)
  }, [activeBookId])

  const onImport = async (file) => {
    if (!file) return
    setBusy('正在导入…')
    setError(null)
    setNote(null)
    try {
      const result = await api.importFile(file)
      setSnapshot(result.state)
      activeBookRef.current = null
      setMessages([])
      setSelection(null)
      const warnings = result.warnings ?? result.meta?.warnings ?? []
      const format = result.format ?? result.meta?.format ?? 'epub'
      if (warnings.length > 0) setNote(warnings.join(' '))
      else if (format !== 'epub') setNote(`已按 ${FORMAT_LABEL[format] ?? format} 转换后导入，原文件仍在本地。`)
      await refresh()
      await openBook(result.bookId, null)
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const jumpTo = (cfi) => {
    if (!cfi) return
    void readerRef.current?.goTo(cfi)
  }

  const resume = () => {
    const cfi = snapshot?.progress?.cfi
    if (cfi) jumpTo(cfi)
    else void readerRef.current?.next()
  }

  const changeFont = (delta) => {
    const next = Math.min(32, Math.max(12, fontSize + delta))
    setFontSize(next)
    readerRef.current?.applyFontSize(next)
  }

  // ---- discussion ---------------------------------------------------------
  const ask = async () => {
    const question = draft.trim()
    if (!question || !activeBookId) return
    setDraft('')
    setMessages((prev) => [...prev, { role: 'user', text: question }])
    setBusy('正在想…')
    setError(null)
    try {
      const result = await api.ask({
        bookId: activeBookId,
        question,
        cfi: selection?.cfi ?? null,
        sectionIndex: selection?.sectionIndex ?? null,
        quote: selection?.quote ?? null,
      })
      setAskedWithoutWindow(!result.usedWindow && Boolean(selection))
      setMessages((prev) => [...prev, { role: 'ai', text: result.reply, sections: result.sections }])
    } catch (e) {
      setError(String(e.message ?? e))
      setMessages((prev) => [...prev, { role: 'ai', text: `（没有回成：${String(e.message ?? e)}）`, failed: true }])
    } finally {
      setBusy(null)
    }
  }

  const saveTakeaway = async (type, message) => {
    if (!activeBookId) return
    setBusy('正在存…')
    try {
      await api.saveTakeaway({
        bookId: activeBookId,
        type,
        aiSummary: message.text.slice(0, 900),
        userQuote: selection?.quote ?? null,
        cfi: selection?.cfi ?? null,
        chapterIndex: selection?.sectionIndex ?? progressView?.position ?? 0,
      })
      await refresh()
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const review = async (cardId, outcome) => {
    if (!activeBookId) return
    setBusy('正在记…')
    try {
      const result = await api.review({ bookId: activeBookId, cardId, outcome })
      setSnapshot((prev) => (prev ? { ...prev, cards: result.cards, dueCount: result.cards.filter((card) => card.schedule.due).length } : prev))
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const closing = async () => {
    if (!activeBookId) return
    setBusy('正在收口…')
    try {
      const result = await api.closing({ bookId: activeBookId, sectionIndex: progressView?.position ?? 0 })
      setMessages((prev) => [...prev, { role: 'closing', text: result.text }])
      await refresh()
      setTab('takeaways')
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(null)
    }
  }

  const chapterTakeaways = useMemo(() => {
    const position = progressView?.position ?? 0
    return takeaways.filter((item) => item.chapterIndex === position)
  }, [takeaways, progressView])

  const grouped = useMemo(() => {
    const map = new Map()
    for (const item of takeaways) {
      const key = item.chapterIndex ?? 0
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(item)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [takeaways])

  return (
    <div className="drc-root">
      <div className="drc-bar">
        <div className="drc-bar-left">
          <span className="drc-title">
            {snapshot?.progress?.bookTitle ?? bookInfo?.title ?? '伴读'}
            {bookInfo?.format && bookInfo.format !== 'epub' ? (
              <span className="drc-badge">{FORMAT_LABEL[bookInfo.format] ?? bookInfo.format}</span>
            ) : null}
          </span>
          <ProgressLine view={progressView} />
          <div className="drc-meter" aria-hidden="true">
            <div
              className="drc-meter-fill"
              style={{
                width: `${progressView && progressView.chapterCount > 1 ? ((progressView.ceiling + 1) / progressView.chapterCount) * 100 : 0}%`,
              }}
            />
          </div>
        </div>
        <div className="drc-bar-right">
          {books.length > 1 ? (
            <select
              className="drc-select"
              value={activeBookId ?? ''}
              onChange={async (event) => {
                const bookId = event.target.value
                const next = await api.setActive(bookId)
                setSnapshot(next)
                activeBookRef.current = null
                setMessages([])
                setSelection(null)
                await openBook(bookId, next.progress?.cfi ?? null)
              }}
            >
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>
          ) : null}
          <Btn label="导入书籍" onClick={() => fileRef.current?.click()} title="EPUB / MOBI / FB2 / TXT / Markdown / HTML / CBZ" />
          <Btn label="A-" onClick={() => changeFont(-1)} title="字号变小" />
          <Btn label="A+" onClick={() => changeFont(1)} title="字号变大" />
          <Btn label="继续阅读" onClick={resume} primary />
          <Btn label={`复习${dueCount > 0 ? ` ${dueCount}` : ''}`} onClick={() => setTab('review')} />
          <input
            ref={fileRef}
            type="file"
            accept=".epub,.fb2,.fbz,.mobi,.azw,.prc,.txt,.md,.markdown,.html,.htm,.cbz,text/plain,text/markdown,text/html"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void onImport(file)
            }}
          />
        </div>
      </div>

      {note ? (
        <div className="drc-note">
          <span>{note}</span>
          <button type="button" className="drc-link" onClick={() => setNote(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="drc-note drc-error">
          <span>{error}</span>
          <button type="button" className="drc-link" onClick={() => setError(null)}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="drc-main">
        <div className="drc-reader-wrap">
          <div
            className="drc-reader"
            ref={hostRef}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              const file = event.dataTransfer?.files?.[0]
              if (file) void onImport(file)
            }}
          >
            {!activeBookId ? (
              <div className="drc-empty">
                <div className="drc-empty-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 5.5C6.4 4.7 9.2 5.1 12 6.8v12.6C9.2 17.7 6.4 17.3 4 18.1z" />
                    <path d="M20 5.5c-2.4-.8-5.2-.4-8 1.3v12.6c2.8-1.7 5.6-2.1 8-1.3z" />
                    <path d="M12 6.8v12.6" />
                  </svg>
                </div>
                <p className="drc-empty-title">把一本书拖进来</p>
                <p className="drc-dim">
                  支持 EPUB、MOBI、FB2/FBZ、TXT、Markdown、HTML、CBZ。其它格式会先转成 EPUB 再读，进度和笔记都留在本地。
                </p>
                <p className="drc-dim">只有你读过的部分才能聊；没读到的章节，连摘要都不会生成。</p>
              </div>
            ) : null}
          </div>
          {activeBookId ? (
            <div className="drc-page-turn">
              <Btn label="上一页" onClick={() => void readerRef.current?.prev()} />
              <span className="drc-dim">{busy ? busy : 'PageUp / PageDown 也可以翻页'}</span>
              <Btn label="下一页" onClick={() => void readerRef.current?.next()} />
            </div>
          ) : null}
        </div>

        <aside className="drc-side">
          <div className="drc-tabs">
            {[
              ['discuss', '讨论'],
              ['takeaways', `收获${takeaways.length > 0 ? ` ${takeaways.length}` : ''}`],
              ['review', `复习${dueCount > 0 ? ` ${dueCount}` : ''}`],
            ].map(([key, label]) => (
              <button key={key} type="button" className={cx('drc-tab', tab === key && 'drc-tab-active')} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'discuss' ? (
            <div className="drc-pane">
              <div className="drc-selection">
                {textless ? (
                  <p className="drc-dim">这本是图片书（CBZ），没有文字可以讨论。阅读、进度和书签照常可用。</p>
                ) : selection?.quote ? (
                  <>
                    <p className="drc-quote">「{selection.quote.slice(0, 200)}」</p>
                    <div className="drc-row">
                      <span className="drc-dim">第 {(selection.sectionIndex ?? 0) + 1} 章 · 只讨论这段</span>
                      <button type="button" className="drc-link" onClick={() => setSelection(null)}>
                        取消选择
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="drc-dim">在左侧正文里划一句话，就能只就那一段聊。不划线也可以问已读过的内容。</p>
                )}
              </div>

              <div className="drc-messages">
                {messages.length === 0 ? (
                  <p className="drc-dim drc-pad">
                    问一句你已经读到的地方。它更可能反问你一句，而不是替你总结。
                  </p>
                ) : null}
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={cx(
                      'drc-message',
                      message.role === 'user' ? 'drc-message-user' : 'drc-message-ai',
                      message.failed && 'drc-message-failed',
                    )}
                  >
                    <p className="drc-message-text">{message.text}</p>
                    {message.role === 'ai' && !message.failed ? (
                      <div className="drc-row drc-takeaway-actions">
                        <span className="drc-dim">存成收获：</span>
                        {TAKEAWAY_TYPES.map((type) => (
                          <button key={type} type="button" className="drc-chip" onClick={() => void saveTakeaway(type, message)}>
                            {type}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
                {busy ? (
                  <span className="drc-busy">
                    <span className="drc-dot" />
                    {busy}
                  </span>
                ) : null}
              </div>

              <div className="drc-ask">
                <textarea
                  className="drc-textarea"
                  value={draft}
                  placeholder="问你已经读到的地方…（Enter 发送，Shift+Enter 换行）"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void ask()
                    }
                  }}
                  rows={3}
                />
                <div className="drc-row drc-row-between">
                  <span className="drc-dim">{askedWithoutWindow ? '' : ''}</span>
                  <div className="drc-row">
                    {chapterTakeaways.length > 0 ? <Btn label="本章收口" onClick={() => void closing()} /> : null}
                    <Btn label="发送" onClick={() => void ask()} primary disabled={!draft.trim() || !activeBookId} />
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {tab === 'takeaways' ? (
            <div className="drc-pane drc-scroll">
              {takeaways.length === 0 ? (
                <p className="drc-dim drc-pad">
                  还没有收获。聊完一段时点一下「存成收获」，或者让助手调用 save_takeaway —— 它会留在这里，而且只增不减。
                </p>
              ) : null}
              {[...grouped].reverse().map(([chapter, items]) => (
                <div key={chapter} className="drc-group">
                  <p className="drc-group-title">第 {chapter + 1} 章</p>
                  {items.map((item) => (
                    <div key={item.id ?? `${item.createdAt}-${item.aiSummary}`} className="drc-card">
                      <div className="drc-row drc-row-between">
                        <span className="drc-chip drc-chip-static">{item.type}</span>
                        {item.scope === 'chapter-closing' ? <span className="drc-dim">本章收口</span> : null}
                      </div>
                      <p className="drc-card-text">{item.aiSummary}</p>
                      {item.userQuote ? <p className="drc-dim drc-quote-small">「{item.userQuote.slice(0, 90)}」</p> : null}
                      <div className="drc-row">
                        <button type="button" className="drc-link" onClick={() => jumpTo(item.cfi)}>
                          回到原文
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}

          {tab === 'review' ? (
            <div className="drc-pane drc-scroll">
              {cards.length === 0 ? (
                <p className="drc-dim drc-pad">还没有卡片。收获会自动派生卡片 —— 不需要模型也能生成和排期。</p>
              ) : null}
              {cards.map((card) => (
                <ReviewCard key={card.cardId} card={card} onJump={jumpTo} onDecide={review} bookId={activeBookId} />
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

/** @param {{ card: any, onJump: (cfi: string) => void, onDecide: (cardId: string, outcome: string) => void, bookId: string | null }} props */
function ReviewCard({ card, onJump, onDecide, bookId }) {
  const [open, setOpen] = useState(false)
  const [rewrite, setRewrite] = useState(null)
  const [busy, setBusy] = useState(false)

  // Model work happens only here, when the reader asks for it. Reading a card,
  // flipping it, and deciding next step never touch a model.
  const ask = async (mode) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.rephrase({ bookId, cardId: card.cardId, mode })
      setRewrite(result?.text ? result.text : (result?.note ?? ''))
    } catch (error) {
      setRewrite(`这一步没成功：${error?.message ?? error}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('drc-card', card.schedule.due && 'drc-card-due')}>
      <button type="button" className="drc-card-front" onClick={() => setOpen((value) => !value)}>
        <span className="drc-card-text">{card.front}</span>
        <span className="drc-dim">{open ? '收起' : '看背面'}</span>
      </button>
      {open ? (
        <div className="drc-card-back">
          <p className="drc-message-text">{card.back}</p>
          <p className="drc-dim">
            第 {(card.chapterIndex ?? 0) + 1} 章 · {card.schedule.label}
          </p>
          {rewrite ? <p className="drc-rewrite">{rewrite}</p> : null}
          <div className="drc-row drc-row-wrap">
            <Btn label="回到原文" onClick={() => onJump(card.cfi)} />
            <Btn label="想再读一遍" onClick={() => onDecide(card.cardId, 'reread')} />
            <Btn label="已经稳了" onClick={() => onDecide(card.cardId, 'settled')} />
            <Btn label="很熟" onClick={() => onDecide(card.cardId, 'got')} />
          </div>
          <div className="drc-row drc-row-wrap">
            <Btn label="换一种问法" onClick={() => void ask('rephrase')} />
            <Btn label="拆小一点" onClick={() => void ask('split')} />
            <Btn label="和另一张对比" onClick={() => void ask('compare')} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
