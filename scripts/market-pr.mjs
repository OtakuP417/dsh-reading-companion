#!/usr/bin/env node
/**
 * 向 awesome-dsh-plugin 提一个收录 PR —— 全程走 api.github.com，
 * 不需要打开 github.com（在部分网络下 github.com:443 被阻断，api 仍可达）。
 *
 * 用法：
 *   $env:GH_TOKEN="ghp_xxx"
 *   node scripts/market-pr.mjs --owner <你的GitHub用户名> --repo dsh-reading-companion
 *
 * 前置：仓库已存在、已推上去、且已满 1 天（CI 会查，不够会挂，几小时后自己会过）。
 */
const API = 'https://api.github.com'
const UPSTREAM = { owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' }

function parseArgs(argv) {
  const args = { category: 'docs', branch: 'add-reading-companion' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    args[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const token = args.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
if (!token || !args.owner || !args.repo) {
  console.error('用法：node scripts/market-pr.mjs --owner <user> --repo <repo>（GH_TOKEN 必填）')
  process.exit(2)
}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) {
    const error = new Error(`${method} ${path} → ${response.status} ${payload?.message ?? text.slice(0, 200)}`)
    error.status = response.status
    throw error
  }
  return payload
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const ENTRY = `url: https://github.com/${args.owner}/${args.repo}
name: ${args.owner}/${args.repo}
category: ${args.category}
description:
  en: Read a book in a sidebar panel and talk about the part you have already read; it refuses to discuss anything further on, so it cannot spoil the story. Highlights and discussion turn into takeaways, takeaways become review cards, and a card jumps back to the sentence it came from.
  zh: 在侧栏的阅读面板里读书，只聊你已经读到的部分，后面的内容它看不到也不会说，所以不剧透。划线和讨论可以存成「收获」，收获会自动变成复习卡片，点卡片能跳回原来的那句话。
`

async function main() {
  const slug = `${args.owner}/${args.repo}`
  await call('GET', `/repos/${slug}`) // 不存在会直接抛 404，避免提一个死链
  const upstream = await call('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}`)
  const base = upstream.default_branch
  const baseSha = upstream.default_branch_sha ?? null
  console.log(`上游 ${UPSTREAM.owner}/${UPSTREAM.repo}@${base}`)

  // fork（已 fork 会 422，视为成功）
  try {
    await call('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`, { default_branch_only: true })
    console.log('已触发 fork，等待它出现…')
  } catch (error) {
    if (error.status !== 422) throw error
  }

  let fork = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      fork = await call('GET', `/repos/${args.owner}/${UPSTREAM.repo}`)
      break
    } catch (error) {
      if (error.status !== 404) throw error
      await sleep(2000)
    }
  }
  if (!fork) throw new Error('fork 迟迟没出现，稍后重试即可（fork 是异步的）')
  console.log(`fork 就绪：${fork.full_name}`)

  // 以 fork 的 base 分支为父提交（fork 刚建好时可能还是空的，退回上游 head）
  let parentSha = null
  try {
    const ref = await call('GET', `/repos/${args.owner}/${UPSTREAM.repo}/git/ref/heads/${base}`)
    parentSha = ref.object.sha
  } catch (error) {
    if (error.status !== 404) throw error
  }
  if (!parentSha) {
    const ref = await call('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/git/ref/heads/${base}`)
    parentSha = ref.object.sha
  }
  const parentCommit = await call('GET', `/repos/${args.owner}/${UPSTREAM.repo}/git/commits/${parentSha}`)
    .catch(() => call('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/git/commits/${parentSha}`))

  const path = `data/plugins/${args.owner}__${args.repo}.yml`
  const blob = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/blobs`, {
    content: Buffer.from(ENTRY, 'utf8').toString('base64'),
    encoding: 'base64',
  })
  const tree = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/trees`, {
    base_tree: parentCommit.tree.sha,
    tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }],
  })
  const commit = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/commits`, {
    message: `Add ${slug}`,
    tree: tree.sha,
    parents: [parentSha],
  })

  try {
    await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha: commit.sha,
    })
  } catch (error) {
    if (error.status !== 422) throw error
    await call('PATCH', `/repos/${args.owner}/${UPSTREAM.repo}/git/refs/heads/${args.branch}`, {
      sha: commit.sha,
      force: true,
    })
  }

  const pull = await call('POST', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
    title: `Add ${slug}`,
    head: `${args.owner}:${args.branch}`,
    base,
    body: `A reading companion for DSH: you read the book inside DSH and talk about the part you have already read.

**What a reader does with it**

1. Import a book (EPUB, MOBI, FB2, TXT, Markdown, HTML, or a CBZ comic). It opens as a full page in the left sidebar.
2. Read and turn pages as usual. The position is saved, so reopening lands on the same passage even after changing the font size.
3. Ask about what has been read, or highlight one sentence and ask about that sentence. Everything after the current position is not retrievable — the model cannot see it, so it cannot spoil the rest.
4. Keep something from the conversation as a takeaway. Takeaways become small review cards, and each card jumps back to the sentence it came from.

**What it is not**: a "summarize the whole book and chat about it" shell. There is no code path that hands unread text to the model.

**Listing checks**

- \`package.json\` declares \`dsh.bundle\` with \`dsh.bundle.patch\` → \`cordis.patch.yml\`.
- The UI registers \`sidebar.panellist\` and \`main\`; it does not write \`document.body\`, does not replace the app root, does not fill an existing slot through DOM selectors, and styles only with \`--dsw-alias-*\` tokens.
- The host half has no runtime dependencies; the client is one self-contained \`lib/client.js\` built into the repo, so installing from GitHub needs no build step.

**Try it**

\`\`\`
dsh plugin --profile desktop add "github:${slug}"
\`\`\`

Repo: https://github.com/${slug}`,
  })

  console.log(`\nPR 已开：${pull.html_url}`)
  console.log(`条目文件：${path}`)
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exit(1)
})
