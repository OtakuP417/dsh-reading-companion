# 发布与收录 / Publishing

这个仓库同时走两条路：**市场收录**（必须在社区目录里挂一条）和 **npm 发布**（可选，但推荐）。

## 当前状态（2026-11-02）

- ✅ 仓库已建并推送：<https://github.com/OtakuP417/dsh-reading-companion>（public，`main`，topics 含 `dsh-plugin`）
- ✅ **收录 PR 已提交**：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11258>
  （条目文件 `data/plugins/OtakuP417__dsh-reading-companion.yml`，1 个文件 +6 行，等维护者 review）
- ⚠️ npm 暂缓：`www.npmjs.com` 的注册/登录页在当前网络下返回 403（`registry.npmjs.org` 本身是通的，已注册的账号仍可 `npm login --auth-type=legacy`）。没有 npm 包不影响收录，用户按 `github:` 形式安装即可

重开一次 PR 的命令（走 `api.github.com`，不需要打开网页；token 由 Git Credential Manager 提供）：

```powershell
node scripts/market-pr.mjs --owner OtakuP417 --repo dsh-reading-companion
```

---

## 一、市场是怎么收录插件的

DSH 的"插件市场"不是官方应用商店，而是社区维护的一份目录 + 一个市场插件：

| 角色 | 是什么 |
| --- | --- |
| 目录数据 | <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>（`data/plugins/*.yml`，约 7700 条） |
| 生成的清单 | `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（format 1 index，宿主 Discover 也读它） |
| 市场 UI | `dshmarket` 插件（本机已装：插件页 → 插件市场） |

**收录 = 给上面那个仓库提一个 PR，只加一个文件**：

```
data/plugins/<owner>__dsh-reading-companion.yml
```

内容（`category` 见下一节）：

```yaml
url: https://github.com/<owner>/dsh-reading-companion
name: <owner>/dsh-reading-companion
category: docs          # 见下方分类备选
description:
  en: A reading companion for DSH that keeps one CFI-based progress coordinate, gates every model call behind what you have actually read, and turns your own discussion into spaced-repetition cards.
  zh: 伴读插件：以 EPUB CFI 为唯一进度坐标，把模型能看到的范围硬性限制在已读章节，并把你自己的讨论收束成可复习的卡片。
# 可选：市场卡片图标（必须 GitHub 托管的 png/jpg/webp，≈96px 方形最清楚；SVG 不收）
# icon: https://raw.githubusercontent.com/<owner>/dsh-reading-companion/main/assets/icon-180.png
# 可选：预构建 tarball（不发 npm 时用）
# tarball: https://github.com/<owner>/dsh-reading-companion/releases/download/v0.1.0/dsh-reading-companion-0.1.0.tgz
```

> 描述只能陈述功能，不能带营销词；会被逐句对着代码核对。上面两句都是可核实的。

### 硬性门槛（逐条自查）

- [x] `package.json` 声明 `dsh.bundle.patch`（本仓库：`./cordis.patch.yml`）——**只声明 `dsh.client` 会被拒**
- [ ] 仓库公开，且**创建满 1 天**（CI 自动查；不够就等几小时再提）
- [ ] 仓库加了 **`dsh-plugin`** topic
- [x] 有真实可用的代码（不是占位/空壳）
- [x] 描述属实（不要写"支持 PDF"——本插件明确拒绝 PDF，README 已写明）
- [ ] 一个 PR 最多 3 条；只改自己的条目

### 分类怎么选

`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`

这个插件是"阅读 + 讨论 + 复习"，`docs` 最接近；`usage` 也可以（工具类增强）。选不准不会被拒，维护者会改。

---

## 二、npm 发布（可选，推荐）

好处：市场能显示下载量、预构建安装不需要 `allowBuilds` 构建授权；用户一条命令 `dsh-plugin add dsh-reading-companion` 就能装。

**命名**：`dsh-reading-companion` 目前在 npm 上无主（已确认 404），可直接占用。若被抢，改成 `@<你的scope>/dsh-reading-companion`。

**发布前必须先补 `package.json` 里的三行**（把 `<owner>` 换成你的 GitHub 用户名，否则 npm 包和市场条目关联不上）：

```jsonc
"repository": { "type": "git", "url": "git+https://github.com/<owner>/dsh-reading-companion.git" },
"homepage": "https://github.com/<owner>/dsh-reading-companion#readme",
"bugs": { "url": "https://github.com/<owner>/dsh-reading-companion/issues" },
```

然后：

```sh
cd D:\AiReading\plugin
npm login                     # 浏览器登录一次
npm publish                   # prepublishOnly 会自动 build + 跑测试
```

`files` 已经收好要发的东西（`lib/`、`cordis.patch.yml`、`locale/`、`icon.svg`、`README.md`、`LICENSE`、`THIRD-PARTY-NOTICES.md`），`src/`、`test/`、`vendor/` 不进包，`lib/` 是预构建产物，装完即可用。

---

## 三、从零到被收录的完整顺序

```sh
cd D:\AiReading\plugin

# 1. 补上 package.json 的 repository / homepage / bugs 三行（见上）

# 2. 初始化仓库并推送（新建一个空仓库 dsh-reading-companion，不要勾 README）
git init -b main
git add .
git commit -m "feat: reading companion plugin — CFI progress gate, Socratic discussion, model-free review"
git remote add origin https://github.com/<owner>/dsh-reading-companion.git
git push -u origin main

# 3. 在 GitHub 仓库页 → About 齿轮 → Topics 加 dsh-plugin

# 4. （可选，推荐）发布 npm
npm publish

# 5. fork awesome-dsh-plugin/awesome-dsh-plugin，加
#    data/plugins/<owner>__dsh-reading-companion.yml，提 PR
```

**注意仓库年龄门槛**：仓库建好满 1 天后 PR 才过 CI。可以先建仓库、先发 npm，第二天再提 PR。

`.gitignore` 已排除 `node_modules/`；`lib/` **要提交**——从 GitHub 安装时直接用它，不需要本地构建。

---

## 四、用户怎么装

```sh
# 发过 npm
dsh plugin --profile desktop add dsh-reading-companion

# 只有 GitHub
dsh plugin --profile desktop add "github:<owner>/dsh-reading-companion"

# 或在应用里：插件页 → 插件市场 → 搜索「伴读」→ 一键安装
```

装完要**重启应用**（Host 侧是 ESM，不做热替换）。

---

## 五、截图

`assets/screenshot-1.png` + 仓库根的 `screenshots.json` 已经就位（市场详情页的 AppStore 式截图，1–8 张，路径相对 `screenshots.json`）。
换图直接改 `assets/` 并提交，**不用再提 PR**，市场下一次构建自动更新。

想加市场卡片图标：放一张 180×180 的 PNG 到 `assets/icon-180.png`（GitHub 托管的位图，SVG 不收），然后取消上面 yml 里 `icon:` 的注释。
