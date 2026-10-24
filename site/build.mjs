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
  tagline: '把弹弹play的弹幕送进哔哩哔哩原生播放器',
  repo: 'https://github.com/IYIAK/danmaku-enhance',
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
  user: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-8a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 9c-4.4 0-8 2.7-8 6v1h2v-1c0-2.2 2.7-4 6-4s6 1.8 6 4v1h2v-1c0-3.3-3.6-6-8-6Z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85V21c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>`,
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23fb7299' d='M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.6 3.5A1 1 0 0 1 7 19.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4v2h2V8H6Zm4 0v2h8V8h-8Zm-4 4v2h8v-2H6Zm10 0v2h2v-2h-2Z'/%3E%3C/svg%3E">
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
    <nav class="site-nav">${nav}<a class="gh-link" href="${SITE.repo}" rel="noopener" aria-label="GitHub 仓库" title="GitHub 仓库">${ICONS.github}</a></nav>
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
      title: '弹幕混流，播放器不变',
      desc: '第三方弹幕并入哔哩哔哩原生弹幕流，播放器、快捷键、清晰度与倍速均沿用原生实现。',
    },
    {
      icon: ICONS.layers,
      title: '多源并存',
      desc: '弹弹play、哔哩哔哩、巴哈姆特动画疯的弹幕可同时挂载，URL 弹幕源最多 3 条并行生效。',
    },
    {
      icon: ICONS.search,
      title: '标题自动匹配',
      desc: '对页面标题逐级清洗，依次尝试 6 组关键词，并以最长公共子串剔除无关结果；置信度不足时列出候选交由用户确认。',
    },
    {
      icon: ICONS.filter,
      title: '过滤器作用于全部弹幕',
      desc: '屏蔽词、按位置屏蔽（滚动／顶部／底部）、相似弹幕合并、每分钟密度上限，对原生弹幕与注入弹幕同时生效。',
    },
    {
      icon: ICONS.clock,
      title: '时间轴偏移',
      desc: '每个 URL 来源可单独设置偏移量，支持正负小数，修改即时保存，用于对齐片头片尾的差异。',
    },
    {
      icon: ICONS.panel,
      title: '控制条内嵌面板',
      desc: '控制条右侧提供入口图标，点击展开面板，点击面板外部或再次点击图标即可收起，不遮挡画面。',
    },
    {
      icon: ICONS.user,
      title: 'UP 主白名单',
      desc: '将常看的 UP 主加入白名单后，其视频会先完成匹配再开始播放，避免因延后选集而丢失首段弹幕。',
    },
  ]

  const sources = [
    {
      tag: '内置',
      title: '弹弹play',
      desc: '按番剧名与集数检索，匹配结果自动记忆。',
    },
    {
      tag: '内置',
      title: '哔哩哔哩',
      desc: '支持视频、番剧与分P 链接，直接拉取对应视频的弹幕。',
    },
    {
      tag: '内置',
      title: '巴哈姆特动画疯',
      desc: '粘贴单集链接，读取整季集列表与弹幕。',
    },
    {
      tag: '解析',
      title: '自动识别',
      desc: '粘贴链接后自动判别来源类型，无需手动选择。',
    },
  ]

  const steps = [
    { title: '安装脚本', desc: '安装 Tampermonkey 后，将 index.user.js 拖入或粘贴安装。' },
    { title: '启用注入', desc: '打开哔哩哔哩任意视频，点击控制条右侧的弹幕图标，开启「启用注入」。' },
    { title: '确认匹配', desc: '面板按标题自动匹配番剧；结果有误时可手动检索，或直接粘贴视频链接。' },
    { title: '调整细节', desc: '时间轴不符时填写偏移量；弹幕过密可使用过滤器。设置按 cid 记忆。' },
  ]

  const faqs = [
    {
      q: '开启后当前分段没有弹幕？',
      a: `<p>哔哩哔哩播放器会将已请求的分段缓存在内存中，开关开启前已加载的分段不会重新请求。</p>
         <p>点击面板中的「刷新生效」，或刷新页面后重新开启开关。</p>`,
    },
    {
      q: '匹配结果不正确或检索不到？',
      a: `<p>弹弹play采用纯子串检索，单次最多返回 25 条并按编号排序，因此较短的关键词可能无法命中——<strong>结果为 0 条并不代表库中不存在该作品</strong>。</p>
         <p>可在面板的手动搜索框中改用更长、更接近原名的片段重试；或在哔哩哔哩找到对应视频，将链接填入 URL 弹幕源。</p>`,
    },
    {
      q: '会与哔哩哔哩原生弹幕重复吗？',
      a: `<p>默认启用「与原生去重」。比对时忽略空白、标点、全角半角与大小写；与原生弹幕时间差 ±1.5 秒、注入弹幕之间 ±1.8 秒均视为重复。</p>
         <p>如需两侧同时显示，可关闭该选项。</p>`,
    },
    {
      q: '是否支持直播？',
      a: `<p>不支持。直播页面不提供分段弹幕接口，脚本会跳过。</p>`,
    },
    {
      q: '是否影响 agefans 原有站点的功能？',
      a: `<p>不影响。哔哩哔哩走独立适配层，仅接管弹幕分段请求与面板，原播放器替换逻辑未作改动。</p>`,
    },
    {
      q: '如何确认运行的是最新版本？',
      a: `<p>面板标题旁常驻显示当前运行的版本号；若无版本号，说明加载的仍是旧脚本。</p>`,
    },
  ]

  const body = `
<main>
  <section class="hero">
    <div class="wrap">
      <span class="eyebrow"><span class="dot"></span>v${esc(SITE.version)} · 支持哔哩哔哩</span>
      <h1>${esc(SITE.tagline)}</h1>
      <p class="lede">
        本项目是 agefans enhance 的 fork。它不替换播放器，而是接管弹幕分段请求，
        将弹弹play、哔哩哔哩其他投稿与巴哈姆特动画疯的弹幕合并到当前视频的弹幕流中。
      </p>
      <div class="actions">
        <a class="btn btn--primary" href="${SITE.script}">安装脚本</a>
        <a class="btn btn--ghost" href="./changelog.html">查看更新日志</a>
      </div>
    </div>
    <div class="wrap">
      <figure class="shot shot--wide">
        <img src="./img/player.jpg" alt="全屏播放哔哩哔哩视频时，第三方弹幕面板展开在播放器右侧，画面里同时跑着原生弹幕和注入弹幕" decoding="async">
        <figcaption>真实运行截图：哔哩哔哩原生播放器、原生控制条与原生弹幕设置均未改动，右侧为脚本附加的面板，左下角为注入结果提示</figcaption>
      </figure>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>它解决什么</h2>
        <p>弹幕通常与视频绑定：观看位置决定了可用的弹幕来源。</p>
      </div>
      <div class="grid">
        <article class="card">
          <h3>小站播放依赖网络状况</h3>
          <p>agefans enhance 覆盖的小型动漫站点受网络条件影响明显，高峰时段缓冲频繁；哔哩哔哩的 CDN 与画质表现更稳定。</p>
        </article>
        <article class="card">
          <h3>哔哩哔哩弹幕分散于多个投稿</h3>
          <p>同一部动画常有多个 UP 主投稿，观众与弹幕因此分散；弹幕数量最多的投稿，未必是翻译与画质最好的版本。</p>
        </article>
      </div>
      <p class="punch">本脚本将「在哪看」与「看哪份弹幕」解耦：留在哔哩哔哩观看，弹幕可从弹弹play、其他投稿与巴哈姆特动画疯引入。</p>
    </div>
  </section>

  <section class="section">
    <div class="wrap">
      <div class="section-head">
        <h2>主要能力</h2>
        <p>围绕「在哔哩哔哩获得更好的观看体验」提供的七项能力。</p>
      </div>
      <div class="grid grid--features">
        ${features
          .map(
            (f, i) => `<article class="card${i === 0 ? ' card--lead' : ''}">
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
        <h2>弹幕来源</h2>
        <p>内置哔哩哔哩与巴哈姆特动画疯两个站点，粘贴链接自动识别；可与弹弹play同时生效。</p>
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
        <h2>使用方法</h2>
        <p>共四步，约需两分钟。</p>
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
        <p>已知的边界情况与使用限制。</p>
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
      '基于 agefans enhance 的用户脚本，将弹弹play、哔哩哔哩与巴哈姆特动画疯的弹幕并入哔哩哔哩原生播放器，不替换播放器。',
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

  // 首页截图：HTML 引了就得真有这个文件，否则线上是破图
  const IMG_FILES = ['player.jpg']
  for (const name of IMG_FILES) {
    if (!home.includes(`./img/${name}`)) {
      problems.push(`index.html: 缺少截图引用 img/${name}`)
    }
    if (!existsSync(join(SRC, 'img', name))) {
      problems.push(`缺少截图源文件 src/img/${name}`)
    }
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

  // 截图：首页首屏那张，从 src/img 原样拷进 dist/img。
  // 首屏零外链的原则只约束「网络请求」，同域静态文件不影响。
  const imgSrc = join(SRC, 'img')
  const imgFiles = ['player.jpg']
  if (existsSync(imgSrc)) {
    await mkdir(join(DIST, 'img'), { recursive: true })
    for (const name of imgFiles) {
      const from = join(imgSrc, name)
      if (!existsSync(from)) {
        problems.push(`缺少截图 ${name}`)
        continue
      }
      await writeFile(join(DIST, 'img', name), await readFile(from))
    }
  } else {
    problems.push('缺少 src/img 目录（首页截图）')
  }

  // dist 里现在有 img/ 子目录：自己走一遍，只统计文件
  const walk = async (dir, prefix = '') => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)))
      else out.push(rel)
    }
    return out
  }
  console.log(`构建完成 → ${DIST}`)
  for (const rel of await walk(DIST)) {
    const size = (await readFile(join(DIST, rel))).length
    console.log(`  ${rel.padEnd(18)} ${size.toLocaleString()} bytes`)
  }
}

main().catch((error) => {
  console.error('构建异常：', error)
  process.exit(1)
})
