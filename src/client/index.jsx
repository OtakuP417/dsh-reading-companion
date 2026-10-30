/**
 * Client entry.
 *
 * The panel lives in the shell's left sidebar and opens as a full page in the
 * center column: `sidebar.panellist` owns the rail glyph, and the same id owns
 * the page in the root-scoped `main` keyed slot. Both seats are declared by
 * shell plugins this package does not import, so each registration is wrapped in
 * `ctx.slots.inject` — a shell that never declares the seat leaves the panel
 * absent instead of failing boot.
 *
 * No `@deepseek-ai/dsh-client-*` package is imported: the components are plain
 * React handed in by the module factory, and every colour is a `--dsw-alias-*`
 * theme token.
 */

import App from './app.jsx'

export const inject = ['slots', 'locale', 'layout']

const NS = 'reading-companion'

const PANEL_ID = 'dsh-reading-companion'
/** After Plugins (0), Schedule (10), board (20), skill center (30). */
const PANEL_ORDER = 40

const zh = {
  'panel.label': '伴读',
  'meta.title': '伴读',
  'meta.description': '和 AI 讨论你正在读的书：只在你读过的范围内，锚定到段落，复习不依赖模型。',
}

const en = {
  'panel.label': 'Companion',
  'meta.title': 'Reading Companion',
  'meta.description': 'Discuss the book you are reading, only up to where you have read — paragraph-anchored, with model-free review.',
}

/**
 * The sidebar glyph. The shell owns the button, label, tooltip and rail
 * geometry; this component draws only the mark, at the size the shell asks for.
 * @param {{ size?: number }} props
 */
function PanelIcon({ size = 16 }) {
  return (
    <svg
      data-dsh-panel-entry={PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.2c1.6-.5 3.2-.2 5 1v9.3c-1.8-1.2-3.4-1.5-5-1z" />
      <path d="M13 3.2c-1.6-.5-3.2-.2-5 1v9.3c1.8-1.2 3.4-1.5 5-1z" />
      <path d="M8 4.2v9.3" />
    </svg>
  )
}

const CSS = `
.drc-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.drc-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-2)}
.drc-bar-left{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 260px}
.drc-bar-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.drc-title{font-weight:600;font-size:14px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:8px}
.drc-badge{font-size:10px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 7px;text-transform:uppercase}
.drc-progress{display:flex;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);align-items:center}
.drc-dim{color:var(--dsw-alias-label-tertiary);font-size:12px}
.drc-meter{position:relative;height:3px;border-radius:999px;background:var(--dsw-alias-border-l1);overflow:hidden;flex:1 1 100%;margin-top:2px}
.drc-meter-fill{position:absolute;inset:0 auto 0 0;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width .35s ease}
.drc-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;line-height:1.5;transition:background .15s ease,border-color .15s ease,transform .1s ease}
.drc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.drc-btn:active:not(:disabled){transform:translateY(1px)}
.drc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.drc-btn:disabled{opacity:.45;cursor:default}
.drc-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.drc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.drc-btn-active{background:var(--dsw-alias-interactive-bg-active)}
.drc-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 7px;font-size:12px;max-width:200px}
.drc-note{display:flex;gap:10px;align-items:center;justify-content:space-between;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);padding:6px 16px;font-size:12px;flex:0 0 auto}
.drc-error{border-bottom:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-overlay)}
.drc-main{display:grid;grid-template-columns:minmax(0,1fr) clamp(340px,26vw,460px);flex:1 1 auto;min-height:0}
@media (max-width:1000px){.drc-main{grid-template-columns:minmax(0,1fr) 340px}}
.drc-reader-wrap{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.drc-reader{flex:1 1 auto;min-height:0;overflow:hidden;position:relative}
.drc-reader foliate-view{display:block;width:100%;height:100%}
.drc-page-turn{display:flex;gap:8px;justify-content:center;align-items:center;padding:8px;border-top:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;background:var(--dsw-alias-bg-base)}
.drc-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;text-align:center;padding:32px}
.drc-empty-mark{width:56px;height:56px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.drc-empty-title{font-size:15px;font-weight:600;margin:0}
.drc-empty p.drc-dim{max-width:420px;margin:0;line-height:1.7}
.drc-side{display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base)}
.drc-tabs{display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.drc-tab{flex:1 1 0;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 8px;font-size:12px;cursor:pointer;transition:background .15s ease,color .15s ease}
.drc-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.drc-tab-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);font-weight:600}
.drc-pane{display:flex;flex-direction:column;min-height:0;flex:1 1 auto;gap:10px;padding:10px 12px}
.drc-scroll{overflow:auto}
.drc-selection{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;padding:9px 11px;flex:0 0 auto}
.drc-quote{margin:0 0 4px;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.drc-quote-small{margin:2px 0 0;font-size:11px;line-height:1.6}
.drc-messages{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}
.drc-message{max-width:94%;border-radius:12px;padding:8px 11px;font-size:12.5px;line-height:1.75;box-shadow:0 1px 2px rgb(0 0 0 / 4%)}
.drc-message-user{align-self:flex-end;background:var(--dsw-alias-brand-primary);color:#fff;border-bottom-right-radius:4px}
.drc-message-ai{align-self:flex-start;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-bottom-left-radius:4px}
.drc-message-ai.drc-message-failed{border-color:var(--dsw-alias-state-error-primary)}
.drc-message-text{margin:0;white-space:pre-wrap;word-break:break-word}
.drc-takeaway-actions{margin-top:7px;flex-wrap:wrap;gap:5px;align-items:center}
.drc-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;transition:background .15s ease,color .15s ease}
.drc-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.drc-chip-static{cursor:default;background:var(--dsw-alias-bg-layer-2)}
.drc-ask{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding-top:2px}
.drc-textarea{width:100%;resize:vertical;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;font-size:12.5px;line-height:1.65;font-family:inherit;min-height:64px}
.drc-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;background:var(--dsw-alias-bg-base)}
.drc-row{display:flex;align-items:center;gap:8px}
.drc-row-between{justify-content:space-between}
.drc-row-wrap{flex-wrap:wrap}
.drc-link{border:none;background:transparent;color:var(--dsw-alias-brand-primary);font-size:12px;cursor:pointer;padding:0}
.drc-link:hover{text-decoration:underline}
.drc-pad{padding:6px 2px;line-height:1.75}
.drc-group{display:flex;flex-direction:column;gap:7px}
.drc-group-title{margin:8px 0 0;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.drc-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 11px;display:flex;flex-direction:column;gap:7px;transition:border-color .15s ease,box-shadow .15s ease}
.drc-card:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 2px 8px rgb(0 0 0 / 5%)}
.drc-card-due{border-color:var(--dsw-alias-brand-primary)}
.drc-card-front{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;background:transparent;border:none;color:inherit;padding:0;text-align:left;cursor:pointer;font-size:12.5px;line-height:1.7;font-weight:500}
.drc-card-back{display:flex;flex-direction:column;gap:7px;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px}
.drc-card-text{margin:0;font-size:12.5px;line-height:1.75;word-break:break-word}
.drc-rewrite{margin:0;font-size:12px;line-height:1.7;padding:7px 9px;border-radius:9px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}
.drc-busy{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.drc-dot{width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-brand-primary);animation:drc-pulse 1.1s ease-in-out infinite}
@keyframes drc-pulse{0%,100%{opacity:.25}50%{opacity:1}}
.drc-side ::-webkit-scrollbar{width:8px;height:8px}
.drc-side ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:8px}
`

function injectStyle() {
  const id = 'dsh-reading-companion-style'
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = CSS
  document.head.appendChild(style)
}

/** @param {any} ctx */
export function apply(ctx) {
  injectStyle()

  let t = (/** @type {string} */ key) => (ctx.locale?.getLanguage?.() === 'en' ? en[key] : zh[key]) ?? key
  try {
    ctx.locale?.register?.(NS, { zh, en })
    const bound = ctx.locale?.bind?.(NS)
    if (typeof bound === 'function') t = bound
  } catch {
    // locale service absent: the raw dictionary above still renders
  }

  const disposers = []
  // The rail row: only the glyph, at the size the shell asks for.
  disposers.push(
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => t('panel.label'), locale: NS },
        PanelIcon,
      ),
    ),
  )
  // The page the rail row opens, in the center column.
  disposers.push(
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, App),
    ),
  )
  try {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) dispose()
    }, 'reading-companion: panel seats')
  } catch {
    // no effect scope: the registrations still live for the session
  }
}
