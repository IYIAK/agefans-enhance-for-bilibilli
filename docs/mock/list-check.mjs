// 候选列表布局的最小验证：用**真实面板样式**渲染 8 条候选，量一下
// 每条的实际高度、列表是否真的溢出（能不能滚）。
//
//   node docs/mock/list-check.mjs
//
// 做这个脚本的原因：用户连着两版反馈「候选行高度展示不全、不能滚动」，
// 只看 CSS 靠推理改了两轮都没修好。这里把样式编译出来直接让浏览器量。
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

const NAMES = [
  '攻壳机动队',
  '攻壳机动队 Stand Alone Complex',
  '攻壳机动队 无罪',
  '攻壳机动队 Stand Alone Complex 2nd GIG',
  '攻壳机动队 Stand Alone Complex 笑面男',
  '攻壳机动队 Stand Alone Complex 2nd GIG 个别的十一人',
  '攻壳机动队 ARISE',
  '攻壳机动队 2.0',
]

// 面板里这一块的真实结构：body（flex column，子项不收缩）里放
// 说明 + __list（flex column + max-height + overflow-y auto）+ 8 条 __item
//
// 两个场景都要量：
// - normal：面板够高，列表按自己的 200px 展示、内部滚动；
// - short：面板很矮（这里给 body 一个 150px 的高度并让它自己滚），
//   列表**不能**被压成 0 —— 用户报过「面板一矮整个列表就不见了」。
const html = `<!doctype html><meta charset="utf-8">
<style>${css}
  body { margin: 0; background: #0b0c0e; font-family: system-ui, sans-serif; }
  .stage { width: 280px; margin-bottom: 12px; }
  .k-bili-dm__body--short { max-height: 150px; }
</style>
<div class="k-bili-dm stage">
  <div class="k-bili-dm__body k-bili-dm__body--standalone">
    <div class="k-bili-dm__tip">找到多部可能匹配的番剧，请选择：</div>
    <div class="k-bili-dm__list" id="list">
      ${NAMES.map((n) => `<button class="k-bili-dm__item" title="${n}">${n}</button>`).join('\n      ')}
    </div>
    <div class="k-bili-dm__tip">下面是别的区块，用来确认列表没有把面板撑开</div>
  </div>
</div>
<div class="k-bili-dm stage">
  <div class="k-bili-dm__body k-bili-dm__body--short">
    <div class="k-bili-dm__tip">找到多部可能匹配的番剧，请选择：</div>
    <div class="k-bili-dm__list" id="list-short">
      ${NAMES.map((n) => `<button class="k-bili-dm__item" title="${n}">${n}</button>`).join('\n      ')}
    </div>
    <div class="k-bili-dm__tip">下面是别的区块，用来确认列表没有把面板撑开</div>
  </div>
</div>
<script>
  const measure = (id) => {
    const list = document.getElementById(id)
    const items = [...list.querySelectorAll('.k-bili-dm__item')]
    return {
      itemHeights: items.map((el) => Math.round(el.getBoundingClientRect().height)),
      listHeight: Math.round(list.getBoundingClientRect().height),
      contentHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      scrollable: list.scrollHeight > list.clientHeight + 1,
      textClipped: items.some((el) => el.scrollHeight > el.clientHeight + 1),
    }
  }
  const out = { normal: measure('list'), short: measure('list-short') }
  document.body.setAttribute('data-check', JSON.stringify(out))
</script>`

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const htmlPath = join(outDir, 'list-check.html')
writeFileSync(htmlPath, html, 'utf8')

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(edge)) {
  console.warn('没找到 Edge，HTML 已生成：' + htmlPath)
  process.exit(0)
}

// 用 --dump-dom 拿到脚本写进 data-check 的测量结果
const res = spawnSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${join(process.env.TEMP ?? here, 'edge-list-check-' + Date.now())}`,
    '--window-size=400,900',
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
const decoded = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const data = JSON.parse(decoded)
console.log('测量结果：', JSON.stringify(data, null, 2))

const want = 30 // 6px padding * 2 + 12px * 1.5 line-height = 30
const problems = []
for (const scene of ['normal', 'short']) {
  const d = data[scene]
  for (const h of d.itemHeights) {
    if (h < want - 1) problems.push(`[${scene}] 候选行被压扁：${h}px（应为 ${want}px）`)
  }
  if (!d.scrollable) problems.push(`[${scene}] 列表没有溢出、滚不动（scrollHeight 应大于 clientHeight）`)
  if (d.textClipped) problems.push(`[${scene}] 有行文字被自己裁掉了`)
  // 面板很矮时列表必须还在，不能被 flex 压成 0
  if (d.listHeight < 100) problems.push(`[${scene}] 列表高度只剩 ${d.listHeight}px，几乎看不见了`)
}

if (problems.length) {
  console.error('\n❌ ' + [...new Set(problems)].join('\n❌ '))
  process.exit(1)
}
const n = data.normal
const s = data.short
console.log(
  `\n✅ 两种面板高度下候选行都是 ${want}px、列表都能滚` +
    `（正常 ${n.clientHeight}/${n.contentHeight}px，面板矮 ${s.clientHeight}/${s.contentHeight}px，` +
    `列表高 ${s.listHeight}px）`
)
