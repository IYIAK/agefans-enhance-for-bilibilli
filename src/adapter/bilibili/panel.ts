/**
 * B 站播放器的弹幕增强面板。
 *
 * 入口是控制条右侧的一个图标按钮，点开才显示面板（点面板外面自动收起），
 * 找不到控制条时退化成一个右下角的小胶囊。
 */
import {
  readOwner,
  readBvid,
  readEpisodeId,
  readPageInfo,
  readVideoInfoByBvidAsync,
  readVideoInfoByCidAsync,
  resolveOwner,
  fetchUserName,
} from './info'
import type { BiliPageInfo } from './info'
import {
  forceReloadDanmaku,
  getStats,
  onCidChange,
  releaseHold,
  setCid,
  setComments,
  setDedupe,
  setEnabled,
  setExpecting,
  setHold,
  setLoading,
} from './hook'
import {
  MatchError,
  chooseAnime,
  chooseEpisode,
  cleanTitle,
  commentsOf,
  episodeList,
  findAnime,
  manualSearch,
  rememberMatch,
  rememberedAnime,
  squash,
} from './match'
import type { AnimeItem, EpisodeItem } from './match'
import { loadFilter, saveFilter } from './filters'
import type { FilterConfig } from './filters'
import { loadConfig, loadWhitelist, saveConfig, saveWhitelist } from './store'
import type { BiliConfig, WhitelistEntry } from './store'
import {
  addSource,
  getEntries,
  getTotalCount,
  removeSource,
  resetUrlSources,
  restoreSources,
  setOffset,
  setPageKey,
  subscribe,
} from './sources/state'
import type { UrlSourceEntry } from './sources/state'
import { clearToast, disposeToast, showToast } from './toast'

const ROOT_CLASS = 'k-bili-dm'

/**
 * 当前运行的脚本版本。
 *
 * 之前 @version 一直停在 1.60.3，改了多少轮都不变，结果就是：Tampermonkey
 * 判断不出版本更新，用户重装后也没法确认跑的是不是新脚本，只能靠肉眼比对
 * 界面差异，非常容易误判成「改了没生效」。把版本显示在面板标题旁边，
 * 一眼就能确认。
 */
function runningVersion(): string {
  try {
    const info = (typeof GM_info !== 'undefined' ? GM_info : undefined) as
      | { script?: { version?: string } }
      | undefined
    return info?.script?.version || ''
  } catch {
    return ''
  }
}

/**
 * 优先插到「清晰度」左边。这里只认清晰的单个节点，找不到再退回控制条右侧容器。
 * 注意不能拿控制条里任意按钮当兜底——兜底会命中左边的音量之类，
 * 图标就一会在左一会在右。
 */
const ICON_BEFORE_SELECTORS = [
  '.bpx-player-ctrl-quality',
  '.bpx-player-ctrl-quality-result',
  '.bpx-player-ctrl-btn[aria-label*="清晰度"]',
  '.bilibili-player-video-btn-quality',
]

const CONTROL_BAR_SELECTORS = [
  '.bpx-player-control-bottom-right',
  '.bilibili-player-video-control-bottom-right',
  '.bilibili-player-video-control .bilibili-player-video-btn-widescreen',
]

/** 播放器根节点，用来给面板定位 */
const PLAYER_SELECTORS = [
  '#bilibili-player',
  '.bpx-player-container',
  '#playerWrap',
  '#player',
]

const ANCHOR_RETRY = 12
const ANCHOR_RETRY_MS = 500

export interface PanelHandle {
  dispose(): void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function findOne<T extends Element = HTMLElement>(selectors: string[]) {
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    if (node) return node as T
  }
  return null
}

function formatOffset(offsetMs: number) {
  const value = Math.round(offsetMs / 100) / 10
  return String(value)
}

/**
 * 从用户输入里抠出 mid。
 *
 * 支持的写法：纯数字 UID、`space.bilibili.com/123`、
 * `space.bilibili.com/123/video`、带 `?mid=123` 的链接。
 * 不支持按名字：搜人的接口实测 412（要 cookie + wbi 签名），
 * 存名字既校验不了也没法用来比对，白名单只认 mid。
 */
function parseMid(input: string): number | undefined {
  const text = input.trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const fromQuery = text.match(/[?&]mid=(\d+)/)
  if (fromQuery) {
    const n = Number(fromQuery[1])
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  // space.bilibili.com/3493112693394137 这类主页链接
  const fromPath = text.match(/(\d{3,})/)
  if (fromPath) {
    const n = Number(fromPath[1])
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  return undefined
}

/**
 * URL 来源的页面标识。优先用 cid（同一集的不同分P、不同线路都能区分开），
 * 拿不到 cid 时用「当前 URL 上的 bvid + 集数」。
 *
 * 不能只用「番名 + 集数」：点相关推荐软跳转到另一个视频时，页面标题和
 * `__INITIAL_STATE__` 都可能还是上一个视频的，两条视频又都没读到 cid，
 * key 就一模一样，于是「换了视频还是上一个视频的匹配结果」。
 * bvid 是 URL 里唯一不会骗人的东西。
 */
function pageKeyOf(info: BiliPageInfo) {
  if (info.cid) return `cid:${info.cid}`
  const vid = readBvid()
  if (vid) return `vid:${vid}#${info.episode ?? ''}`
  return `${info.seriesName || ''}#${info.episode ?? ''}`
}

export function mountPanel(info: BiliPageInfo): PanelHandle {
  const config: BiliConfig = loadConfig()

  // 页面信息不能只在挂载时取一次。B 站换视频/切分P 有时并不重新执行
  // runtime 的 run()（相关推荐是局部重渲染，甚至不走 pushState），
  // 闭包里留着旧快照就会出现「用上一个视频的标题在匹配」。
  // 这里保留一个可变引用，另加一个轻量轮询发现变化后整体重置。
  let currentInfo: BiliPageInfo = info
  let currentPageKey = pageKeyOf(info)
  // URL 上的 bvid / ep_id。换视频、换集时它们是唯一立刻变化又不会撒谎的信号
  let currentVid = readBvid()
  let currentEp = readEpisodeId()

  // ── 控制条按钮 ───────────────────────────────────────────
  const button = el('div', `${ROOT_CLASS}__btn`)
  button.title = '第三方弹幕'
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.6 3.5A1 1 0 0 1 7 19.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4v2h2V8H6Zm4 0v2h8V8h-8Zm-4 4v2h8v-2H6Zm10 0v2h2v-2h-2Z"/></svg>'

  // ── 面板骨架 ────────────────────────────────────────────
  const panel = el('div', `${ROOT_CLASS}__panel`)
  panel.hidden = true

  const header = el('div', `${ROOT_CLASS}__header`)
  const titleText = el('span', `${ROOT_CLASS}__title`, '第三方弹幕')
  const version = runningVersion()
  const versionText = el('span', `${ROOT_CLASS}__version`, version ? `v${version}` : '')
  versionText.title = '当前运行的脚本版本，用来确认装的是不是最新的'
  const closeBtn = el('button', `${ROOT_CLASS}__close`, '×')
  closeBtn.title = '收起'
  header.append(titleText, versionText, closeBtn)

  const switchRow = el('label', `${ROOT_CLASS}__row`)
  const switchLabel = el('span', `${ROOT_CLASS}__label`, '启用注入')
  const switchBox = el('span', `${ROOT_CLASS}__switch`)
  const switchInput = el('input') as HTMLInputElement
  switchInput.type = 'checkbox'
  switchInput.checked = config.enabled
  switchBox.append(switchInput, el('span', `${ROOT_CLASS}__slider`))
  switchRow.append(switchLabel, switchBox)

  const dedupeRow = el('label', `${ROOT_CLASS}__row`)
  const dedupeLabel = el('span', `${ROOT_CLASS}__label`, '与原生去重')
  const dedupeBox = el('span', `${ROOT_CLASS}__switch`)
  const dedupeInput = el('input') as HTMLInputElement
  dedupeInput.type = 'checkbox'
  dedupeInput.checked = config.dedupe
  dedupeBox.append(dedupeInput, el('span', `${ROOT_CLASS}__slider`))
  dedupeRow.append(dedupeLabel, dedupeBox)

  const status = el('div', `${ROOT_CLASS}__status`)
  const statusMain = el('div', `${ROOT_CLASS}__status-main`)
  const statusSub = el('div', `${ROOT_CLASS}__status-sub`)
  const statusActions = el('div', `${ROOT_CLASS}__status-actions`)
  const debugToggle = el('button', `${ROOT_CLASS}__debug-toggle`, '详情')
  debugToggle.type = 'button'
  const debugBox = el('div', `${ROOT_CLASS}__debug`)
  debugBox.hidden = true
  debugToggle.addEventListener('click', () => {
    debugBox.hidden = !debugBox.hidden
    debugToggle.textContent = debugBox.hidden ? '详情' : '收起'
  })
  // 播放器把每一段弹幕的 Promise 按段号存在自己的内存里（DanmakuStore.allSegment），
  // 已经取过的那一段不会再请求第二次；bundle 里唯一能清这块缓存的 loadDmPbAll(reset)
  // 是死代码，也没有对外句柄。所以「这一段在我打开开关/选好集之前就取走了」这种情况，
  // 除了刷新页面没有别的补救办法。好在匹配结果按番名记着，刷新后第一段请求就能赶上。
  //
  // 文案上只给一句极短的「本段已缓存」，完整因果放在图标的 title 和「详情」里：
  // 这是一条边缘状态，不值得为它常驻一整行长解释，也不能让它把状态区撑高。
  // 按钮跟「详情」同一行 —— 都是「针对这条状态能做的动作」，放一起才有归属感。
  const pageReloadBtn = el('button', `${ROOT_CLASS}__status-reload`)
  pageReloadBtn.type = 'button'
  pageReloadBtn.hidden = true
  pageReloadBtn.title = '这一段在打开开关前就取走了，播放器不会重发；点这里刷新页面'
  pageReloadBtn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/>' +
    '<path d="M21 3v6h-6"/></svg>'
  pageReloadBtn.addEventListener('click', () => location.reload())

  statusActions.append(debugToggle, pageReloadBtn)
  status.append(statusMain, statusSub, statusActions, debugBox)

  // URL 源
  const urlTitle = el('div', `${ROOT_CLASS}__section`, 'URL 弹幕源')
  const urlInputRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  const urlInput = el('input', `${ROOT_CLASS}__input`) as HTMLInputElement
  urlInput.type = 'text'
  urlInput.placeholder = '粘贴 B站 / 巴哈姆特 视频链接'
  const urlAddBtn = el('button', `${ROOT_CLASS}__mini`, '添加')
  urlInputRow.append(urlInput, urlAddBtn)

  const urlList = el('div', `${ROOT_CLASS}__list`)
  const urlTip = el('div', `${ROOT_CLASS}__tip`)

  // ── UP 主白名单 ─────────────────────────────────────────
  //
  // 为什么要有：B 站视频一加载完就发第一段弹幕请求，播放器把它缓存在
  // DanmakuStore.allSegment 里，之后再选集也不会重发。于是「先播几秒才选集」
  // 这种情况，前 6 分钟永远没有第三方弹幕，而且没有任何运行时手段能补救
  // （player.reload 跳进度、seek 挪位置，都被否决过）。
  //
  // 白名单给出的答案是「一开始就别让它播」：这些 UP 主的视频，匹配没出结果
  // 之前把弹幕响应扣住不回，同时暂停播放；用户自己点播放就立刻放行。
  const whitelistTitle = el(
    'div',
    `${ROOT_CLASS}__section ${ROOT_CLASS}__section--row`
  )
  whitelistTitle.append(el('span', undefined, '强制匹配'))
  const whitelistCount = el('span', `${ROOT_CLASS}__fold-badge`)
  whitelistTitle.append(whitelistCount)

  const whitelistRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  const whitelistInput = el('input', `${ROOT_CLASS}__input`) as HTMLInputElement
  whitelistInput.type = 'text'
  whitelistInput.placeholder = 'UP 主 UID 或主页链接'
  const whitelistAddBtn = el('button', `${ROOT_CLASS}__mini`, '添加')
  whitelistRow.append(whitelistInput, whitelistAddBtn)

  const whitelistSelfBtn = el(
    'button',
    `${ROOT_CLASS}__minor`,
    '把当前视频的 UP 主加进来'
  )
  whitelistSelfBtn.type = 'button'

  const whitelistList = el('div', `${ROOT_CLASS}__list`)
  const whitelistTip = el('div', `${ROOT_CLASS}__tip`)

  // 弹弹play
  // 这里原来有「重新匹配」「换番剧」两个按钮，语义和下面这排搜索完全重叠：
  // 点候选就是重新匹配，输入框里打字再按搜索就是换番剧。按钮只会让人猜
  // 它们和搜索的区别，所以去掉，只留搜索这一条路。
  const ddpTitle = el('div', `${ROOT_CLASS}__section`, '弹弹play匹配')

  const searchRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  const searchInput = el('input', `${ROOT_CLASS}__input`) as HTMLInputElement
  searchInput.type = 'text'
  searchInput.placeholder = '番剧名（子串匹配）'
  searchInput.value = cleanTitle(currentInfo.seriesName)
  const searchBtn = el('button', `${ROOT_CLASS}__mini`, '搜索')
  searchRow.append(searchInput, searchBtn)

  const candidates = el('div', `${ROOT_CLASS}__list`)
  const episodeSelect = el('select', `${ROOT_CLASS}__select`) as HTMLSelectElement
  const matchTip = el('div', `${ROOT_CLASS}__tip`)

  // 过滤器（对齐 pakku 的核心能力）
  let filterConfig: FilterConfig = loadFilter()

  const filterTitle = el(
    'div',
    `${ROOT_CLASS}__section ${ROOT_CLASS}__section--row`
  )
  // 折叠按钮做成纯箭头图标：标题栏已经被「已启用」「立即生效」两个文字按钮占满，
  // 再塞一个「展开」两个字就会把「过滤器」挤得只剩一半宽度。
  // 箭头本身是通用隐喻（朝下=有内容被收起），比文字省地方。
  const filterFold = el('button', `${ROOT_CLASS}__fold-btn`)
  filterFold.type = 'button'
  filterFold.title = '展开过滤设置'
  filterFold.setAttribute('aria-expanded', 'false')
  filterFold.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>'
  const filterLabel = el('span', undefined, '过滤器')
  filterTitle.append(filterLabel)
  const filterToggle = el(
    'button',
    `${ROOT_CLASS}__icon-text`,
    filterConfig.enabled ? '已启用' : '已关闭'
  )
  filterToggle.type = 'button'
  filterToggle.title = '过滤对原生与第三方弹幕一起生效'
  // 运行时重载都试过了：player.reload 会让视频重新缓冲并把进度跳走，
  // 跨段 seek 会把播放位置挪到别的段——都被用户否掉。过滤器改动本来就
  // 即时保存、对之后的段生效，真要全部重取就老实刷新页面。
  const filterReload = el('button', `${ROOT_CLASS}__icon-text`, '刷新生效')
  filterReload.type = 'button'
  filterReload.title = '改动已保存；刷新页面后重新拉取弹幕'
  filterReload.addEventListener('click', () => location.reload())
  // 折叠按钮放最右：它管的是整块内容的显示，和「已启用」「刷新生效」
  // 这两个作用在弹幕上的开关不是一类，夹在中间会让人以为它也改配置。
  filterTitle.append(filterToggle, filterReload, filterFold)

  const keywordBox = el('textarea', `${ROOT_CLASS}__textarea`)
  keywordBox.rows = 3
  keywordBox.placeholder = '屏蔽词，一行一个；/正则/i 也行'
  keywordBox.value = filterConfig.keywords.join('\n')

  const modeRow = el('div', `${ROOT_CLASS}__checks`)
  const modeItems: { key: 'hideScroll' | 'hideTop' | 'hideBottom'; label: string }[] =
    [
      { key: 'hideScroll', label: '滚动' },
      { key: 'hideTop', label: '顶部' },
      { key: 'hideBottom', label: '底部' },
    ]
  const modeInputs: Partial<
    Record<'hideScroll' | 'hideTop' | 'hideBottom', HTMLInputElement>
  > = {}
  for (const item of modeItems) {
    const label = el('label', `${ROOT_CLASS}__check`)
    const input = el('input') as HTMLInputElement
    input.type = 'checkbox'
    // 勾上表示「屏蔽这类」
    input.checked = filterConfig[item.key]
    modeInputs[item.key] = input
    label.append(input, el('span', undefined, `屏蔽${item.label}`))
    modeRow.append(label)
  }

  const mergeRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  const mergeLabel = el('label', `${ROOT_CLASS}__check`)
  const mergeInput = el('input') as HTMLInputElement
  mergeInput.type = 'checkbox'
  mergeInput.checked = filterConfig.mergeSimilar
  mergeLabel.append(mergeInput, el('span', undefined, '合并相似弹幕'))
  const mergeWindow = el('input', `${ROOT_CLASS}__offset`) as HTMLInputElement
  mergeWindow.type = 'number'
  mergeWindow.min = '0'
  mergeWindow.step = '5'
  mergeWindow.value = String(filterConfig.mergeWindowSec)
  mergeRow.append(mergeLabel, mergeWindow, el('span', undefined, '秒内'))

  const densityRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  densityRow.append(el('span', undefined, '每分钟最多'))
  const densityInput = el('input', `${ROOT_CLASS}__offset`) as HTMLInputElement
  densityInput.type = 'number'
  densityInput.min = '0'
  densityInput.step = '10'
  densityInput.value = String(filterConfig.perMinute)
  densityRow.append(densityInput, el('span', undefined, '条（0 = 不限）'))

  const filterTip = el(
    'div',
    `${ROOT_CLASS}__tip`,
    '改动即时保存，对之后的弹幕生效；点「刷新生效」全部重取'
  )

  // 过滤器默认收起：它是最少改的一块，展开后要把面板撑得很长
  const filterBody = el('div', `${ROOT_CLASS}__fold`)
  filterBody.append(keywordBox, modeRow, mergeRow, densityRow, filterTip)
  filterBody.hidden = true
  filterFold.addEventListener('click', () => {
    filterBody.hidden = !filterBody.hidden
    filterFold.classList.toggle('is-expanded', !filterBody.hidden)
    filterFold.setAttribute('aria-expanded', String(!filterBody.hidden))
    filterFold.title = filterBody.hidden ? '展开过滤设置' : '收起过滤设置'
  })

  function readFilterFromDom(): FilterConfig {
    const next: FilterConfig = {
      ...filterConfig,
      keywords: keywordBox.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      hideScroll: !!modeInputs.hideScroll?.checked,
      hideTop: !!modeInputs.hideTop?.checked,
      hideBottom: !!modeInputs.hideBottom?.checked,
      mergeSimilar: mergeInput.checked,
      mergeWindowSec: Number(mergeWindow.value),
      perMinute: Number(densityInput.value),
    }
    if (!Number.isFinite(next.mergeWindowSec) || next.mergeWindowSec < 0) {
      next.mergeWindowSec = 0
    }
    if (!Number.isFinite(next.perMinute) || next.perMinute < 0) {
      next.perMinute = 0
    }
    return next
  }

  function onFilterChange() {
    filterConfig = readFilterFromDom()
    saveFilter(filterConfig)
    filterTip.textContent = '已保存，点「刷新生效」全部重取'
    render()
  }

  keywordBox.addEventListener('change', onFilterChange)
  for (const item of modeItems) {
    modeInputs[item.key]?.addEventListener('change', onFilterChange)
  }
  mergeInput.addEventListener('change', onFilterChange)
  mergeWindow.addEventListener('change', onFilterChange)
  densityInput.addEventListener('change', onFilterChange)

  filterToggle.addEventListener('click', () => {
    filterConfig = { ...readFilterFromDom(), enabled: !filterConfig.enabled }
    saveFilter(filterConfig)
    filterToggle.textContent = filterConfig.enabled ? '已启用' : '已关闭'
    filterTip.textContent = filterConfig.enabled
      ? '已启用：屏蔽词 / 类型 / 合并 / 密度对原生和第三方弹幕一起生效'
      : '已关闭：原生弹幕与注入弹幕都原样显示'
    render()
  })

  const body = el('div', `${ROOT_CLASS}__body`)
  body.append(
    switchRow,
    dedupeRow,
    status,
    whitelistTitle,
    whitelistRow,
    whitelistSelfBtn,
    whitelistList,
    whitelistTip,
    ddpTitle,
    searchRow,
    candidates,
    episodeSelect,
    matchTip,
    urlTitle,
    urlInputRow,
    urlList,
    urlTip,
    filterTitle,
    filterBody
  )
  panel.append(header, body)

  // ── 挂载 ────────────────────────────────────────────────
  document.body.append(panel)
  panel.classList.add('is-floating')

  let anchorRetry = 0
  let anchorTimer: number | undefined
  let detached = false
  let anchorEl: HTMLElement | null = null

  /**
   * 把按钮挂回控制条。优先插在「清晰度」左边（用户指定），插不进去就退回
   * 控制条右侧容器的末尾。B 站切全屏/宽屏时会重建控制条，原来的节点被丢掉，
   * 所以这事不能只做一次——挂丢了就重新挂。
   */
  function placeButton() {
    if (detached) return

    const before = findOne(ICON_BEFORE_SELECTORS)
    if (before && before.parentElement) {
      const target = before.parentElement
      anchorEl = target as HTMLElement
      if (button.parentElement !== target || button.nextElementSibling !== before) {
        target.insertBefore(button, before)
        button.classList.remove('is-floating')
      }
      return
    }

    const anchor = findOne(CONTROL_BAR_SELECTORS)
    if (anchor) {
      anchorEl = anchor as HTMLElement
      if (button.parentElement !== anchorEl) {
        anchorEl.append(button)
        button.classList.remove('is-floating')
      }
      return
    }
    if (button.parentElement) return
    if (anchorRetry++ >= ANCHOR_RETRY) {
      button.classList.add('is-floating')
      document.body.append(button)
      return
    }
    anchorTimer = window.setTimeout(placeButton, ANCHOR_RETRY_MS)
  }
  placeButton()

  // ── 面板开关与定位 ──────────────────────────────────────
  let opened = false

  /**
   * 控制条的位置。面板要贴着它的上沿浮起来——用播放器 rect.bottom 算不准，
   * 页面滚动或播放器比视口高的时候 bottom 会跑到屏幕外面去。
   */
  function controlBarRect(): DOMRect | null {
    const selectors = [
      '.bpx-player-control-wrap',
      '.bpx-player-control-bottom',
      '.bpx-player-control',
      '.bilibili-player-video-control',
    ]
    for (const selector of selectors) {
      const node = document.querySelector(selector)
      if (!node) continue
      const rect = node.getBoundingClientRect()
      if (rect.height > 0) return rect
    }
    return null
  }

  /**
   * 面板高度。只在打开、窗口尺寸变化、进出全屏时重算。
   *
   * 位置跟着滚动走（用户要求「面板要跟着页面滚动」），但高度钉住不动——
   * 滚动时播放器在动，跟着重算高度就会把面板越压越矮，那是上一版的毛病。
   */
  let pinnedMaxHeight = 0

  function placePanel(refit = false) {
    // 位置每次都算：面板是 position:fixed，不跟着滚动重算就会脱离播放器
    // 停在原地。高度只有在 refit 时才重算，避免越滚越矮。
    const recalcHeight = refit || !pinnedMaxHeight

    const bar = controlBarRect()
    const player = findOne(PLAYER_SELECTORS)
    if (!bar && !player) {
      panel.style.left = 'auto'
      panel.style.right = '16px'
      panel.style.bottom = '96px'
      if (recalcHeight) {
        pinnedMaxHeight = Math.round(window.innerHeight * 0.7)
      }
      panel.style.maxHeight = `${pinnedMaxHeight}px`
      return
    }

    const playerRect = player ? player.getBoundingClientRect() : null
    // 右侧对齐播放器；控制条一般比播放器窄，用两者外沿里更靠内的那个
    const right = Math.min(
      playerRect ? playerRect.right : window.innerWidth,
      bar ? bar.right : window.innerWidth
    )
    const width = Math.min(320, Math.max(280, (playerRect?.width || 640) * 0.32))

    // 底线 = 控制条上沿再往上一丢丢，和原生设置浮层同一层
    const barTop = bar ? bar.top : (playerRect?.bottom ?? window.innerHeight)
    const bottom = Math.max(8, window.innerHeight - barTop + 10)

    panel.style.width = `${width}px`
    panel.style.left = `${Math.max(8, right - width - 8)}px`
    panel.style.right = 'auto'
    panel.style.bottom = `${bottom}px`

    if (recalcHeight) {
      const room =
        playerRect && playerRect.height > 240
          ? playerRect.height - 56
          : window.innerHeight * 0.7
      pinnedMaxHeight = Math.round(
        Math.max(220, Math.min(room, window.innerHeight * 0.86))
      )
    }
    panel.style.maxHeight = `${pinnedMaxHeight}px`
  }

  function open(next: boolean) {
    opened = next
    panel.hidden = !next
    button.classList.toggle('is-active', next)
    if (next) {
      // 打开时重算一次高度；之后只有窗口尺寸变了才重算
      placeButton()
      placePanel(true)
      render()
    }
  }

  // 面板里可能长时间输入/拖选文字：只有「在面板外按下并在面板外松开」
  // 才算点外面，否则从输入框往外拖一下就误关了。
  let pressedInside = false

  function onDocumentMouseDown(e: MouseEvent) {
    const target = e.target as Node
    if (panel.contains(target) || button.contains(target)) {
      pressedInside = true
      return
    }
    pressedInside = false
  }

  function onDocumentClick(e: MouseEvent) {
    if (!opened) return
    const target = e.target as Node
    if (panel.contains(target) || button.contains(target)) return
    if (pressedInside) {
      pressedInside = false
      return
    }
    // 有选中文本时优先认为是拖选，不关面板
    if ((window.getSelection()?.toString() || '').length > 0) return
    open(false)
  }

  function onResize() {
    if (!opened) return
    // 窗口尺寸/全屏变了，可用空间才真的变了，这时候重算高度是对的
    pinnedMaxHeight = 0
    placeButton()
    placePanel(true)
  }

  /**
   * 面板是 position:fixed，不重算就会在页面滚动后脱离播放器停在原地。
   * 这里只重算位置、不动高度（高度跟着重算会越滚越矮，那是上一版的毛病）。
   * 用捕获阶段监听，播放器内部滚动容器的滚动也能收到；再用 rAF 合并成每帧一次。
   */
  let scrollRaf = 0

  function onScroll() {
    if (!opened || scrollRaf) return
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = 0
      if (opened) placePanel(false)
    })
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation()
    open(!opened)
  })
  closeBtn.addEventListener('click', () => open(false))
  panel.addEventListener('click', (e) => e.stopPropagation())
  // 用捕获阶段：B 站播放器在 click 上 stopPropagation（点画面=播放/暂停），
  // 冒泡到 document 的监听收不到，面板就永远关不上。
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('click', onDocumentClick, true)
  window.addEventListener('resize', onResize)
  // scroll 不冒泡，只能在捕获阶段拿到；这样播放器内部那几个滚动容器
  // （宽屏模式的推荐列表、番剧选集区）滚动时也能跟着重算
  window.addEventListener('scroll', onScroll, true)

  // ── 开关 ────────────────────────────────────────────────
  switchInput.addEventListener('change', () => {
    config.enabled = switchInput.checked
    saveConfig(config)
    setEnabled(config.enabled)
    render()
    if (config.enabled) {
      void ensureMatch()
    } else {
      setComments(null)
      setLoading(null)
      setExpecting(false)
      clearToast()
    }
  })

  dedupeInput.addEventListener('change', () => {
    config.dedupe = dedupeInput.checked
    saveConfig(config)
    setDedupe(config.dedupe)
    render()
  })

  // ── UP 主白名单 ─────────────────────────────────────────
  let whitelist: WhitelistEntry[] = loadWhitelist()
  /** 当前页面是否命中白名单（命中就走强制匹配） */
  let forced = false
  /** 是我们把视频按住的（用户自己暂停的不算，也就不能替他恢复） */
  let pausedByUs = false
  let pauseTimer: number | undefined
  let resumeTimer: number | undefined

  function isWhitelisted(mid?: number) {
    if (!mid) return false
    return whitelist.some((o) => o.mid === mid)
  }

  function persistWhitelist() {
    saveWhitelist(whitelist)
    renderWhitelist()
  }

  function renderWhitelist() {
    whitelistCount.textContent = whitelist.length ? String(whitelist.length) : ''
    whitelistList.textContent = ''
    if (!whitelist.length) {
      whitelistList.append(
        el('div', `${ROOT_CLASS}__tip`, '还没有强制匹配的 UP 主')
      )
    } else {
      for (const item of whitelist) {
        const row = el('div', `${ROOT_CLASS}__url`)
        const head = el('div', `${ROOT_CLASS}__url-head`)
        const name = el(
          'span',
          `${ROOT_CLASS}__url-name`,
          item.name || `UID ${item.mid}`
        )
        name.title = `UID ${item.mid}`
        const remove = el('button', `${ROOT_CLASS}__icon`, '×')
        remove.title = '移出白名单'
        remove.addEventListener('click', (e) => {
          e.stopPropagation()
          whitelist = whitelist.filter((o) => o.mid !== item.mid)
          persistWhitelist()
          void syncForced()
        })
        head.append(name, remove)
        row.append(head)
        whitelistList.append(row)
      }
    }
    whitelistTip.textContent = forced
      ? '当前视频的 UP 主在白名单里：匹配出结果前先按住播放'
      : '白名单 UP 主的视频会先暂停，等匹配出结果再开始'
  }

  /**
   * 判定当前页面要不要走强制匹配，并把结论同步给 hook。
   *
   * 只认 mid：按名字搜人的接口实测 412（要 cookie + wbi 签名），
   * 名字既无法校验也没法比对。
   */
  async function syncForced() {
    if (detached) return
    const owner = await resolveOwner().catch(() => undefined)
    if (detached) return
    const nextForced = isWhitelisted(owner?.mid)
    if (nextForced === forced) {
      // 白名单本身变了（加了/删了），即使当前页面结论没变也要重绘
      renderWhitelist()
      return
    }
    forced = nextForced
    setHold(forced)
    renderWhitelist()
    if (forced) {
      schedulePause()
    } else {
      // 退出强制匹配：把我们按住的视频放开，别留着用户一个暂停的画面
      cancelPause()
      releaseHold()
      resumeIfWePaused()
    }
  }

  /**
   * 白名单页面上「匹配没出结果就先暂停」。
   *
   * 等 1 秒才动手：绝大多数视频 1 秒内就匹配好了（实测弹弹play 通常
   * 一次往返），这种情况下暂停再恢复反而闪一下，体验更差。
   */
  function schedulePause() {
    cancelPause()
    pauseTimer = window.setTimeout(() => {
      pauseTimer = undefined
      if (!forced || detached) return
      // 已经匹配好了就别按了
      if (anime && episode) return
      const video = findOne<HTMLVideoElement>(['video'])
      if (!video) return
      if (video.paused) return
      pausedByUs = true
      try {
        video.pause()
      } catch {
        pausedByUs = false
      }
    }, 1000)
  }

  function cancelPause() {
    if (pauseTimer !== undefined) {
      window.clearTimeout(pauseTimer)
      pauseTimer = undefined
    }
  }

  /** 匹配成功后把我们自己按下的视频放开 */
  function resumeIfWePaused() {
    if (!pausedByUs) return
    pausedByUs = false
    if (resumeTimer !== undefined) window.clearTimeout(resumeTimer)
    // 稍等一下：匹配成功那一刻弹幕还在注入，立刻播放会先闪一段空的
    resumeTimer = window.setTimeout(() => {
      resumeTimer = undefined
      if (detached) return
      const video = findOne<HTMLVideoElement>(['video'])
      if (!video || !video.paused) return
      const played = video.play()
      if (played && typeof played.catch === 'function') played.catch(() => undefined)
    }, 300)
  }

  /**
   * 用户自己点了播放 = 他不想等匹配了。
   *
   * 立刻放行所有扣住的响应（否则播放器会一直等我们那一段），
   * 并把 pausedByUs 清掉——之后匹配成功也不要再去暂停/恢复他的视频。
   */
  function onVideoPlay() {
    if (!forced) return
    pausedByUs = false
    releaseHold()
    cancelPause()
  }

  function addWhitelistByMid(mid: number) {
    if (whitelist.some((o) => o.mid === mid)) return
    // 先用 UID 占位，名字异步补上（拿不到就一直显示 UID）
    whitelist = [...whitelist, { mid, name: '' }]
    persistWhitelist()
    void syncForced()
    void fetchUserName(mid).then((name) => {
      if (detached || !name) return
      whitelist = whitelist.map((o) => (o.mid === mid ? { ...o, name } : o))
      persistWhitelist()
    })
  }

  whitelistAddBtn.addEventListener('click', () => {
    const mid = parseMid(whitelistInput.value)
    if (!mid) {
      whitelistTip.textContent = '填 UID（纯数字）或 space.bilibili.com/123 这样的主页链接'
      return
    }
    addWhitelistByMid(mid)
    whitelistInput.value = ''
  })
  whitelistInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') whitelistAddBtn.click()
  })

  whitelistSelfBtn.addEventListener('click', () => {
    const owner = readOwner()
    if (owner) {
      addWhitelistByMid(owner.mid)
      return
    }
    whitelistSelfBtn.disabled = true
    void resolveOwner()
      .then((resolved) => {
        if (detached) return
        if (resolved) addWhitelistByMid(resolved.mid)
        else whitelistTip.textContent = '拿不到当前视频的 UP 主'
      })
      .finally(() => {
        whitelistSelfBtn.disabled = false
      })
  })

  // 用户点播放就放行。用捕获阶段，且只关心真正的 play（不是 seek 引起的）
  document.addEventListener('play', onVideoPlay, true)

  // ── 匹配状态 ────────────────────────────────────────────
  let anime: AnimeItem | undefined
  let episode: EpisodeItem | undefined
  let candidateList: AnimeItem[] = []
  let episodeOptions: EpisodeItem[] = []
  let tried: string[] = []
  let notice = ''
  let busy = false
  let reloadHint = ''
  let reloading = false
  // 匹配序号：每重置一次就 +1，异步链路在每个 await 之后核对。
  // 换视频/换集时上一轮的网络请求可能晚一步才回来，不拦住它就会把
  // 上一个视频的番名、集数、弹幕写进新页面——表现就是「换了视频还是
  // 上一个视频的匹配结果」。
  let matchSeq = 0

  function resetMatch(nextNotice = '') {
    matchSeq++
    anime = undefined
    episode = undefined
    candidateList = []
    episodeOptions = []
    tried = []
    notice = nextNotice
    setComments(null)
  }

  /** 异步链路里每个 await 之后都要问一句：我还是当前这一轮吗？ */
  function isCurrentMatch(seq: number) {
    return !detached && seq === matchSeq
  }

  function render() {
    if (opened) placePanel()
    renderStatus()
    renderCandidates()
    renderEpisodes()
    renderUrls()
    renderWhitelist()

    urlTip.classList.remove('is-error')
    urlTip.textContent = config.enabled
      ? 'URL来源和弹弹play可同时生效；支持时间轴偏移'
      : '先打开上面的开关'
  }

  /** 「详情」里展开的技术细节 */
  function debugLine(stats: ReturnType<typeof getStats>) {
    const parts = [
      `请求 ${stats.requests}`,
      `开闸 ${stats.armed}`,
      `接管 ${stats.reads}`,
      `通道 xhr${stats.xhrs}/fetch${stats.fetches}`,
      `合并 ${stats.segments} 段/${stats.injected} 条`,
      `错失 ${stats.missed} 段`,
      ...(stats.held ? [`扣住 ${stats.held} 段`] : []),
      `过滤 ${stats.filtered} 条／合并重复 ${stats.merged} 条` +
        (stats.droppedNative ? `／密度裁剪 ${stats.droppedNative} 条` : ''),
      `段 ${stats.lastSeg ?? '-'}／合至 ${stats.lastMergedSeg ?? '-'}`,
    ]
    let line = parts.join(' · ')
    if (stats.lastDetail) line += `\n${stats.lastDetail}`
    if (stats.lastState) line += `\n${stats.lastState}`
    if (stats.hook && stats.hook !== 'ok') line += `\nhook：${stats.hook}`
    return line
  }

  function renderStatus() {
    const stats = getStats()
    pageReloadBtn.hidden = true

    if (!config.enabled) {
      statusMain.textContent = '未开启'
      statusSub.textContent = '打开开关后才会向播放器注入弹幕'
      debugBox.textContent = ''
      return
    }
    if (busy && notice) {
      statusMain.textContent = notice
      statusSub.textContent = ''
      return
    }
    if (notice) {
      statusMain.textContent = notice
      // 候选关键词最多有 12 个，全铺在状态行里会糊成一片，只露前几个
      const shown = tried.slice(0, 5)
      const more = tried.length > shown.length ? ` …（共 ${tried.length} 个）` : ''
      statusSub.textContent = shown.length
        ? `试过：${shown.join(' / ')}${more}`
        : ''
      return
    }
    if (anime && episode) {
      statusMain.textContent = `${anime.name} · ${episode.name}`
      // 平时只给人看得懂的一句话，技术细节收进「详情」
      const extra = [
        stats.filtered ? `过滤 ${stats.filtered}` : '',
        stats.merged ? `合并 ${stats.merged}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      if (stats.injected > 0) {
        statusSub.textContent = stats.available
          ? `本次共 ${stats.available} 条，已注入 ${stats.injected} 条${
              extra ? `（${extra}）` : ''
            }`
          : `已注入 ${stats.injected} 条（${stats.segments} 段）${
              extra ? `（${extra}）` : ''
            }`
      } else if (stats.requests > 0 && stats.segments === 0 && stats.missed > 0) {
        // 有几段请求是在我们手上还没有候选弹幕的时候到的（匹配还没跑完，
        // 或者这一段在开关打开前就被取走了），播放器把它们缓存在内存里
        // 不会重发，只能刷新页面。
        //
        // 这个判断必须排在 filtered 之前、也不能依赖 reads。之前这里用的是
        // `armed === 0`，但开关是持久化的——刷新页面后一开始就是开的，
        // 所有请求都算 armed，条件永远不成立，于是滑到最后那个「已接管请求」
        // 的兜底分支上。
        statusSub.textContent = '本段已缓存，刷新生效'
        pageReloadBtn.hidden = false
      } else if (stats.filtered > 0 || stats.droppedNative > 0) {
        statusSub.textContent = `当前分段没有可注入的弹幕，过滤器已作用在原生弹幕上（过滤 ${
          stats.filtered
        }${stats.droppedNative ? ` · 密度裁剪 ${stats.droppedNative}` : ''}）`
      } else if (stats.requests === 0) {
        statusSub.textContent = '等待播放器请求弹幕…'
      } else if (stats.reads === 0) {
        statusSub.textContent = '已拦截请求，但还没有接管到响应'
      } else {
        statusSub.textContent = '已接管请求，当前分段没有可注入的弹幕'
      }
      debugBox.textContent = debugLine(stats)
      return
    }
    if (anime) {
      statusMain.textContent = anime.name
      statusSub.textContent = '请选择集数'
      return
    }
    statusMain.textContent = '等待匹配'
    statusSub.textContent = ''
  }

  function renderCandidates() {
    candidates.textContent = ''
    if (!candidateList.length) {
      candidates.hidden = true
      return
    }
    candidates.hidden = false
    candidates.append(
      el(
        'div',
        `${ROOT_CLASS}__tip`,
        anime ? '换一部：' : '找到多部可能匹配的番剧，请选择：'
      )
    )
    for (const item of candidateList) {
      const row = el('button', `${ROOT_CLASS}__item`, item.name)
      row.title = item.name
      row.classList.toggle('is-active', !!anime && anime.id === item.id)
      row.addEventListener('click', () => void pickAnime(item))
      candidates.append(row)
    }
  }

  function renderEpisodes() {
    episodeSelect.textContent = ''
    if (anime && episodeOptions.length) {
      episodeSelect.hidden = false
      const placeholder = el('option') as HTMLOptionElement
      placeholder.value = ''
      placeholder.textContent = '选择集数…'
      episodeSelect.append(placeholder)
      for (const ep of episodeOptions) {
        const opt = el('option') as HTMLOptionElement
        opt.value = String(ep.id)
        opt.textContent = ep.name
        opt.selected = !!episode && episode.id === ep.id
        episodeSelect.append(opt)
      }
      // 已经选过的集数要能在下拉里看到，否则用户以为改不了
      episodeSelect.value = episode ? String(episode.id) : ''
      return
    }
    episodeSelect.hidden = true
  }

  episodeSelect.addEventListener('change', () => {
    const id = episodeSelect.value
    if (!id) return
    const ep = episodeOptions.find((o) => String(o.id) === id)
    if (ep) void pickEpisode(ep)
  })

  function renderUrls() {
    const entries = getEntries()
    urlList.textContent = ''
    if (!entries.length) {
      urlList.append(el('div', `${ROOT_CLASS}__tip`, '还没有 URL 来源（最多 3 条）'))
      return
    }
    for (const entry of entries) urlList.append(renderUrlEntry(entry))
  }

  function renderUrlEntry(entry: UrlSourceEntry) {
    const box = el('div', `${ROOT_CLASS}__url`)

    const head = el('div', `${ROOT_CLASS}__url-head`)
    const name = el(
      'span',
      `${ROOT_CLASS}__url-name`,
      `${entry.sourceLabel} · ${entry.seriesTitle || '未命名'}`
    )
    name.title = `${entry.url}\n${entry.seriesTitle}`
    const remove = el('button', `${ROOT_CLASS}__icon`, '×')
    remove.title = '移除这条来源'
    remove.addEventListener('click', (e) => {
      e.stopPropagation()
      removeSource(entry.key)
    })
    head.append(name, remove)

    const epLine = el('div', `${ROOT_CLASS}__url-ep`)
    epLine.textContent =
      entry.episode.title + (entry.items.length ? ` · ${entry.items.length} 条` : '')

    const offsetRow = el('div', `${ROOT_CLASS}__url-offset`)
    offsetRow.append(el('span', undefined, '偏移'))
    const offsetInput = el('input', `${ROOT_CLASS}__offset`) as HTMLInputElement
    offsetInput.type = 'number'
    offsetInput.step = '0.5'
    offsetInput.value = formatOffset(entry.offsetMs)
    offsetInput.addEventListener('change', () => {
      const sec = Number(offsetInput.value)
      setOffset(entry.key, Number.isFinite(sec) ? sec : 0)
    })
    offsetRow.append(offsetInput, el('span', undefined, '秒'))

    const progress = el(
      'div',
      `${ROOT_CLASS}__url-progress`,
      entry.error
        ? `失败：${entry.error}`
        : entry.progress || (entry.loading ? '拉取中…' : '')
    )
    if (entry.error) progress.classList.add('is-error')

    box.append(head, epLine, offsetRow, progress)
    return box
  }

  // ── 匹配动作 ────────────────────────────────────────────

  /**
   * 换集后给播放器 800ms 自己重发弹幕请求（它换 cid 时本来就会重拉），
   * 看到了就清掉缓存提示。不再主动触发任何 seek/重载——那些方案都会
   * 把播放位置挪走，用户明确要求删干净。
   */
  function reloadDanmaku() {
    if (reloading) return
    reloading = true
    reloadHint = '正在等待弹幕重新加载…'
    render()

    void forceReloadDanmaku().then((method) => {
      reloading = false
      reloadHint = method
        ? ''
        : '改动已保存，之后的分段会自动生效；当前段要刷新页面才会重取'
      if (method) {
        console.info('[danmaku-enhance]', method, '弹幕已重新加载')
      }
      render()
    })
  }

  async function ensureMatch() {
    if (!config.enabled) return
    // 先登记「马上要匹配」，再去干那些耗时的事（读页面信息、恢复 URL 源、一次网络往返）。
    // 播放器的首段请求几乎总是落在这段空档里，没这个预登记它就只能被告知
    // 「没有匹配」而放行——首段于是永久丢掉，到第二段才开始有第三方弹幕。
    setExpecting(true)
    busy = true
    resetMatch('匹配中…')
    const seq = matchSeq
    render()

    const task = (async () => {
      try {
        const keyword = cleanTitle(currentInfo.seriesName)
        if (!keyword) throw new MatchError('没识别到当前视频的标题')

        // 走 6 候选关键词流程：命中即停，比整串搜索更容易命中
        const found = await findAnime(keyword, (msg) => {
          if (!isCurrentMatch(seq)) return
          notice = msg
          if (opened) renderStatus()
        })
        if (!isCurrentMatch(seq)) return
        tried = found.tried

        // 优先用记住的映射与精确同名，其次单条候选
        const picked = autoPick(found.animes)
        if (picked) {
          await pickAnime(picked, { silent: true })
          return
        }
        candidateList = found.animes.slice(0, 8)
        notice = '请选择番剧'
        busy = false
        render()
      } catch (error) {
        if (!isCurrentMatch(seq)) return
        busy = false
        notice =
          error instanceof MatchError
            ? error.message
            : `匹配失败：${(error as Error)?.message || error}`
        if (error instanceof MatchError) {
          tried = error.context.tried
          candidateList = error.context.animes.slice(0, 8)
          matchTip.textContent =
            '弹弹play搜索是纯子串匹配、最多 25 条且不翻页。可以直接用下面的搜索框改词重试。'
        }
        render()
      }
    })()

    setLoading(task.then(() => undefined, () => undefined))
    await task
    if (isCurrentMatch(seq)) {
      setLoading(null)
      // 匹配收场（成功或失败）。失败也要清掉预登记，否则之后到达的分段请求
      // 会白白等到 LOAD_WAIT_MS 才放行，每段弹幕都晚 8 秒。
      setExpecting(false)
    }
  }

  function autoPick(list: AnimeItem[]) {
    if (!list.length) return undefined

    // 记住的映射优先
    const remembered = rememberedAnime(list, currentInfo.seriesName)
    if (remembered) return remembered

    const target = squash(currentInfo.seriesName).toLowerCase()
    const exact = list.find((o) => squash(o.name).toLowerCase() === target)
    if (exact) return exact

    // 剩下的交给 chooseAnime，包括「页面写第五季、库里只有第四季
    // 时不要自动选」这条 —— 面板这里别自己再实现一遍兜底逻辑。
    return chooseAnime(list, currentInfo)
  }

  async function pickAnime(item: AnimeItem, opts: { silent?: boolean } = {}) {
    const seq = matchSeq
    busy = true
    notice = '读取集数…'
    anime = item
    candidateList = []
    episode = undefined
    render()

    try {
      const list = await episodeList(item.id)
      if (!isCurrentMatch(seq)) return
      if (!list.length) {
        busy = false
        notice = `「${item.name}」没有可用集数`
        anime = undefined
        render()
        return
      }
      episodeOptions = list
      const guess = chooseEpisode(list, currentInfo)
      if (guess) {
        await pickEpisode(guess, opts)
        return
      }
      busy = false
      notice = ''
      render()
    } catch (error) {
      if (!isCurrentMatch(seq)) return
      busy = false
      notice = `读取集数失败：${(error as Error)?.message || error}`
      anime = undefined
      render()
    }
  }

  async function pickEpisode(ep: EpisodeItem, opts: { silent?: boolean } = {}) {
    const current = anime
    if (!current) return
    const seq = matchSeq
    busy = true
    notice = `加载「${ep.name}」弹幕…`
    // 先把选集结果记下来：下拉框要立刻显示这一集，用户才看得出自动选了哪集、
    // 也才改得回去。之前这行在「没有弹幕」的 return 之后，于是那一集永远显示
    // 成「选择集数…」，看起来像没选。
    episode = ep
    render()

    try {
      const comments = await commentsOf(ep.id)
      // 用户在这期间换了视频/换了集：这批弹幕属于上一页，丢掉
      if (!isCurrentMatch(seq)) return
      if (!comments.length) {
        busy = false
        notice = `「${current.name}」${ep.name} 没有弹幕`
        setComments([])
        render()
        return
      }
      // 保留 episodeOptions：用户选错了要能再改回来
      notice = ''
      busy = false
      setComments(comments)
      rememberMatch(currentInfo, current, ep)
      render()
      // 匹配成功：左下角弹番剧名 + 条数，不用开面板也知道选对了哪部、有多少条。
      // 条数把已挂上的 URL 来源也算进去，那才是「整集一共有多少条三方弹幕」。
      announceMatch(current.name, ep.name, comments.length + getTotalCount())
      // 白名单页面是我们按住的，现在弹幕有了，替他把播放恢复上
      resumeIfWePaused()
      // 弹幕就绪：让播放器把当前分段重新取一遍，否则已缓存的分段不会经过 hook
      reloadDanmaku()
    } catch (error) {
      if (!isCurrentMatch(seq)) return
      busy = false
      notice = `加载弹幕失败：${(error as Error)?.message || error}`
      render()
    }
  }

  async function doSearch() {
    const keyword = searchInput.value.trim()
    if (keyword.length < 2) {
      notice = '至少输入 2 个字'
      render()
      return
    }
    // 手动搜索也算一次新的匹配：先把序号推进，让在途的自动匹配作废，
    // 否则它晚一步回来会把用户刚搜出来的候选列表盖掉。
    matchSeq++
    const seq = matchSeq
    busy = true
    notice = '搜索中…'
    candidateList = []
    anime = undefined
    episode = undefined
    episodeOptions = []
    // 手搜也是一次匹配：在这期间到达的分段请求应该等一下，而不是带着
    // 一份空的候选集被放行。
    setExpecting(true)
    setComments(null)
    render()

    try {
      const found = await manualSearch(keyword)
      if (!isCurrentMatch(seq)) return
      busy = false
      if (!found.length) {
        setExpecting(false)
        notice = '没有结果'
        matchTip.textContent =
          '弹弹play最多只回 25 条、按 id 升序且不翻页，短词可能搜不到，试试更长的子串。'
        render()
        return
      }
      tried = [keyword]
      notice = ''
      candidateList = found.slice(0, 8)
      matchTip.textContent = `「${keyword}」共 ${found.length} 条`
      render()
      // 候选有了，但还没选集，弹幕还不够：继续挂着，等用户点完候选。
      setExpecting(true)
    } catch (error) {
      if (!isCurrentMatch(seq)) return
      busy = false
      setExpecting(false)
      notice = `搜索失败：${(error as Error)?.message || error}`
      render()
    }
  }

  searchBtn.addEventListener('click', () => void doSearch())
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSearch()
  })

  // ── URL 来源 ────────────────────────────────────────────
  let adding = false

  async function onAddUrl() {
    const url = urlInput.value.trim()
    if (!url || adding) return
    adding = true
    urlAddBtn.textContent = '…'
    urlTip.classList.remove('is-error')
    try {
      await addSource(url)
      urlInput.value = ''
    } catch (error) {
      urlTip.textContent = `添加失败：${(error as Error)?.message || error}`
      urlTip.classList.add('is-error')
    } finally {
      adding = false
      urlAddBtn.textContent = '添加'
      render()
    }
  }

  urlAddBtn.addEventListener('click', () => void onAddUrl())
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void onAddUrl()
  })

  const unsubscribe = subscribe(() => {
    // 加载进度只在面板打开时重绘
    if (opened) renderUrls()
    renderStatus()
  })

  /**
   * 匹配成功时在播放器左下角弹两条提示，像第三方站点播放器进场那样：
   * 一条番剧名 + 集名，一条「已加载 N 条第三方弹幕」。
   *
   * 触发点是「匹配成功」而不是「这一分段注入了」——
   * 当前分段命中 0 条不代表整集没有弹幕，按分段算会让人以为没生效。
   * 条数也用整集的总数。
   */
  function announceMatch(name: string, episodeName: string, count: number) {
    if (detached) return
    const title = [name, episodeName].filter(Boolean).join(' · ')
    if (title) showToast(title, { key: 'title', duration: 4000 })
    if (count > 0) {
      showToast(`匹配成功，已加载 ${count} 条第三方弹幕`, {
        key: 'count',
        duration: 4000,
      })
    }
  }

  // 播放器切全屏/宽屏会重建控制条，按钮被丢掉就重新挂回去。
  // 面板本身的位置不再跟着 DOM 变动走——那会让它在滚动时乱跳。
  //
  // B 站页面的 DOM 变动极其频繁（弹幕列表、评论、推荐位都在动），
  // 所以这里不能每次变动都跑一遍 querySelector：
  //   1. 按钮还挂在文档里就直接返回，一次 parentElement 判断，零查询；
  //   2. 真的掉了才用 rAF 合并，一帧最多修一次。
  let replaceRaf = 0
  const onBodyMutation = new MutationObserver(() => {
    if (detached || replaceRaf) return
    if (button.isConnected && button.parentElement) return
    replaceRaf = window.requestAnimationFrame(() => {
      replaceRaf = 0
      placeButton()
    })
  })
  onBodyMutation.observe(document.body, { childList: true, subtree: true })

  // ── 初始化 ──────────────────────────────────────────────
  // URL 来源是按页面存的：换视频就不该看到上一个视频的来源
  setPageKey(currentPageKey)
  setEnabled(config.enabled)
  setDedupe(config.dedupe)
  resetUrlSources()
  render()
  // 先把上个视频的扣留状态清掉：新页面的第一段请求不该被上一页的白名单结论拖住，
  // 真正的结论由 syncForced 异步下发。
  setHold(false)
  // 白名单结论要在第一段弹幕请求到达之前就定下来（hook 靠 setHold 决定扣不扣），
  // 所以这里不 await，和其他初始化并行跑。
  void syncForced()

  void (async () => {
    // 挂载时先把「这真的属于当前 URL 的那条视频吗」验一遍。
    //
    // runtime 的 run() 在软跳转（点相关推荐）之后可能立刻执行，此时
    // `__INITIAL_STATE__` 还是上一个视频的、DOM 标题也没刷，readPageInfo()
    // 只能退回 readDomInfo() 拿到旧番名。老代码直接拿它去匹配，于是
    // 「换视频仍然显示上一个视频的结果」——而且因为 currentVid 是在挂载时
    // 读的（已经是新 bvid），checkPage 后面也发现不了差异。
    // 这里在开始匹配之前先按 URL 上的 bvid 问一次接口。
    if (currentVid && currentInfo.source !== 'video' && currentInfo.source !== 'bangumi') {
      const fresh = await readVideoInfoByBvidAsync(currentVid).catch(() => undefined)
      if (detached) return
      if (fresh && fresh.seriesName && fresh.seriesName !== currentInfo.seriesName) {
        console.info('[danmaku-enhance] 挂载时按 bvid 校正标题', {
          bvid: currentVid,
          from: currentInfo.seriesName,
          to: fresh.seriesName,
        })
        currentInfo = fresh
        currentPageKey = pageKeyOf(fresh)
        searchInput.value = cleanTitle(fresh.seriesName)
        setCid(fresh.cid)
        setPageKey(currentPageKey)
        render()
      }
    }
    await restoreSources()
    render()
    if (config.enabled) void ensureMatch()
  })()

  /**
   * 页面换了（换视频、切分P、切集）就整体重置一遍。
   *
   * 触发源（都不靠定时轮询）：
   *   1. `<title>` 的 MutationObserver —— B 站换视频/切分P 一定会改标题；
   *   2. runtime 派发的 `routechange` —— 走 pushState 的那部分跳转；
   *   3. 用户点开面板时再核对一次 —— 少数软跳转可能连标题都没改。
   *
   * 只比 cid / 番名+集数这一组 key，key 没变就直接返回，
   * 所以误报的代价只是几次属性读取。
   */
  function checkPage() {
    if (detached) return
    const next = readPageInfo()
    if (next.live) return

    // 换视频要最先判断，而且只认 URL 上的 bvid。
    // 点相关推荐是软跳转：URL 立刻变成新的 bvid，但 `__INITIAL_STATE__`
    // 还是上一个视频的、`document.title` 也可能慢半拍。这时读到的
    // seriesName/episode 全是旧的，靠它们比 key 会「看起来没变」。
    const nextVid = readBvid()
    if (nextVid && currentVid && nextVid !== currentVid) {
      console.info('[danmaku-enhance] 检测到换视频', { from: currentVid, to: nextVid })
      resetForPage(next, `vid:${nextVid}#${next.episode ?? ''}`, nextVid)
      return
    }

    // 番剧页同理：URL 上变的是 ep_id，换集时标题和 `__playinfo__`
    // 都可能还是上一集的。不单独比这一路，番剧切集永远发现不了。
    const nextEp = readEpisodeId()
    if (nextEp && currentEp && nextEp !== currentEp) {
      console.info('[danmaku-enhance] 检测到换集（URL ep_id 路径）', {
        from: currentEp,
        to: nextEp,
      })
      resetForPage(next, pageKeyOf(next), nextVid)
      return
    }
    if (nextEp !== currentEp) currentEp = nextEp

    // cid 路径已经确认过换集（pageKey 是 `cid:xxx`，这是最可靠的信号）。
    // 而 title/url 路径在运行时经常读不到分P（`__INITIAL_STATE__` 被 SPA
    // 改写，episode 和 cid 都是空）。这时拿退化信息覆盖会把正确状态冲掉
    // ——实测表现就是「toast 是第19话，面板却匹配成第18话」。
    // 所以：cid 已知而读到的信息连 cid 都没有时，直接跳过，等 cid 路径更新。
    if (currentPageKey.startsWith('cid:') && !next.cid && !next.episode) return
    const nextKey = pageKeyOf(next)
    if (nextKey === currentPageKey) return

    console.info('[danmaku-enhance] 检测到页面变化（title/url 路径）', {
      href: location.href,
      from: currentPageKey,
      to: nextKey,
      episode: next.episode,
      cid: next.cid,
    })
    resetForPage(next, nextKey, nextVid)
  }

  /** 换页面后的统一重置：面板状态、URL 源、播放器 cid 全部重新来一遍。 */
  function resetForPage(next: BiliPageInfo, nextKey: string, nextVid: string | undefined) {
    currentInfo = next
    currentPageKey = nextKey
    currentVid = nextVid
    currentEp = readEpisodeId()
    // 换视频了，上一条视频的轻提示没意义了，清掉
    clearToast()
    searchInput.value = cleanTitle(next.seriesName)
    matchTip.textContent = ''
    resetMatch('')
    setCid(next.cid)
    setPageKey(nextKey)
    resetUrlSources()
    render()
    void (async () => {
      // 软跳转到新视频时 `readPageInfo()` 给回的很可能是旧视频的标题
      // （`__INITIAL_STATE__` 没重写、DOM 还没刷）。按 URL 上的 bvid
      // 重新问一次接口，拿到真标题再匹配，否则会一直拿上一个视频去搜。
      if (nextVid && next.source !== 'video' && next.source !== 'bangumi') {
        const fresh = await readVideoInfoByBvidAsync(nextVid).catch(() => undefined)
        if (detached) return
        if (fresh && fresh.seriesName) {
          console.info('[danmaku-enhance] 按 bvid 重新取到标题', {
            bvid: nextVid,
            title: fresh.seriesName,
            episode: fresh.episode,
          })
          currentInfo = fresh
          currentPageKey = pageKeyOf(fresh)
          searchInput.value = cleanTitle(fresh.seriesName)
          setCid(fresh.cid)
          setPageKey(currentPageKey)
          render()
        }
      }
      await restoreSources()
      render()
      if (config.enabled) void ensureMatch()
    })()
  }

  /**
   * 播放器请求的 cid 变了 = 真的换集了（切分P / 切集）。
   *
   * 这条路和 checkPage() 互补：checkPage 靠读页面信息，切分P 时
   * `?p=` 不一定更新、`__INITIAL_STATE__` 也不会重写，于是它发现不了；
   * 但播放器换集必须用新 cid 去请求弹幕，这个 cid 我们拦得到。
   */
  const unsubscribeCid = onCidChange((cid) => {
    if (detached) return
    void readVideoInfoByCidAsync(cid).then((next) => {
      if (detached) return
      if (!next) {
        console.info('[danmaku-enhance] 播放器换了 cid，但 pages/接口都没找到', { cid })
        return
      }
      const nextKey = pageKeyOf(next)
      if (nextKey === currentPageKey) return

      console.info('[danmaku-enhance] 检测到换集（cid 路径）', {
        cid,
        from: currentPageKey,
        to: nextKey,
        episode: next.episode,
      })
      currentInfo = next
      currentPageKey = nextKey
      // 换集也可能伴着换视频（合集里点下一集跳到别的 bvid），
      // 这里顺手同步一次，避免 checkPage 拿旧的 bvid 再重置一遍
      currentVid = readBvid()
      currentEp = readEpisodeId()
      clearToast()
      searchInput.value = cleanTitle(next.seriesName)
      matchTip.textContent = ''
      resetMatch('')
      setCid(cid)
      setPageKey(nextKey)
      // URL 源是挂在 cid 上的，换集后要跟着换
      resetUrlSources()
      render()
      void (async () => {
        await restoreSources()
        render()
        if (config.enabled) void ensureMatch()
      })()
    })
  })

  let checkTimer: number | undefined
  function scheduleCheck() {
    if (detached) return
    if (checkTimer !== undefined) window.clearTimeout(checkTimer)
    // 300ms 防抖：换视频时会连着改好几次标题和 DOM，等它稳定下来再判定
    checkTimer = window.setTimeout(() => {
      checkTimer = undefined
      checkPage()
    }, 300)
  }

  // 标题节点可能被整个替换掉，所以要观察 head 的子树而不是 title 元素本身
  const titleWatch = new MutationObserver(scheduleCheck)
  titleWatch.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  window.addEventListener('routechange', scheduleCheck)
  window.addEventListener('popstate', scheduleCheck)

  /**
   * 直接盯 location.href。
   *
   * 前面几条路都可能哑火：站内切分P 时 title 不见得会改，而 B 站自己的
   * router 如果在我们打补丁之前就把原生 pushState 存进了闭包，那
   * runtime 包装出来的 routechange 也收不到。只有 location.href 一定会变
   * ——切分P 的 URL 上带着 `?p=N`。
   *
   * 每 500ms 比一次字符串，代价可以忽略；发现变化再走 300ms 防抖那套完整流程。
   */
  let watchedHref = location.href
  const urlWatch = window.setInterval(() => {
    if (detached) return
    if (location.href === watchedHref) return
    watchedHref = location.href
    scheduleCheck()
  }, 500)

  // 打开面板时再核对一次：万一换视频时标题正好没变（少数软跳转），
  // 用户点开面板这个动作本身就是最好的检查时机。
  button.addEventListener('click', scheduleCheck)

  return {
    dispose() {
      detached = true
      if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
      if (checkTimer !== undefined) window.clearTimeout(checkTimer)
      if (pauseTimer !== undefined) window.clearTimeout(pauseTimer)
      if (resumeTimer !== undefined) window.clearTimeout(resumeTimer)
      window.clearInterval(urlWatch)
      titleWatch.disconnect()
      window.removeEventListener('routechange', scheduleCheck)
      window.removeEventListener('popstate', scheduleCheck)
      document.removeEventListener('click', onDocumentClick, true)
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('play', onVideoPlay, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      if (scrollRaf) window.cancelAnimationFrame(scrollRaf)
      if (replaceRaf) window.cancelAnimationFrame(replaceRaf)
      onBodyMutation.disconnect()
      unsubscribe()
      unsubscribeCid()
      disposeToast()
      button.remove()
      panel.remove()
    },
  }
}
