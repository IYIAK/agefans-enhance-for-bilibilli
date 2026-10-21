/**
 * B 站播放器的弹幕增强面板。
 *
 * 入口是控制条右侧的一个图标按钮，点开才显示面板（点面板外面自动收起），
 * 找不到控制条时退化成一个右下角的小胶囊。
 */
import type { BiliPageInfo } from './info'
import {
  forceReloadDanmaku,
  getStats,
  setComments,
  setDedupe,
  setEnabled,
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
import { loadConfig, saveConfig } from './store'
import type { BiliConfig } from './store'
import {
  addSource,
  getEntries,
  removeSource,
  resetUrlSources,
  restoreSources,
  setOffset,
  setPageKey,
  subscribe,
} from './sources/state'
import type { UrlSourceEntry } from './sources/state'

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

/** 控制条右侧的按钮容器（不同版本结构不一样，挨个试） */
const CONTROL_BAR_SELECTORS = [
  '.bpx-player-control-bottom-right',
  '.bilibili-player-video-btn-widescreen',
  '.bpx-player-ctrl-btn[aria-label]',
  '.bilibili-player-video-btn',
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
 * URL 来源的页面标识。优先用 cid（同一集的不同分P、不同线路都能区分开），
 * 拿不到 cid 时退回「番名 + 集数」。
 */
function pageKeyOf(info: BiliPageInfo) {
  if (info.cid) return `cid:${info.cid}`
  return `${info.seriesName || ''}#${info.episode ?? ''}`
}

export function mountPanel(info: BiliPageInfo): PanelHandle {
  const config: BiliConfig = loadConfig()

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
  const debugToggle = el('button', `${ROOT_CLASS}__debug-toggle`, '详情')
  debugToggle.type = 'button'
  const debugBox = el('div', `${ROOT_CLASS}__debug`)
  debugBox.hidden = true
  debugToggle.addEventListener('click', () => {
    debugBox.hidden = !debugBox.hidden
    debugToggle.textContent = debugBox.hidden ? '详情' : '收起'
  })
  status.append(statusMain, statusSub, debugToggle, debugBox)

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

  // 弹弹play
  // 这里原来有「重新匹配」「换番剧」两个按钮，语义和下面这排搜索完全重叠：
  // 点候选就是重新匹配，输入框里打字再按搜索就是换番剧。按钮只会让人猜
  // 它们和搜索的区别，所以去掉，只留搜索这一条路。
  const ddpTitle = el('div', `${ROOT_CLASS}__section`, '弹弹play 匹配')

  const searchRow = el('div', `${ROOT_CLASS}__row ${ROOT_CLASS}__row--input`)
  const searchInput = el('input', `${ROOT_CLASS}__input`) as HTMLInputElement
  searchInput.type = 'text'
  searchInput.placeholder = '番剧名（子串匹配）'
  searchInput.value = cleanTitle(info.seriesName)
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
  filterTitle.append(el('span', undefined, '过滤器'))
  const filterToggle = el(
    'button',
    `${ROOT_CLASS}__icon-text`,
    filterConfig.enabled ? '已启用' : '已关闭'
  )
  filterToggle.type = 'button'
  filterToggle.title = '过滤对原生与第三方弹幕一起生效'
  const filterReload = el('button', `${ROOT_CLASS}__icon-text`, '重新加载')
  filterReload.type = 'button'
  filterReload.title = '让播放器重新请求当前分段，新设置立刻生效'
  filterTitle.append(filterToggle, filterReload)

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
    '改完对之后加载的分段生效，点「重新加载」可以立刻重来一遍'
  )

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
    filterTip.textContent = '已保存；点「重新加载」对已加载的分段也生效'
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
    keywordBox,
    modeRow,
    mergeRow,
    densityRow,
    filterTip
  )
  panel.append(header, body)

  // ── 挂载 ────────────────────────────────────────────────
  document.body.append(panel)
  panel.classList.add('is-floating')

  let anchorRetry = 0
  let anchorTimer: number | undefined
  let detached = false

  function placeButton() {
    if (detached) return
    const anchor = findOne(CONTROL_BAR_SELECTORS)
    if (anchor) {
      anchor.append(button)
      return
    }
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

  function placePanel() {
    const bar = controlBarRect()
    const player = findOne(PLAYER_SELECTORS)
    if (!bar && !player) {
      panel.style.left = 'auto'
      panel.style.right = '16px'
      panel.style.bottom = '96px'
      panel.style.maxHeight = '70vh'
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
    // 上限：面板不能顶到播放器外面去
    const topLimit = playerRect ? playerRect.top + 8 : 8
    const available = Math.max(160, barTop - topLimit - 10)
    const maxHeight = Math.min(available, window.innerHeight - bottom - 12)

    panel.style.width = `${width}px`
    panel.style.left = `${Math.max(8, right - width - 8)}px`
    panel.style.right = 'auto'
    panel.style.bottom = `${bottom}px`
    panel.style.maxHeight = `${Math.min(maxHeight, window.innerHeight * 0.72)}px`
  }

  function open(next: boolean) {
    opened = next
    panel.hidden = !next
    button.classList.toggle('is-active', next)
    if (next) {
      placePanel()
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
    if (opened) placePanel()
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

  // ── 开关 ────────────────────────────────────────────────
  switchInput.addEventListener('change', () => {
    config.enabled = switchInput.checked
    saveConfig(config)
    setEnabled(config.enabled)
    render()
    if (config.enabled) void ensureMatch()
    else {
      setComments(null)
      setLoading(null)
    }
  })

  dedupeInput.addEventListener('change', () => {
    config.dedupe = dedupeInput.checked
    saveConfig(config)
    setDedupe(config.dedupe)
    render()
  })

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

  function resetMatch(nextNotice = '') {
    anime = undefined
    episode = undefined
    candidateList = []
    episodeOptions = []
    tried = []
    notice = nextNotice
    setComments(null)
  }

  function render() {
    if (opened) placePanel()
    renderStatus()
    renderCandidates()
    renderEpisodes()
    renderUrls()

    urlTip.classList.remove('is-error')
    urlTip.textContent = config.enabled
      ? 'URL 来源和弹弹play 可以同时生效；时间对不上时填偏移（秒）'
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
      } else if (stats.filtered > 0 || stats.droppedNative > 0) {
        statusSub.textContent = `当前分段没有可注入的弹幕，过滤器已作用在原生弹幕上（过滤 ${
          stats.filtered
        }${stats.droppedNative ? ` · 密度裁剪 ${stats.droppedNative}` : ''}）`
      } else if (stats.requests === 0) {
        statusSub.textContent = '等待播放器请求弹幕…'
      } else if (stats.armed === 0) {
        statusSub.textContent = '本段在开关打开前已加载，刷新页面即可生效'
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
   * 弹幕就绪后让播放器重新取一次当前分段。
   *
   * 播放器按 cid 缓存分段，开关在播放中途打开时当前段早就取过了，
   * 不会再发请求，hook 也就没机会合并。这里主动触发一次重新加载，
   * 并把命中的方法名放进状态行，方便确认到底生效没有。
   */
  function reloadDanmaku() {
    if (reloading) return
    reloading = true
    reloadHint = '正在让播放器重新加载弹幕…'
    render()

    void forceReloadDanmaku().then((method) => {
      reloading = false
      reloadHint = method
        ? ''
        : '弹幕已就绪，但没能触发重新请求（拖一下进度条或重开开关）'
      if (method) {
        console.info('[danmaku-enhance] 已通过', method, '触发弹幕重新加载')
      }
      render()
    })
  }

  async function ensureMatch() {
    if (!config.enabled) return
    busy = true
    resetMatch('匹配中…')
    render()

    const task = (async () => {
      try {
        const keyword = cleanTitle(info.seriesName)
        if (!keyword) throw new MatchError('没识别到当前视频的标题')

        // 走 6 候选关键词流程：命中即停，比整串搜索更容易命中
        const found = await findAnime(keyword, (msg) => {
          notice = msg
          if (opened) renderStatus()
        })
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
        busy = false
        notice =
          error instanceof MatchError
            ? error.message
            : `匹配失败：${(error as Error)?.message || error}`
        if (error instanceof MatchError) {
          tried = error.context.tried
          candidateList = error.context.animes.slice(0, 8)
          matchTip.textContent =
            '弹弹play 搜索是纯子串匹配、最多 25 条且不翻页。可以直接用下面的搜索框改词重试。'
        }
        render()
      }
    })()

    setLoading(task.then(() => undefined, () => undefined))
    await task
    setLoading(null)
  }

  function autoPick(list: AnimeItem[]) {
    if (!list.length) return undefined

    // 记住的映射优先
    const remembered = rememberedAnime(list, info.seriesName)
    if (remembered) return remembered

    const target = squash(info.seriesName).toLowerCase()
    const exact = list.find((o) => squash(o.name).toLowerCase() === target)
    if (exact) return exact

    // 剩下的交给 chooseAnime，包括「页面写第五季、库里只有第四季
    // 时不要自动选」这条 —— 面板这里别自己再实现一遍兜底逻辑。
    return chooseAnime(list, info)
  }

  async function pickAnime(item: AnimeItem, opts: { silent?: boolean } = {}) {
    busy = true
    notice = '读取集数…'
    anime = item
    candidateList = []
    episode = undefined
    render()

    try {
      const list = await episodeList(item.id)
      if (!list.length) {
        busy = false
        notice = `「${item.name}」没有可用集数`
        anime = undefined
        render()
        return
      }
      episodeOptions = list
      const guess = chooseEpisode(list, info)
      if (guess) {
        await pickEpisode(guess, opts)
        return
      }
      busy = false
      notice = ''
      render()
    } catch (error) {
      busy = false
      notice = `读取集数失败：${(error as Error)?.message || error}`
      anime = undefined
      render()
    }
  }

  async function pickEpisode(ep: EpisodeItem, opts: { silent?: boolean } = {}) {
    const current = anime
    if (!current) return
    busy = true
    notice = `加载「${ep.name}」弹幕…`
    render()

    try {
      const comments = await commentsOf(ep.id)
      if (!comments.length) {
        busy = false
        notice = `「${current.name}」${ep.name} 没有弹幕`
        render()
        return
      }
      episode = ep
      // 保留 episodeOptions：用户选错了要能再改回来
      notice = ''
      busy = false
      setComments(comments)
      rememberMatch(info, current, ep)
      render()
      // 弹幕就绪：让播放器把当前分段重新取一遍，否则已缓存的分段不会经过 hook
      reloadDanmaku()
    } catch (error) {
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
    busy = true
    notice = '搜索中…'
    candidateList = []
    anime = undefined
    episode = undefined
    episodeOptions = []
    setComments(null)
    render()

    try {
      const found = await manualSearch(keyword)
      busy = false
      if (!found.length) {
        notice = '没有结果'
        matchTip.textContent =
          '弹弹play 最多只回 25 条、按 id 升序且不翻页，短词可能搜不到，试试更长的子串。'
        render()
        return
      }
      tried = [keyword]
      notice = ''
      candidateList = found.slice(0, 8)
      matchTip.textContent = `「${keyword}」共 ${found.length} 条`
      render()
    } catch (error) {
      busy = false
      notice = `搜索失败：${(error as Error)?.message || error}`
      render()
    }
  }

  searchBtn.addEventListener('click', () => void doSearch())
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSearch()
  })

  filterReload.addEventListener('click', () => reloadDanmaku())

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

  const onBodyMutation = new MutationObserver(() => {
    if (opened) placePanel()
  })
  onBodyMutation.observe(document.body, { childList: true, subtree: true })

  // ── 初始化 ──────────────────────────────────────────────
  // URL 来源是按页面存的：换视频就不该看到上一个视频的来源
  setPageKey(pageKeyOf(info))
  setEnabled(config.enabled)
  setDedupe(config.dedupe)
  resetUrlSources()
  render()

  void (async () => {
    await restoreSources()
    render()
    if (config.enabled) void ensureMatch()
  })()

  return {
    dispose() {
      detached = true
      if (anchorTimer !== undefined) window.clearTimeout(anchorTimer)
      document.removeEventListener('click', onDocumentClick, true)
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      window.removeEventListener('resize', onResize)
      onBodyMutation.disconnect()
      unsubscribe()
      button.remove()
      panel.remove()
    },
  }
}
