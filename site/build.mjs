/**
 * 官网构建脚本。
 *
 * 按 cloudflare-deploy skill 第 3 节的契约来写：
 * 1. 先校验、后写盘 —— 所有检查通过才动 dist
 * 2. 产物里不许残留模板占位符（扫描 `{{`）
 * 3. 断言关键内容存在（标题、版本号、页面链接）
 * 4. 首屏零外链 —— 不允许出现 http(s) 的 link/script/img/@import
 *
 * 用法：node build.mjs
 */
import { mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASES } from './data/changelog.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, 'dist')
const SRC = join(here, 'src')

const SITE = {
  name: 'Danmaku Enhance',
  tagline: '把弹弹play 的弹幕送进哔哩哔哩原生播放器',
  repo: 'https://github.com/IYIAK/agefans-enhance-for-bilibilli',
  upstream: 'https://github.com/IronKinoko/agefans-enhance',
  script: './index.user.js',
  version: RELEASES[0].version,
}

// ── 小工具：HTML 转义 ─────────────────────────────────────
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// ── 图标（内联 SVG，零外部请求）───────────────────────────
const ICONS = {
  danmaku: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.6 3.5A1 1 0 0 1 7 19.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4v2h2V8H6Zm4 0v2h8V8h-8Zm-4 4v2h8v-2H6Zm10 0v2h2v-2h-2Z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1 1.4 1.4 1-1a3 3 0 1 1 4.2 4.2l-2 2a3 3 0 0 1-4.2 0L10 13Zm4-2a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1-1.4-1.4-1 1a3 3 0 1 1-4.2-4.2l2-2a3 3 0 0 1 4.2 0L14 11Z"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5h18v2H3V5Zm3 6h12v2H6v-2Zm4 6h4v2h-4v-2Z"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 2 9 5-9 5-9-5 9-5Zm7.2 8.4L21 11.5l-9 5-9-5 1.8-1.1L12 14.2l7.2-3.8Zm0 4.6L21 16l-9 5-9-5 1.8-.9L12 18.7l7.2-3.7Z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4a6 6 0 1 0 3.7 10.7l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>`,
  panel: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h18v16H3V4Zm2 2v12h14V6H5Zm8 2h6v4h-6V8Z"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 3v6l5 3 1-1.7-4-2.3V7h-2Z"/></svg>`,
}

// ── 布局 ────────────────────────────────────────────────
function layout({ title, description, page, body }) {
  const nav = [
    { href: './index.html', label: '首页', id: 'home' },
    { href: './changelog.html', label: '更新日志', id: 'changelog' },
  ]
    .map(
      (item) =>
        `<a href="${item.href}"${
          item.id === page ? ' class="is-active"' : ''
        }>${esc(item.label)}</a>`
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0b0c0f">
<style>__STYLE__</style>
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="./index.html">
      ${ICONS.danmaku}
      <span>${esc(SITE.name)}</span>
      <small>v${esc(SITE.version)}</small>
    </a>
    <nav class="site-nav">${nav}</nav>
  </div>
</header>
${body}
<footer class="site-footer">
  <div class="wrap">
    <span>${esc(SITE.name)} · 基于 <a href="${SITE.upstream}" rel="noopener">agefans enhance</a> 的 fork</span>
    <span><a href="${SITE.repo}" rel="noopener">GitHub 仓库</a></span>
  </div>
</footer>
</body>
</html>
`
}

// ── 首页 ────────────────────────────────────────────────
function homePage() {
  const features = [
    {
      icon: ICONS.danmaku,
      title: '弹幕混流，不换播放器',
      desc: '把弹弹play 的弹幕并进 B 站原生弹幕流，播放器、快捷键、清晰度切换全都是你熟悉的那一套。',
    },
    {
      icon: ICONS.layers,
      title: '多源并存',
      desc: '弹弹play、哔哩哔哩链接、巴哈姆特动画疯链接可以同时挂着，最多 3 条 URL 源一起生效。',
    },
    {
      icon: ICONS.search,
      title: '智能匹配 + 手动兜底',
      desc: '标题清洗后逐级尝试 6 组关键词，按最长公共子串筛掉无关结果；不确定就列出候选让你选。',
    },
    {
      icon: ICONS.filter,
      title: '过滤器作用到全部弹幕',
      desc: '屏蔽词、屏蔽滚动/顶部/底部、合并相似、每分钟上限 —— 原生弹幕和注入弹幕一视同仁。',
    },
    {
      icon: ICONS.clock,
      title: '时间偏移可调',
      desc: '每个 URL 来源一个独立偏移量，可正可负，改完即时生效，对得上片头片尾。',
    },
    {
      icon: ICONS.panel,
      title: '藏在控制条里的面板',
      desc: '控制条右侧一个图标按钮，点开才出现，点面板外面自动收起，不挡画面。',
    },
  ]

  const sources = [
    {
      tag: '内置',
      title: '弹弹play',
      desc: '按番剧名 + 集数查询，自动记住匹配结果。',
    },
    {
      tag: '内置',
      title: '哔哩哔哩',
      desc: '贴视频 / 番剧 / 分P 链接，直接拉取该视频的弹幕。',
    },
    {
      tag: '内置',
      title: '巴哈姆特动画疯',
      desc: '贴单集链接，读取整季集列表与弹幕。',
    },
    {
      tag: '解析',
      title: '自动识别',
      desc: '粘贴链接即自动判别来源，不需要手动选类型。',
    },
  ]

  const steps = [
    { title: '装脚本', desc: '装好 Tampermonkey，把 index.user.js 拖进去或粘贴安装。' },
    { title: '开开关', desc: '打开 B 站任意视频，点控制条右侧的弹幕图标，打开「启用注入」。' },
    { title: '等匹配', desc: '面板自动按标题匹配番剧；不准就手动搜索，或者直接贴一个视频链接。' },
    { title: '调细节', desc: '时间对不上填偏移，弹幕太吵用过滤器，设置都按 cid 记住。' },
  ]

  const faqs = [
    {
      q: '打开开关后当前这一段没有弹幕？',
      a: `<p>B 站播放器会把已经请求过的分段缓存在内存里，开关打开前拉过的段不会重新请求。</p>
         <p>点面板里的「重新加载」，或者刷新页面后再开开关即可。</p>`,
    },
    {
      q: '匹配到的番剧不对 / 搜不到？',
      a: `<p>弹弹play 的搜索是纯子串包含，而且最多只返回 25 条、按 id 排序，所以短词搜不到是正常的 —— <strong>结果 0 条不代表库里没有</strong>。</p>
         <p>用面板里的手动搜索框输入更长的、更接近原名的一段的试试；或者在 B 站找到对应视频，直接把链接贴进 URL 弹幕源。</p>`,
    },
    {
      q: '会和 B 站原生弹幕重复吗？',
      a: `<p>默认开启「与原生去重」。会忽略空白、标点、全角半角和大小写做文本比对，撞原生 ±1.5 秒、注入之间 ±1.8 秒都算重复。</p>
         <p>如果你就是想让两边都显示，把它关掉即可。</p>`,
    },
    {
      q: '支持直播吗？',
      a: `<p>不支持。直播页没有分段弹幕接口，脚本会直接跳过。</p>`,
    },
    {
      q: '会影响原来 agefans 那些站点的功能吗？',
      a: `<p>不会。B 站走的是独立适配层，只接管弹幕分段请求和面板，原来替换播放器的那套逻辑一行没动。</p>`,
    },
    {
      q: '怎么确认装的是最新版？',
      a: `<p>面板标题旁边常驻显示当前运行的版本号。看不到版本号，说明装的还是旧脚本。</p>`,
    },
  ]

  const body = `
<main>
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow"><span class="dot"></span>v${esc(SITE.version)} · 支持哔哩哔哩</span>
      <h1>${esc(SITE.tagline)}</h1>
      <p class="lede">
        一个基于 agefans enhance 的 fork。不替换播放器，只接管弹幕分段请求 ——
        把弹弹play、其他视频站的弹幕混进你正在看的那个 B 站视频里，
        再配一套能按住刷屏的过滤器。
      </p>
      <div class="actions">
        <a class="btn btn--primary" href="${SITE.script}">安装脚本</a>
        <a class="btn btn--ghost" href="./changelog.html">查看更新日志</a>
      </div>
      <div class="metrics">
        <div class="metric"><div class="value">3</div><div class="label">URL 弹幕源上限</div></div>
        <div class="metric"><div class="value">6</div><div class="label">级关键词匹配</div></div>
        <div class="metric"><div class="value">±1.5s</div><div class="label">与原生去重窗口</div></div>
        <div class="metric"><div class="value">2</div><div class="label">内置弹幕站点</div></div>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>主要能力</h2>
        <p>围绕「在 B 站看得更舒服」这件事做的几块。</p>
      </div>
      <div class="grid">
        ${features
          .map(
            (f) => `<article class="card">
          <span class="icon">${f.icon}</span>
          <h3>${esc(f.title)}</h3>
          <p>${esc(f.desc)}</p>
        </article>`
          )
          .join('\n        ')}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>弹幕从哪来</h2>
        <p>内置两个站点，粘贴链接自动识别；和弹弹play 可以同时生效。</p>
      </div>
      <div class="sources">
        ${sources
          .map(
            (s) => `<div class="source">
          <span class="tag">${esc(s.tag)}</span>
          <div>
            <h3>${esc(s.title)}</h3>
            <p>${esc(s.desc)}</p>
          </div>
        </div>`
          )
          .join('\n        ')}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>怎么用</h2>
        <p>四步，大概两分钟。</p>
      </div>
      <div class="steps">
        ${steps
          .map(
            (s) => `<div class="step">
          <h3>${esc(s.title)}</h3>
          <p>${esc(s.desc)}</p>
        </div>`
          )
          .join('\n        ')}
      </div>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>常见问题</h2>
        <p>踩过的坑，写在这里省得你再踩一遍。</p>
      </div>
      <div class="faq">
        ${faqs
          .map(
            (f) => `<details>
          <summary>${esc(f.q)}</summary>
          <div class="answer">${f.a}</div>
        </details>`
          )
          .join('\n        ')}
      </div>
    </div>
  </section>
</main>
`
  return layout({
    title: `${SITE.name} · ${SITE.tagline}`,
    description:
      '基于 agefans enhance 的用户脚本，把弹弹play、哔哩哔哩、巴哈姆特动画疯的弹幕混入 B 站原生播放器，不替换播放器。',
    page: 'home',
    body,
  })
}

// ── 更新日志 ────────────────────────────────────────────
function changelogPage() {
  const releases = RELEASES.map((release) => {
    const groups = release.groups
      .map(
        (group) => `<div class="group">
            <span class="group-name">${esc(group.name)}</span>
            <ul>
              ${group.items.map((item) => `<li>${esc(item)}</li>`).join('\n              ')}
            </ul>
          </div>`
      )
      .join('\n          ')

    return `<article class="release${release.latest ? ' is-latest' : ''}">
        <div class="release-card">
          <div class="release-head">
            <h2>${esc(release.version)}</h2>
            ${release.latest ? '<span class="badge">最新</span>' : ''}
            <span class="date">${esc(release.date)}</span>
          </div>
          <p class="release-summary">${esc(release.summary)}</p>
          ${groups}
        </div>
      </article>`
  }).join('\n      ')

  const body = `
<main>
  <div class="wrap">
    <div class="page-head">
      <h1>更新日志</h1>
      <p>从 fork 起点开始，按版本倒序。${esc(RELEASES.length)} 个条目。</p>
    </div>
    <div class="timeline">
      ${releases}
    </div>
  </div>
</main>
`
  return layout({
    title: `更新日志 · ${SITE.name}`,
    description: `${SITE.name} 的版本更新记录。`,
    page: 'changelog',
    body,
  })
}

// ── 404 ────────────────────────────────────────────────
// Workers 的 not_found_handling = "404-page" 要求 dist/404.html 存在，
// 否则线上会返回 200 + 空 body，看着像站点坏了。
function notFoundPage() {
  const body = `
<main>
  <div class="wrap">
    <div class="page-head">
      <h1>404 · 这个页面不存在</h1>
      <p>链接可能写错了，或者那一页还没做。回首页看看，或者去更新日志翻翻。</p>
    </div>
    <div class="actions">
      <a class="btn btn--primary" href="./index.html">回首页</a>
      <a class="btn btn--ghost" href="./changelog.html">看更新日志</a>
    </div>
  </div>
</main>
`
  return layout({
    title: `页面不存在 · ${SITE.name}`,
    description: `${SITE.name}：页面不存在。`,
    page: '404',
    body,
  })
}

// ── 构建主流程：先校验，后写盘 ────────────────────────────
async function main() {
  const css = await readFile(join(SRC, 'style.css'), 'utf8')
  if (!css.trim()) throw new Error('style.css 是空的')

  const pages = {
    'index.html': homePage(),
    'changelog.html': changelogPage(),
    '404.html': notFoundPage(),
  }

  const problems = []

  // 先渲染成最终 HTML，再校验渲染结果 —— 否则占位符检查必然误报
  const rendered = {}
  for (const [name, html] of Object.entries(pages)) {
    rendered[name] = html.replace('__STYLE__', () => css)
  }

  for (const [name, html] of Object.entries(rendered)) {
    // 1. 占位符必须全部替换完
    if (html.includes('__STYLE__')) {
      problems.push(`${name}: 残留 __STYLE__ 占位符`)
    }
    if (html.includes('{{')) {
      problems.push(`${name}: 残留 {{ 模板占位符`)
    }

    // 2. 样式必须真的注入进去
    if (!html.includes('.k-') && !html.includes('.hero')) {
      problems.push(`${name}: 样式没有注入`)
    }

    // 3. 首屏零外链：只允许 data: 和纯相对路径
    const external = [
      ...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g),
      ...html.matchAll(/@import\s+url\(["']?([^"')]+)/g),
      ...html.matchAll(/url\(\s*["']?(https?:\/\/[^"')]+)/g),
    ]
      .map((m) => m[1])
      .filter(
        (url) =>
          /^https?:\/\//i.test(url) &&
          // 页脚那几个是给人点的超链接，不是资源加载，允许
          !url.startsWith(SITE.repo) &&
          !url.startsWith(SITE.upstream)
      )
    if (external.length) {
      problems.push(`${name}: 存在外部资源请求 ${external.join(', ')}`)
    }

    // 4. 断言关键内容
    if (!html.includes(`v${SITE.version}`)) {
      problems.push(`${name}: 缺少版本号`)
    }
    if (!html.includes('changelog.html')) {
      problems.push(`${name}: 缺少更新日志入口`)
    }
    if (!html.includes('Danmaku Enhance')) {
      problems.push(`${name}: 缺少站点名`)
    }
  }

  // 首页特有断言
  const home = pages['index.html']
  for (const must of ['安装脚本', '主要能力', '常见问题', SITE.script]) {
    if (!home.includes(must)) problems.push(`index.html: 缺少「${must}」`)
  }

  // 更新日志特有断言
  const log = pages['changelog.html']
  if (!log.includes(SITE.version)) problems.push('changelog.html: 缺少最新版本号')
  for (const release of RELEASES) {
    if (!log.includes(release.version)) {
      problems.push(`changelog.html: 缺少版本 ${release.version}`)
    }
  }

  if (problems.length) {
    console.error('构建失败，未写入产物：')
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }

  // 校验全过，才动 dist
  if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true })
  await mkdir(DIST, { recursive: true })

  for (const [name, html] of Object.entries(rendered)) {
    await writeFile(join(DIST, name), html, 'utf8')
  }

  // 脚本本体如果有就一起带上，让下载链接指向同域
  const scriptSrc = join(here, '..', 'dist', 'index.user.js')
  if (existsSync(scriptSrc)) {
    const script = await readFile(scriptSrc)
    await writeFile(join(DIST, 'index.user.js'), script)
  } else {
    console.warn('提示：没找到 ../dist/index.user.js，跳过脚本本体拷贝')
  }

  const files = await readdir(DIST)
  console.log(`构建完成 → ${DIST}`)
  for (const file of files) {
    const size = (await readFile(join(DIST, file))).length
    console.log(`  ${file.padEnd(18)} ${size.toLocaleString()} bytes`)
  }
}

main().catch((error) => {
  console.error('构建异常：', error)
  process.exit(1)
})
