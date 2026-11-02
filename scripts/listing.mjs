/**
 * 市场条目的文案只有这一份 —— market-pr.mjs（首次投稿）和 market-refresh-pr.mjs
 * （改已有 PR）都从这里取，避免两个脚本各写一份、改了一处忘了另一处。
 *
 * 写文案的规矩（被用户明确要求过）：
 *  - 面向「完全没听说过这个插件」的人：先说他拿它干什么、为什么要用它，
 *    再说怎么用，最后才说靠什么做到。行话（CFI、RAG、门控）只放在 PR 正文的
 *    「怎么做到」那几条里，而且每一条都要能被维护者对代码核实。
 *  - 目录只允许陈述功能、逐句对代码核实，所以不写形容词。
 */

export function entryYml({ owner, repo, category = 'docs' }) {
  return `url: https://github.com/${owner}/${repo}
name: ${owner}/${repo}
category: ${category}
description:
  en: An AI reading buddy that sits next to you while you read a book — and only knows the pages you have already read, so it cannot spoil the rest. Highlight a sentence and ask about it, or just ask about what you just finished; instead of summarizing for you, it usually answers with one concrete question. Whatever you work out can be saved as a takeaway, which later becomes a review card that jumps back to the sentence.
  zh: 读书时旁边坐一个 AI 同读的人：你读到哪儿它只知道到哪儿，所以不剧透。觉得哪句有意思就划出来问它，或者直接问刚读完的内容——它多半先反问你一句，而不是替你总结。想明白的东西可以存成「收获」，之后自动变成复习卡片，点一下跳回原句。
`
}

export function prBody({ owner, repo }) {
  const slug = `${owner}/${repo}`
  return `Reading with an AI usually goes one of two ways: it summarizes the whole book (and spoils it), or it reads along but you have to trust a prompt that says "don't spoil". This plugin takes the third option — it is structurally unable to see anything past the page you are on, and it is built to ask you questions rather than hand you conclusions.

**What it feels like to use**

You import a book and read it in a full-page panel in the left sidebar (the page position is saved, so reopening lands on the same passage).

When a sentence catches your eye, you drag over it; a small quote card appears in the discussion pane on the right, and you type whatever you are wondering about — "他为什么不肯说清楚", "这句是不是在暗示什么". The answer is written from that sentence plus what you have already read, and never from later pages.

If nothing specific caught your eye, you just type the question ("他们为什么吵架"). Same rule: it can only see up to where you are, and asking about a later chapter is refused rather than guessed.

Interpretive questions do not get a verdict. It restates what you seem to be assuming, then asks one concrete question back — the kind you can answer from the text in front of you. Factual questions do get a direct answer, from the read text only, closed with a light question.

When a conversation lands somewhere, you save it as a takeaway (理解 / 疑问 / 联想 / 评价). Takeaways collect per chapter. The review tab later shows one card at a time: the front is a question derived from your own takeaway, the back is what you concluded plus a link that jumps back to that sentence in the book.

**How it holds that line** (each of these is checkable in the repo)

- One progress value per book, an EPUB CFI. The prompt scope, the retrieval filter and the per-chapter summaries all read that single value.
- Unread chapters never enter the retrieval index; the gated tools refuse at their entry, and a synchronous tool guard refuses again before any handler runs. So the refusal does not depend on the model, the prompt, or the session.
- The model being unavailable degrades to a working app: chapter summaries and card rephrasing go quiet, while reading, takeaways and review still work (card rules and scheduling are pure code).
- Import is normalized to an EPUB this repo authors, so the renderer and the indexer always agree on what "chapter N" is. EPUB / MOBI / FB2 / FBZ / TXT / Markdown / HTML / CBZ import; PDF and AZW3 are refused with an explicit message rather than silently mangled.

**Listing checks**

- \`package.json\` declares \`dsh.bundle\` with \`dsh.bundle.patch\` → \`cordis.patch.yml\`.
- The UI registers \`sidebar.panellist\` and \`main\`; it does not write \`document.body\`, does not replace the app root, does not fill an existing slot through DOM selectors, and styles only with \`--dsw-alias-*\` tokens.
- The host half has no runtime dependencies; the client is one self-contained \`lib/client.js\` committed to the repo, so installing from GitHub needs no build step.

**Try it**

\`\`\`
dsh plugin --profile desktop add "github:${slug}"
\`\`\`

Repo: https://github.com/${slug}`
}
