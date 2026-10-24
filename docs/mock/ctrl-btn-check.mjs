// 控制条图标对齐检查：用**真实的 B 站控制条样式**（从线上播放器内联 CSS 里
// 抄出来的那几条）渲染一排原生按钮 + 我们的注入按钮，量「图标垂直中心」
// 是否和邻居对得上，常规窗口与全屏两种尺寸都量。
//
//   node docs/mock/ctrl-btn-check.mjs
//
// 做这个脚本的原因：用户报「全屏插件 icon 位置偏高」。之前是自定义 26×26 盒子
// + translateY(-1px) 硬凑，常规窗口看着行，全屏时原生按钮放大到 54×43、
// 图标 28px，我们的尺寸写死就跟不上了。现在复用原生类名，这个脚本守住它。
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const require = createRequire(join(repo, 'package.json'))

function loadSass() {
  for (const base of [join(repo, 'package.json'), join(repo, 'node_modules/bocchi/package.json')]) {
    try {
      return createRequire(base)('sass')
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('没找到 sass')
}

const sass = loadSass()
const css = sass.compile(join(repo, 'src/adapter/bilibili/index.scss'), {
  style: 'expanded',
}).css

// 下面这段是 B 站播放器内联样式里与对齐相关的原文（2026-10 抓取，
// 分两处：按钮层 `.bpx-player-ctrl-btn*`，图标基类 `.bpx-common-svg-icon`）。
const NATIVE_CSS = `
.bpx-player-container { background: #000; }
.bpx-player-control-bottom {
  box-sizing: border-box; display: flex; height: 35px;
  justify-content: space-between; line-height: 22px; padding: 0 12px;
}
.bpx-player-control-bottom-right {
  display: flex; justify-content: flex-end; align-items: normal;
}
.bpx-common-svg-icon {
  display: inline-flex; height: 100%; width: 100%;
  -webkit-user-select: none; user-select: none;
}
.bpx-common-svg-icon svg { height: 100%; width: 100%; }
.bpx-player-ctrl-btn {
  fill: #fff; color: hsla(0, 0%, 100%, .8); font-size: 0; height: 22px;
  line-height: 22px; outline: 0; position: relative; text-align: center;
  width: 36px; z-index: 2;
}
.bpx-player-ctrl-btn-icon { cursor: pointer; width: 100%; display: block; }
.bpx-player-ctrl-btn-icon > .bpx-common-svg-icon {
  display: inline-flex; height: 22px; opacity: .9; vertical-align: middle;
}
.bpx-player-ctrl-btn-icon > .bpx-common-svg-icon svg { width: 100%; height: 100%; }
@media screen and (min-width: 750px) {
  .bpx-player-container[data-screen=full] .bpx-player-ctrl-btn,
  .bpx-player-container[data-screen=web] .bpx-player-ctrl-btn {
    height: 43px; line-height: 32px; width: 54px;
  }
  .bpx-player-container[data-screen=full] .bpx-player-ctrl-btn-icon > .bpx-common-svg-icon,
  .bpx-player-container[data-screen=web] .bpx-player-ctrl-btn-icon > .bpx-common-svg-icon {
    height: 28px;
  }
  .bpx-player-container[data-screen=full] .bpx-player-control-bottom,
  .bpx-player-container[data-screen=web] .bpx-player-control-bottom { height: 56px; }
}
`

const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/></svg>`

const nativeBtn = (label) => `
  <div class="bpx-player-ctrl-btn" data-native="${label}">
    <div class="bpx-player-ctrl-btn-icon">
      <span class="bpx-common-svg-icon">${ICON}</span>
    </div>
  </div>`

// 真实结构：我们的按钮 = div.__btn + 原生类名，内部结构与原生完全一致
// （bpx-player-ctrl-btn-icon > bpx-common-svg-icon > svg）。
// 用 div 而不是 button：Chrome 给 <button> 套了一层「内容垂直居中」的
// 匿名盒，原生那套 line-height + vertical-align 的对齐就失效了，实测全屏
// 图标会低 5.5px。BilibiliSponsorBlock 也是用 div。
const ourBtn = `
  <div class="k-bili-dm__btn bpx-player-ctrl-btn is-placed" role="button" tabindex="0" data-ours="1">
    <div class="bpx-player-ctrl-btn-icon">
      <span class="bpx-common-svg-icon">${ICON}</span>
    </div>
  </div>`

// 页面刚开始加载、播放器样式表还没插进来的那一瞬间：此时 `.bpx-player-ctrl-btn`
// 没有任何规则，我们的 svg 是 width/height:100%，没有尺寸来源就会被撑成整个
// 容器那么大 —— 用户报的「页面加载时会有一个超级大的 icon」。
// 所以按钮必须自带和原生一致的尺寸，不能指望播放器样式。
const earlyScene = `
<div class="early-wrap" id="early" style="width:1280px;background:#111;padding:8px">
  <div class="k-bili-dm__btn bpx-player-ctrl-btn is-placed" role="button" data-ours-early="1">
    <div class="bpx-player-ctrl-btn-icon">
      <span class="bpx-common-svg-icon">${ICON}</span>
    </div>
  </div>
</div>`

const scene = (screen) => `
<div class="bpx-player-container" data-screen="${screen}">
  <div class="bpx-player-control-bottom">
    <div class="bpx-player-control-bottom-left"></div>
    <div class="bpx-player-control-bottom-right" id="right-${screen}">
      ${nativeBtn('quality')}
      ${ourBtn}
      ${nativeBtn('widescreen')}
      ${nativeBtn('fullscreen')}
    </div>
  </div>
</div>`

const html = `<!doctype html><meta charset="utf-8">
<style id="native">${NATIVE_CSS}</style>
<style id="ours">${css}
  body { margin: 0; background: #111; font-family: system-ui, sans-serif; }
  .bpx-player-container { width: 1280px; margin-bottom: 20px; }
</style>
${scene('normal')}
${scene('full')}
${earlyScene}
<script>
  // 图标视觉中心 = svg 的垂直中点，相对控制条行盒。
  const iconCenter = (btn) => {
    const icon = btn.querySelector('svg') || btn
    const r = icon.getBoundingClientRect()
    return r.top + r.height / 2
  }
  const measure = (screen) => {
    const row = document.getElementById('right-' + screen)
    const btns = [...row.querySelectorAll('.bpx-player-ctrl-btn')]
    const centers = btns.map(iconCenter)
    // 每个按钮都算一遍「图标相对自己盒子」的偏移，用原生那几颗当基准，
    // 而不是拿「盒子正中」当基准——原生自己的图标也不在盒子正中
    // （line-height 22 / 43 里垂直居中，和盒中心差几个 px）。
    const geom = (btn) => {
      const box = btn.getBoundingClientRect()
      const svg = btn.querySelector('svg')
      const sb = svg.getBoundingClientRect()
      return {
        w: Math.round(box.width),
        h: Math.round(box.height),
        svgW: Math.round(sb.width),
        svgH: Math.round(sb.height),
        vGap: +((sb.top + sb.height / 2) - (box.top + box.height / 2)).toFixed(1),
        hGap: +((sb.left - box.left) - (box.right - sb.right)).toFixed(1),
      }
    }
    const ours = row.querySelector('[data-ours]')
    const ourBox = ours.getBoundingClientRect()
    const svg = ours.querySelector('svg')
    const svgBox = svg.getBoundingClientRect()
    const span = ours.querySelector('.bpx-common-svg-icon')
    const spanBox = span.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    const oursGeom = geom(ours)
    const nativeGeoms = [...row.querySelectorAll('[data-native]')].map(geom)
    return {
      centers,
      spread: Math.max(...centers) - Math.min(...centers),
      ourHeight: Math.round(ourBox.height),
      ourWidth: Math.round(ourBox.width),
      rowHeight: Math.round(rowBox.height),
      ourTop: Math.round(ourBox.top - rowBox.top),
      // —— 横向：图标在盒子里是不是居中 ——
      svgWidth: Math.round(svgBox.width),
      spanWidth: Math.round(spanBox.width),
      hGap: oursGeom.hGap,
      vGap: oursGeom.vGap,
      // 原生基准（第一颗原生按钮的几何）——我们应当和它完全一致
      nativeVGap: nativeGeoms[0]?.vGap ?? null,
      nativeHGap: nativeGeoms[0]?.hGap ?? null,
      nativeSvgW: nativeGeoms[0]?.svgW ?? null,
      nativeSvgH: nativeGeoms[0]?.svgH ?? null,
      svgHeight: Math.round(svgBox.height),
    }
  }
  // —— 播放器样式还没到的那一瞬间 ——
  // 停用**播放器**那份样式（脚本先跑、播放器的内联样式还没插进来），
  // 我们的样式保持生效：此前 .k-bili-dm__btn 不写任何尺寸，全靠
  // .bpx-player-ctrl-btn 撑，那条规则缺席时 svg 的 100% 就没有约束，
  // 按钮跟着控制条铺满整个宽度 —— 用户报的「页面加载时一个超级大的 icon」。
  const earlyBox = (() => {
    const probe = document.querySelector('[data-ours-early]')
    const nativeStyle = document.getElementById('native')
    nativeStyle.disabled = true
    const r = probe.getBoundingClientRect()
    const svgRect = probe.querySelector('svg').getBoundingClientRect()
    nativeStyle.disabled = false
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      svgW: Math.round(svgRect.width),
      svgH: Math.round(svgRect.height),
    }
  })()

  document.body.setAttribute('data-check', JSON.stringify({
    normal: measure('normal'),
    full: measure('full'),
    early: earlyBox,
  }))
</script>`

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const htmlPath = join(outDir, 'ctrl-btn-check.html')
writeFileSync(htmlPath, html, 'utf8')

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(edge)) {
  console.warn('没找到 Edge，HTML 已生成：' + htmlPath)
  process.exit(0)
}

const res = spawnSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${join(process.env.TEMP ?? here, 'edge-ctrl-check-' + Date.now())}`,
    '--window-size=1400,900',
    '--virtual-time-budget=3000',
    '--dump-dom',
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ],
  { encoding: 'utf8' }
)

const m = /data-check="([^"]+)"/.exec(res.stdout ?? '')
if (!m) {
  console.error('没拿到测量结果，stdout 前 400 字：\n' + (res.stdout ?? '').slice(0, 400))
  process.exit(1)
}
const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
console.log('测量结果：', JSON.stringify(data, null, 2))

const problems = []
for (const screen of ['normal', 'full']) {
  const d = data[screen]
  // 图标中心互差 1px 以内算对齐（亚像素渲染会有 0.5 的零头）
  if (d.spread > 1.5) {
    problems.push(`[${screen}] 图标中心不一致，最大差 ${d.spread.toFixed(1)}px（应为 0）`)
  }
  // 盒子高度要和原生按钮一致，否则整排看起来参差
  const wantH = screen === 'full' ? 43 : 22
  if (Math.abs(d.ourHeight - wantH) > 1) {
    problems.push(`[${screen}] 按钮高度 ${d.ourHeight}px，原生是 ${wantH}px`)
  }
  const wantW = screen === 'full' ? 54 : 36
  if (Math.abs(d.ourWidth - wantW) > 1) {
    problems.push(`[${screen}] 按钮宽度 ${d.ourWidth}px，原生是 ${wantW}px`)
  }
  // —— 横向 ——
  // 用户报「全屏之后图标明显太靠左、右边距太大」：根因是 svg 写死了 28px，
  // 装在 53px 宽的 span 里靠左对齐。svg 必须撑满 span（＝按钮内宽）。
  if (d.svgWidth < d.ourWidth - 2) {
    problems.push(
      `[${screen}] 图标只有 ${d.svgWidth}px 宽，按钮内宽 ${d.ourWidth}px —— 会贴左（应撑满）`
    )
  }
  // 基准用原生按钮自己的偏移，而不是「盒子正中」：原生图标也不在盒中心
  // （它跟着 line-height 走），我们要对齐的是原生，不是几何中心。
  if (Math.abs(d.hGap - d.nativeHGap) > 1) {
    problems.push(
      `[${screen}] 横向偏移和原生不一致：我们 ${d.hGap}px / 原生 ${d.nativeHGap}px（正数=偏右留白）`
    )
  }
  // —— 纵向 ——
  if (Math.abs(d.vGap - d.nativeVGap) > 1) {
    problems.push(
      `[${screen}] 纵向偏移和原生不一致：我们 ${d.vGap}px / 原生 ${d.nativeVGap}px（负数=偏高）`
    )
  }
  // 图标尺寸也要和原生一致，否则视觉重量不同
  if (Math.abs(d.svgWidth - d.nativeSvgW) > 1 || Math.abs(d.svgHeight - d.nativeSvgH) > 1) {
    problems.push(
      `[${screen}] 图标尺寸 ${d.svgWidth}×${d.svgHeight}px，原生是 ${d.nativeSvgW}×${d.nativeSvgH}px`
    )
  }
}

// 播放器样式还没到时的尺寸：必须和原生常态一致，绝不能跟着容器膨胀
const e = data.early
if (Math.abs(e.w - 36) > 1 || Math.abs(e.h - 22) > 1) {
  problems.push(
    `[early] 播放器样式缺席时按钮 ${e.w}×${e.h}px，应为 36×22（会在页面加载瞬间撑成大图标）`
  )
}
if (e.svgW > 40 || e.svgH > 40) {
  problems.push(`[early] 播放器样式缺席时图标 ${e.svgW}×${e.svgH}px，明显失控`)
}

if (problems.length) {
  console.error('\n❌ ' + [...new Set(problems)].join('\n❌ '))
  process.exit(1)
}
const n = data.normal
const f = data.full
console.log(
  `\n✅ 常规与全屏下图标都和原生按钮对得上` +
    `（常规 ${n.ourWidth}×${n.ourHeight} 图标 ${n.svgWidth}×${n.svgHeight}px 纵向 ${n.vGap}px；` +
    `全屏 ${f.ourWidth}×${f.ourHeight} 图标 ${f.svgWidth}×${f.svgHeight}px 纵向 ${f.vGap}px；` +
    `原生基准 常规 ${n.nativeVGap}px / 全屏 ${f.nativeVGap}px）`
)
