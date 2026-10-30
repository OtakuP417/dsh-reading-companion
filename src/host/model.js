/**
 * Model access for the plugin's own background calls.
 *
 * The reading layer needs two kinds of small call: a chapter summary (cheap, one
 * tier below the chat model, fire-and-forget) and a single-turn answer about the
 * paragraph the reader selected. Both are plain `ctx.llm.stream` calls, so no
 * adapter knowledge lives here — only chunk assembly and route selection.
 */

/**
 * Read an optional service without requiring it in `inject`.
 *
 * `ctx.<service>` throws `cannot get property "llm" without inject`, and
 * declaring `llm`/`agentDefaultModel` as required injections would keep the
 * whole plugin inactive on a profile that has no model — which is exactly the
 * situation the review layer must survive. `ctx.reflect.get(name, false)`
 * resolves any registered service and returns undefined when it is absent.
 *
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
export function optionalService(ctx, name) {
  const readers = [() => ctx.reflect?.get?.(name, false), () => ctx.get?.(name)]
  for (const read of readers) {
    try {
      const service = read()
      if (service) return service
    } catch {
      // try the next accessor
    }
  }
  return null
}

/**
 * Resolve the route a background call should use.
 *
 * `config.summaryModel` / `config.summaryProvider` win when set; otherwise the
 * session default route is used. Summary calls are deliberately allowed to use a
 * cheaper model than the conversation.
 *
 * @param {any} ctx
 * @param {{ summaryModel?: string, summaryProvider?: string }} config
 * @param {{ provider?: string, model?: string } | null} [preferred]
 * @returns {{ provider: string, model: string } | null}
 */
export function resolveRoute(ctx, config, preferred = null) {
  const currentSelection = () => {
    // The service may be reachable directly or only through the lazy accessor;
    // both throw when the service is not provided in this context.
    const selection = optionalService(ctx, 'agentDefaultModel')?.currentSelection?.()
    return selection?.provider && selection?.model ? selection : null
  }
  const fallback = currentSelection()
  const provider = config.summaryProvider || preferred?.provider || fallback?.provider
  const model = config.summaryModel || preferred?.model || fallback?.model
  if (!provider || !model) return null
  return { provider, model }
}

/**
 * Drain a model stream into text. Reasoning deltas are dropped on purpose: a
 * chapter summary must be the answer, not the thinking.
 *
 * @param {any} ctx
 * @param {{ provider: string, model: string, system?: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal }} call
 * @returns {Promise<string>}
 */
export async function streamText(ctx, call) {
  const messages = []
  if (call.system) messages.push({ role: 'system', content: [{ type: 'text', text: call.system }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: call.prompt }] })

  let text = ''
  let failure = null
  let finish = null
  let reasoning = 0
  const llm = optionalService(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    const error = new Error('这个会话没有可用的模型服务')
    error.code = 'NO_LLM'
    throw error
  }
  const stream = llm.stream({
    provider: call.provider,
    model: call.model,
    messages,
    ...(call.maxTokens ? { maxTokens: call.maxTokens } : {}),
    ...(typeof call.temperature === 'number' ? { temperature: call.temperature } : {}),
    ...(call.signal ? { signal: call.signal } : {}),
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += 1
    else if (chunk.type === 'finish') {
      finish = chunk.reason ?? null
      if (finish?.kind === 'error') failure = finish.failure
    }
  }
  if (failure) {
    const error = new Error(failure.message ?? '模型调用失败')
    // @ts-expect-error augmenting a standard Error
    error.code = failure.code
    throw error
  }
  const answer = text.trim()
  if (!answer) {
    // A reasoning model can spend the whole budget thinking and emit no answer.
    // Say which one happened instead of "the model returned nothing".
    const spent = reasoning > 0
      ? '模型把这一轮的预算都用在思考上了'
      : '模型没有返回正文'
    const error = new Error(`${spent}（结束原因：${finish?.kind ?? 'unknown'}，思考片段 ${reasoning} 个）`)
    // @ts-expect-error augmenting a standard Error
    error.code = 'EMPTY_COMPLETION'
    throw error
  }
  return answer
}
