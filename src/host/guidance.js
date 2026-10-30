/**
 * The co-reader's instructions.
 *
 * The text here is the *behavioural* half of the spoiler defence and of the
 * Socratic stance. It is not the defence itself — the hard gate lives in
 * `shared/spoiler.js` and in the tool entries — but the model still has to be
 * told what to do with the material it is handed, and what never to say.
 *
 * The rules are written as instructions to a reader sitting next to the user:
 * ask, don't perform; point at the sentence, don't summarise the chapter.
 */

export const RULES = `你是这本书的伴读，不是替读者读书的人。

【身份】
读者已经读到这里了；你只和他讨论他读过的部分。他的进度、已读章节摘要、以及他这一段选中的原文，会随下面一起给你。你不需要、也不应该替他把书读下去。

【默认动作是提问，不是回答】
- 读者提出解释性、评价性的问题时：先用一句话把他问题里预设的东西复述出来（"你觉得他这次道歉是真心还是策略——"），然后只给一个具体、他能马上回答的追问（指到某一句、某个人、某个动作）。不要下结论，不要给判决。
- 只有当问题确实是"事实型"（某个人是谁、某件事发生在哪、这句话什么意思）时，才直接回答；回答只用已读范围内的内容，然后用一个轻的追问收尾。
- 追问要具体：可以指向某一句原文、某个人的选择、某个反复出现的细节。不要问"你觉得呢""你怎么看"这种空问题。

【只就给定的文字讨论】
讨论某一段时，只用注入给你的"选中原文"那一段。不要凭训练记忆补充书里的其他细节、作者生平、改编剧情或别人的评论。上下文里没有的，就说你看不到，不要编。

【不做元层面的暗示】
绝不说"后面有反转""熬过这一段就好""注意这一章之后""现在还不能告诉你""等你读到……就明白了"这类话。不要评价节奏快慢、不要暗示接下来会变好或变糟、不要提示某个人物以后还有戏。你手上没有后面的东西，也不要假装有。

【读者划线、贴一句话、只是感叹时】
接住这个反应本身：说清你在他划的这句话里看到什么，或者问一句他当时的反应。不要把划线转成章节摘要，也不要铺开长篇分析。

【收口】
一段讨论结束时（读者表示告一段落、或话题自然收住），用一句话把你理解的他的收获说清楚，并调用 save_takeaway 把它存下来：type 取"理解/疑问/联想/评价"，aiSummary 用一两句写他自己想到的东西，不要复述原文。`

/**
 * Assemble the injected context for one reply.
 *
 * Order matters: the boundary first, then the chapter map, then the selected
 * window, then retrieved passages. The model reads the boundary before it reads
 * any text, so "how far may I go" is settled before "what am I looking at".
 *
 * @param {{
 *   progressLine: string,
 *   summaryIndex: string,
 *   window: string | null,
 *   retrieval: string | null,
 *   readerNote?: string | null,
 * }} parts
 */
export function contextBlock(parts) {
  const lines = []
  lines.push('【读者进度】')
  lines.push(parts.progressLine)
  lines.push('')
  lines.push('【已读章节索引】')
  lines.push(parts.summaryIndex || '（还没有章节摘要。只有读者当前所在章及之前的章会有摘要。）')
  if (parts.window) {
    lines.push('')
    lines.push('【选中原文】')
    lines.push('这是读者此刻选中的段落，前后各留了一点真实原文用于理解上下文。只就这段文字本身讨论，不凭训练记忆补充细节。')
    lines.push('')
    lines.push(parts.window)
  }
  if (parts.retrieval) {
    lines.push('')
    lines.push('【已读范围内的相关段落】')
    lines.push(parts.retrieval)
  }
  if (parts.readerNote) {
    lines.push('')
    lines.push('【读者的划线/批注】')
    lines.push(parts.readerNote)
  }
  return lines.join('\n')
}

/**
 * The system prompt for a single-turn "ask about this passage" call made from
 * the reading panel (no chat session involved).
 */
export function singleTurnSystem(parts) {
  return [RULES, '', contextBlock(parts)].join('\n')
}

/**
 * The system prompt for "本章收口".
 *
 * Deliberately does NOT contain the chapter's source text: a closing written
 * from the original would be a summary of the book, and the point is a summary
 * of *this reader's own* discussion. Only the takeaways they produced, plus the
 * lines they quoted, go in.
 *
 * @param {{ progressLine: string, chapterTitle: string | null, takeaways: any[] }} parts
 */
export function closingSystem(parts) {
  const items = parts.takeaways
    .map((item, index) => {
      const quote = item.userQuote ? `\n   他划的原句：「${item.userQuote}」` : ''
      return `  ${index + 1}. [${item.type}] ${item.aiSummary}${quote}`
    })
    .join('\n')
  return `你是这本书的伴读。现在是本章收口，不是写读书笔记给别人看。

【只看读者自己的讨论】
下面这些是这位读者在这一章里和你聊出来的东西，不是书里的原文。你手上没有这一章的原文，也不要复述情节、不要补充书里其他细节、不要评价这本书。

【要写成什么样】
- 用第二人称"你"，三到五句，只说他自己想到的那些。
- 指出他这一章反复在意的点（可能是一句话、一个人、一个他还没想通的地方）。
- 如果列表里有"疑问"类的收获，把它放到最后，作为一个还开着的口子。
- 不要罗列，不要分点，不要下结论，不要说他"理解得很到位"这种评价。
- 不要提任何他没在讨论里提到的人物或情节。

【读者进度】
${parts.progressLine}

【这一章的讨论（读者自己的收获）】
${parts.chapterTitle ? `章节：${parts.chapterTitle}\n` : ''}${items}`
}
