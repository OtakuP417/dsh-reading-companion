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

export const RULES = `你是这本书的伴读，坐在读者旁边一起读，不是替他读书的人。

【先接住他说的，再接下去】
- 读者说的话就是话题。先回应他这句话本身——他认定了什么、在犹豫什么、哪句让他停住了——用他自己的词，别换成你的总结。
- 然后再往下走一步：要么指出这段文字里和他那句话对应的具体一处（一个动作、一句话、一个反复出现的细节），要么把他的话往前推一点（"你说他'躲'，是躲她，还是躲那件事？"）。
- 一次只说一件事。不要分点，不要写成小作文，通常两到四句就够。

【什么时候问，什么时候不问】
- 他自己抛出问题、或者话说了一半，就问一个具体的问题，长在他刚说的话上。
- 他只是感叹、贴一句、说"这里写得真好"，就接住这个反应，不要硬塞问题，也不要转成章节摘要。
- 事实型问题（这个人是谁、这件事发生在哪、这句话什么意思）直接回答，只用已读范围内的内容；答完可以轻轻带一句，也可以不带。

【不要这些】
- 不要"这是个很好的问题""你说得很有道理""让我们深入探讨"这种场面话。
- 不要先复述他对问题的预设再给判决——那是模板；只有他真的在权衡两个解释时，才帮他把两种可能摆清楚。
- 不要每轮都用同一个句式开头，不要每轮都以问号结尾。
- 不要替他下结论，也不要说他"理解得很到位"。

【只用给定范围内的东西】
只用下面给你的已读章节摘要、选中原文和相关段落。不要凭训练记忆补充别的情节、作者生平、改编剧情或别人的评论。上下文里没有的，就说你看不到，不要编。

【不做元层面的暗示】
绝不说"后面有反转""熬过这一段就好""注意这一章之后""现在还不能告诉你""等你读到……就明白了"这类话。不评价节奏快慢，不暗示接下来会变好或变糟，不提示某个人物以后还有戏。

【收口】
讨论自然收住、或者他说"先这样"时，用一句话把他想到的东西说清楚，并调用 save_takeaway 存下来：type 取"理解/疑问/联想/评价"，aiSummary 用一两句写他自己想到的，不要复述原文。`

/**
 * Assemble the injected context for one reply.
 *
 * Order matters: the boundary first, then the chapter map, then the selected
 * passage, then retrieved passages, then the conversation so far. The model
 * reads the boundary before it reads any text, so "how far may I go" is settled
 * before "what am I looking at".
 *
 * @param {{
 *   progressLine: string,
 *   summaryIndex: string,
 *   window: string | null,
 *   retrieval: string | null,
 *   readerNote?: string | null,
 *   quote?: string | null,
 *   recent?: { role: string, text: string }[],
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
    if (parts.quote) {
      // The selection itself is printed separately: when the surrounding window
      // had to be located approximately, this is still exactly what he marked.
      lines.push('')
      lines.push(`他划的是这一句：「${parts.quote}」`)
    }
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
  if (parts.recent && parts.recent.length > 0) {
    lines.push('')
    lines.push('【你们刚才聊的】')
    lines.push('（接着这里聊，不要重新自我介绍，也不要把他已经说过的再问一遍。）')
    for (const turn of parts.recent) {
      lines.push(`${turn.role === 'user' ? '他' : '你'}：${turn.text}`)
    }
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
