/**
 * 播放器左下角的轻提示。
 *
 * 用途：匹配成功后不用打开面板也能知道「用的是哪部番、加载了多少条弹幕」。
 * 样式刻意做得像 B 站自己的提示（深色半透明圆角条、左侧带图标、自动淡出），
 * 位置贴着播放器左下角、控制条上方一点。
 *
 * 支持多条同时存在：番剧名一条、条数一条，竖着叠起来，像第三方站点播放器
 * 进场时那种「标题 + 提示」的效果。用 key 区分，同一个 key 再来一次就替换
 * 原来那条并重新计时，不会越堆越多。
 */

const ROOT_CLASS = 'k-bili-dm-toast'
const ITEM_CLASS = `${ROOT_CLASS}__item`

/** 播放器根节点，用来算提示的位置 */
const PLAYER_SELECTORS = [
  '#bilibili-player',
  '.bpx-player-container',
  '#playerWrap',
  '#player',
]

/** 控制条，提示要压在它上方 */
const CONTROL_BAR_SELECTORS = [
  '.bpx-player-control-wrap',
  '.bpx-player-control-bottom',
  '.bpx-player-control',
  '.bilibili-player-video-control',
]

const DEFAULT_DURATION = 3000

/** 最多同时挂几条，超了就把最老的挤掉 */
const MAX_ITEMS = 3

export interface ToastOptions {
  /** 同 key 的提示会替换而不是新增 */
  key?: string
  /** 显示时长（毫秒） */
  duration?: number
}

interface ToastItem {
  key: string
  node: HTMLDivElement
  hideTimer?: number
}

let host: HTMLDivElement | null = null
let items: ToastItem[] = []
let placeRaf = 0
let onScrollBound = false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function findOne(selectors: string[]) {
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    if (node) return node as HTMLElement
  }
  return null
}

/** 播放器左下角、控制条上方一点 */
function place(node: HTMLDivElement) {
  const player = findOne(PLAYER_SELECTORS)
  const playerRect = player ? player.getBoundingClientRect() : null
  const bar = findOne(CONTROL_BAR_SELECTORS)
  const barRect = bar ? bar.getBoundingClientRect() : null

  // 提示是往上叠的，锚点给最下面那一条用底部对齐
  if (playerRect && playerRect.width > 0) {
    node.style.left = `${Math.max(8, playerRect.left + 16)}px`
    node.style.bottom = barRect
      ? `${Math.max(8, window.innerHeight - barRect.top + 10)}px`
      : `${Math.max(8, window.innerHeight - playerRect.bottom + 52)}px`
    return
  }
  node.style.left = '16px'
  node.style.bottom = '120px'
}

function reposition() {
  if (!host || host.hidden) return
  if (placeRaf) return
  placeRaf = window.requestAnimationFrame(() => {
    placeRaf = 0
    if (host && !host.hidden) place(host)
  })
}

/**
 * 拖动播放器或页面滚动时提示会脱离播放器，所以显示期间要跟着重算。
 * 提示很短命（三秒左右），监听用完就摘掉。
 */
function bindFollow() {
  if (onScrollBound) return
  onScrollBound = true
  window.addEventListener('scroll', reposition, true)
  window.addEventListener('resize', reposition)
}

function unbindFollow() {
  if (!onScrollBound) return
  onScrollBound = false
  window.removeEventListener('scroll', reposition, true)
  window.removeEventListener('resize', reposition)
  if (placeRaf) {
    window.cancelAnimationFrame(placeRaf)
    placeRaf = 0
  }
}

function ensureHost() {
  if (host && host.isConnected) return host
  host = el('div', ROOT_CLASS)
  host.hidden = true
  document.body.append(host)
  // 宿主重建后旧节点已经不在文档里，清掉免得留着悬空引用
  items = []
  return host
}

function removeItem(item: ToastItem) {
  if (item.hideTimer !== undefined) window.clearTimeout(item.hideTimer)
  item.hideTimer = undefined
  item.node.classList.remove('is-visible')
  const node = item.node
  window.setTimeout(() => {
    node.remove()
    if (!host) return
    if (!items.length) {
      host.hidden = true
      unbindFollow()
    }
  }, 220)
}

function createItem(text: string): ToastItem {
  const node = el('div', ITEM_CLASS)
  const icon = el('span', `${ROOT_CLASS}__icon`)
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.6 3.5A1 1 0 0 1 7 19.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>'
  const label = el('span', `${ROOT_CLASS}__text`)
  label.textContent = text
  node.append(icon, label)
  return { key: text, node }
}

/**
 * 弹一条提示。
 *
 * - 不带 key：每次都是新的一条（同名文本也复用，避免重复刷屏）
 * - 带 key：同一 key 更新原来那条并重新计时
 */
export function showToast(text: string, options: ToastOptions | number = {}) {
  const opts: ToastOptions =
    typeof options === 'number' ? { duration: options } : options
  const key = opts.key || text
  const duration = opts.duration ?? DEFAULT_DURATION
  const root = ensureHost()

  let item = items.find((o) => o.key === key)
  if (item) {
    const label = item.node.querySelector(`.${ROOT_CLASS}__text`)
    if (label) label.textContent = text
    if (item.hideTimer !== undefined) {
      window.clearTimeout(item.hideTimer)
      item.hideTimer = undefined
    }
  } else {
    item = createItem(text)
    item.key = key
    root.append(item.node)
    items.push(item)
    // 超出上限就挤掉最老那条
    while (items.length > MAX_ITEMS) {
      const oldest = items.shift()
      if (oldest) removeItem(oldest)
    }
  }

  const target = item
  root.hidden = false
  place(root)
  bindFollow()
  // 先上屏再加 class，否则浏览器会把 hidden 前后的两次绘制合并，淡入失效
  void target.node.offsetWidth
  target.node.classList.add('is-visible')

  target.hideTimer = window.setTimeout(() => {
    target.hideTimer = undefined
    items = items.filter((o) => o !== target)
    removeItem(target)
  }, duration)
}

/** 一次性清掉所有提示（换视频时用） */
export function clearToast() {
  const list = items
  items = []
  list.forEach((item) => removeItem(item))
}

/** 面板销毁时一并清掉，避免留下孤儿节点和监听 */
export function disposeToast() {
  unbindFollow()
  items.forEach((item) => {
    if (item.hideTimer !== undefined) window.clearTimeout(item.hideTimer)
  })
  items = []
  host?.remove()
  host = null
}
