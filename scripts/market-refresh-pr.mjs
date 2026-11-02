#!/usr/bin/env node
/**
 * 更新已经开出去的收录 PR：把条目 yml 换成新文案，并改写 PR 标题与正文。
 *
 * 为什么单独一个脚本：market-pr.mjs 是「第一次投稿」，这个脚本是「稿子已经递了，
 * 我要把它改一遍」——它不新建分支、不新建 PR，只强推同一条分支 + PATCH 同一个 PR。
 *
 * 用法：
 *   node scripts/market-refresh-pr.mjs --owner OtakuP417 --repo dsh-reading-companion --pr 11258
 *
 * GH_TOKEN 从环境变量读；本机的取法见 PUBLISHING.md（git credential fill，别打印出来）。
 */
import { entryYml, prBody } from './listing.mjs'

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
if (!token || !args.owner || !args.repo || !args.pr) {
  console.error('用法：node scripts/market-refresh-pr.mjs --owner <user> --repo <repo> --pr <number>（GH_TOKEN 必填）')
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
    const error = new Error(`${method} ${path} → ${response.status} ${payload?.message ?? String(text).slice(0, 200)}`)
    error.status = response.status
    throw error
  }
  return payload
}

const slug = `${args.owner}/${args.repo}`
const ENTRY = entryYml({ owner: args.owner, repo: args.repo, category: args.category })
const BODY = prBody({ owner: args.owner, repo: args.repo })
const entryPath = `data/plugins/${args.owner}__${args.repo}.yml`

async function main() {
  const pull = await call('GET', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${args.pr}`)
  console.log(`现有 PR：${pull.html_url}（${pull.state}）`)

  // 1) 用新文案重建条目文件，强推同一条分支
  const blob = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/blobs`, {
    content: Buffer.from(ENTRY, 'utf8').toString('base64'),
    encoding: 'base64',
  })
  const head = await call('GET', `/repos/${args.owner}/${UPSTREAM.repo}/git/ref/heads/${args.branch}`)
  const parent = await call('GET', `/repos/${args.owner}/${UPSTREAM.repo}/git/commits/${head.object.sha}`)
  const tree = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/trees`, {
    base_tree: parent.tree.sha,
    tree: [{ path: entryPath, mode: '100644', type: 'blob', sha: blob.sha }],
  })
  const commit = await call('POST', `/repos/${args.owner}/${UPSTREAM.repo}/git/commits`, {
    message: 'Rewrite the listing description in plain language',
    tree: tree.sha,
    parents: [parent.sha],
  })
  await call('PATCH', `/repos/${args.owner}/${UPSTREAM.repo}/git/refs/heads/${args.branch}`, {
    sha: commit.sha,
    force: true,
  })
  console.log(`条目已更新：${entryPath} → ${commit.sha.slice(0, 7)}`)

  // 2) 改写 PR 标题与正文
  const updated = await call('PATCH', `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls/${args.pr}`, {
    title: `Add ${slug}`,
    body: BODY,
  })
  console.log(`PR 正文已更新：${updated.html_url}`)
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exit(1)
})
