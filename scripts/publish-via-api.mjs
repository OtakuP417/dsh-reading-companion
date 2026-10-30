#!/usr/bin/env node
/**
 * 通过 GitHub REST API 把一个目录发布成 GitHub 仓库。
 *
 * 为什么需要这个脚本：在部分网络下 github.com 的 443（网页 / git over HTTPS / SSH）
 * 全部被阻断，但 api.github.com、raw.githubusercontent.com、codeload.github.com 仍可达。
 * 于是「建仓库 + 推代码 + 打 topic」可以完全走 API 完成，不需要打开 github.com。
 *
 * 用法（token 需要 repo 权限，classic PAT 勾 repo 即可）：
 *   $env:GH_TOKEN="ghp_xxx"
 *   node scripts/publish-via-api.mjs --dir . --repo dsh-reading-companion
 *
 * 幂等：仓库已存在时会在当前 main 之上追加一个提交；文件内容没变时 GitHub 不会产生差异。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const API = 'https://api.github.com'

function parseArgs(argv) {
  const args = { dir: '.', repo: 'dsh-reading-companion', message: 'chore: sync from workspace' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    args[name] = value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const token = args.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
if (!token) {
  console.error('缺少 token：先设置环境变量 GH_TOKEN，或传 --token。')
  process.exit(2)
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.playwright', 'dist', 'coverage'])
const IGNORED_FILES = [/\.log$/, /^\.DS_Store$/, /^Thumbs\.db$/, /\.tgz$/]

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
    error.payload = payload
    throw error
  }
  return payload
}

async function walk(root, current = root, out = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      await walk(root, join(current, entry.name), out)
      continue
    }
    if (!entry.isFile()) continue
    if (IGNORED_FILES.some((pattern) => pattern.test(entry.name))) continue
    const absolute = join(current, entry.name)
    const path = relative(root, absolute).split(sep).join('/')
    out.push({ absolute, path })
  }
  return out
}

async function main() {
  const user = await call('GET', '/user')
  const owner = args.owner ?? user.login
  const repo = args.repo
  const files = await walk(args.dir)
  console.log(`账号 ${owner} · 待上传 ${files.length} 个文件 → ${owner}/${repo}`)

  let exists = true
  try {
    await call('GET', `/repos/${owner}/${repo}`)
  } catch (error) {
    if (error.status !== 404) throw error
    exists = false
  }

  if (!exists) {
    await call('POST', '/user/repos', {
      name: repo,
      private: false,
      description: '伴读 — DSH 阅读伴侣插件：CFI 进度门、苏格拉底式讨论、免模型的复习卡片',
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    })
    console.log(`已创建仓库 ${owner}/${repo}`)
  }

  // 已有 main 时以它为父提交，否则作为首次提交
  let parentSha = null
  try {
    const ref = await call('GET', `/repos/${owner}/${repo}/git/ref/heads/main`)
    parentSha = ref.object.sha
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const parentCommit = parentSha ? await call('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`) : null

  const tree = []
  let index = 0
  for (const file of files) {
    index += 1
    const buffer = await readFile(file.absolute)
    const blob = await call('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64',
    })
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
    if (index % 20 === 0 || index === files.length) console.log(`  已上传 ${index}/${files.length}`)
  }

  const newTree = await call('POST', `/repos/${owner}/${repo}/git/trees`, {
    ...(parentCommit ? { base_tree: parentCommit.tree.sha } : {}),
    tree,
  })
  const commit = await call('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: args.message,
    tree: newTree.sha,
    parents: parentSha ? [parentSha] : [],
  })

  if (parentSha) {
    await call('PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: commit.sha, force: false })
  } else {
    await call('POST', `/repos/${owner}/${repo}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
  }

  // 收录门槛之一：仓库要有 dsh-plugin topic
  try {
    await call('PUT', `/repos/${owner}/${repo}/topics`, { names: ['dsh-plugin', 'deepseek-harness', 'epub', 'reading'] })
  } catch (error) {
    console.warn(`topic 设置失败（不影响推送）：${error.message}`)
  }

  console.log(`\n完成：https://github.com/${owner}/${repo}/commit/${commit.sha}`)
  console.log('下一步：npm publish（registry.npmjs.org 在你这台机器上可达），然后把 PUBLISHING.md 里的 entry yml 提 PR。')
}

main().catch((error) => {
  console.error(`失败：${error.message}`)
  process.exit(1)
})
