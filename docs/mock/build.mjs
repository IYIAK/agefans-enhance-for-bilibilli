// 生成面板样式示意图（**不是** README 里的主图）。
//
// README 和官网主图已经换成真实运行截图（docs/screenshot-player.png），
// 这里是「只跑样式、不开 B 站」时的回归图，产物叫 screenshot-mock.png，
// 免得被误当成真实效果。
//
// 做法：把 src/adapter/bilibili/index.scss 编译出的**真实面板样式**注入
// panel-mock.html（模拟的播放器画面 + 与 panel.ts 生成结构一致的面板 DOM），
// 再用无头 Edge 截一张图。面板样式改了，重跑这个脚本图就跟着变，
// 不需要真的去 B 站开一个视频手动截。
//
//   node docs/mock/build.mjs
//
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const require = createRequire(join(repo, 'package.json'))

// sass 是 bocchi 的传递依赖，pnpm 的 isolate 布局下从根 package.json 解析不到，
// 所以退一步按 bocchi 的解析根来找。
function loadSass() {
  for (const base of [join(repo, 'package.json'), join(repo, 'node_modules/bocchi/package.json')]) {
    try {
      return createRequire(base)('sass')
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('没找到 sass（装依赖时没带 bocchi？）')
}

const sass = loadSass()
const css = sass.compile(join(repo, 'src/adapter/bilibili/index.scss'), {
  style: 'expanded',
}).css

const tpl = readFileSync(join(here, 'panel-mock.html'), 'utf8')
const html = tpl.replace('__PANEL_CSS__', css)

const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })
const htmlPath = join(outDir, 'panel-mock.html')
writeFileSync(htmlPath, html, 'utf8')
console.log(`mock → ${htmlPath}  (css ${css.length} B)`)

// 截图：无头 Edge 直接对 file:// 出图，不需要起服务器
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!existsSync(edge)) {
  console.warn('没找到 Edge，跳过截图（HTML 已经生成，可以自己打开看）')
  process.exit(0)
}
const shot = join(repo, 'docs', 'screenshot-mock.png')
const res = spawnSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    `--user-data-dir=${join(process.env.TEMP ?? here, 'edge-mock-' + Date.now())}`,
    '--window-size=1240,850',
    '--virtual-time-budget=4000',
    `--screenshot=${shot}`,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ],
  { stdio: 'ignore' }
)
console.log(res.status === 0 ? `shot → ${shot}` : `截图失败 status=${res.status}`)
