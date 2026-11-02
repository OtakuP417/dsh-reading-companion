/**
 * 市场条目的文案只有这一份 —— market-pr.mjs（首次投稿）和 market-refresh-pr.mjs
 * （改已有 PR）都从这里取，避免两个脚本各写一份、改了一处忘了另一处。
 *
 * 写文案的规矩（被用户明确要求过）：
 *  - 面向「完全没听说过这个插件」的人：先说他拿它干什么、为什么要用它，
 *    再说怎么用，最后才说靠什么做到。
 *  - 目录只允许陈述功能、逐句对代码核实；所以 PR 正文里每一条功能都必须
 *    真的在仓库里，没做过的宁可不写。
 */

export function entryYml({ owner, repo, category = 'docs' }) {
  return `url: https://github.com/${owner}/${repo}
name: ${owner}/${repo}
category: ${category}
description:
  en: An AI reading buddy: it sits next to you while you read, and only knows the pages you have already reached — so it cannot spoil the rest, and it never summarizes the whole book for you. Highlight a sentence and ask about it, or just ask about what you finished; it usually restates what you seem to mean and asks one concrete question back. What you work out can be saved as a takeaway and later becomes a review card that jumps back to the sentence. EPUB, MOBI, FB2, TXT, Markdown, HTML, CBZ.
  zh: 读书时旁边坐一个 AI 同读的人：它只知道你读到的位置，所以不会剧透，也不会替你把整本书总结掉。觉得哪句有分量就划出来问它，或者直接问刚读完的内容——它多半先复述你的意思，再反问一个具体的问题。想明白的东西可以存成「收获」，之后变成复习卡片，点一下跳回原句。支持 EPUB、MOBI、FB2、TXT、Markdown、HTML、CBZ。
`
}

export function prBody({ owner, repo }) {
  const slug = `${owner}/${repo}`
  return `Adds one listing entry: \`data/plugins/${owner}__${repo}.yml\`.

- Package: \`dsh-reading-companion\`
- Repo: https://github.com/${slug}
- Category: \`docs\`

## What it is

A reading companion. You import a book, read it in a full-page panel in the sidebar, and discuss it with the model — but the model only ever sees the part you have already read. It is deliberately not a book summarizer: there is no path that hands it unread text.

Two failure modes it is built against: ask an AI to summarize a book and you get notes for a book you have not read; chat with a general assistant about the book and it already knows the ending, so it leaks. Here the restriction is structural, not a line in the prompt.

## What it does

- **Read**: import EPUB / MOBI / FB2 / FBZ / TXT / Markdown / HTML / CBZ. Non-EPUB inputs are normalized into an EPUB this repo authors, so the renderer and the indexer always agree on what "chapter N" is. PDF and AZW3 are refused with an explicit message instead of being parsed badly.
- **One progress value**: an EPUB CFI plus a read-through ceiling (the furthest chapter opened). Position and ceiling are stored separately, so scrolling back does not re-hide chapters the reader has finished.
- **Discuss**: highlight a sentence (quote card appears) and ask about it, or ask without selecting — the no-selection path falls back to the current chapter and is gated just the same.
- **Context assembly**: chapter summaries up to the ceiling, the selected sentence ±300 characters of real text, and a hybrid BM25 + char-ngram retrieval that is filtered by the ceiling inside the retrieval function.
- **Refusal**: unread chunks never enter the index; gated tools check at their entry; a synchronous \`tools.guard\` refuses again before any handler runs. Asking about a later chapter returns a refusal string, not a guess.
- **Guidance**: interpretive questions get the reader's presupposition restated plus one concrete follow-up (no verdict); factual questions are answered from the read text and closed with a light question. Meta-spoilers ("后面有反转", "熬过这一段就好") are excluded by rule.
- **Takeaways**: \`{type: 理解|疑问|联想|评价, cfi, chapterIndex, userQuote, aiSummary, createdAt}\`, appended to JSONL — append-only, never rewritten or merged.
- **Chapter close**: "本章收口" is generated from the reader's own takeaways for that chapter; the source text is not in that prompt. With no model route it degrades to a rules-based list.
- **Review**: takeaways become 1–3 atomic cards by rule (no model), scheduled by a vendored SM-2 implementation (\`supermemo2\`, MIT) over an append-only review log. The card back links back to the CFI. The model is only used on request ("换一种问法 / 拆小一点 / 和另一张对比").

## Technical notes

- Cordis plugin, host + client halves. \`package.json\` declares \`dsh.bundle\` with \`dsh.bundle.patch\` → \`cordis.patch.yml\`.
- Host half: plain ESM, zero runtime dependencies. Everything is registered inside \`ctx.effect()\` and disposed on unload. \`llm\` / \`agentDefaultModel\` / \`webServer\` are optional services, so the plugin stays loaded on a profile with no model route.
- Client half: registers \`sidebar.panellist\` and \`main\`; one self-contained \`lib/client.js\` (foliate-js bundled in, \`react\` externalised to the platform table); styles only with \`--dsw-alias-*\` tokens; no \`document.body\` writes, no app-root replacement, no DOM-selector slot hijacking.
- State lives under \`$DSH_HOME/reading-companion/\`; JSON is written with tmp+rename, and the takeaway / card / review logs are append-only JSONL.

## Testing

- Installed and exercised through the real path — \`dsh plugin --profile desktop add "github:${slug}"\` — on DSH 0.2.1-rc.5, not only in a fake context.
- 64 automated tests (\`node --test "test/*.test.js"\`): the spoiler gate, retrieval filtering, chapter splitting from the TOC, card derivation, SM-2 replay, every HTTP route, and the plugin entry under a stub context.
- 18 end-to-end checks against a running host (\`scripts/live-check.mjs\`): unread ask → 403 with no unread markers in the reply; read ask → grounded in the selected window; unread takeaway → 403; anchor/chapter mismatch → 400; chapter close drawn from the reader's own takeaways; cards carry CFI anchors; review advances the schedule; chapter summaries stop at the ceiling.
- Model-disconnected path also exercised: chapter close falls back to a rules list, rephrase returns \`modelFree\`, review still schedules.

## Known limits

- PDF and AZW3 are not supported — deliberately refused, not silently mangled.
- MOBI import keeps text only; images are dropped.
- Retrieval is lexical plus hashed character n-grams, not neural embeddings (no embedding service is required, which is the point).
- Chapter boundaries come from the book's TOC plus title-line matching; a TOC entry that cannot be located is merged into the previous chapter — deliberately coarse, so the gate never refuses text the reader has actually read.
- Panel copy is Chinese-only for now.

## Checklist

- [x] \`package.json\` declares \`dsh.bundle.patch\` and the file exists
- [x] DSH source and built-in packages untouched
- [x] No DOM-selector slot hijacking (\`sidebar.panellist\` + \`main\` only)
- [x] Unread content never reaches the model context
- [x] Registrations disposed with the plugin (\`ctx.effect\`)
- [x] README covers install, usage, and known limits`
}
