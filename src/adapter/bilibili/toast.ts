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

import { mountOverlay, onFullscreenChange, overlayHost } from './overlay'

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

/** 视频画面，提示贴它的左沿（比播放器容器更准：容器含控制条和黑边） */
const VIDEO_SELECTORS = ['video.bpx-player-video', '.bpx-player-video-wrap video', 'video']

const DEFAULT_DURATION = 3000

/** 最多同时挂几条，超了就把最老的挤掉 */
const MAX_ITEMS = 3

export interface ToastOptions {
  /** 同 key 的提示会替换而不是新增 */
  key?: string
  /** 显示时长（毫秒） */
  duration?: number
  /**
   * 提示右侧的可点按钮（如「确认」）。带 action 的提示不会自动淡出，
   * 必须由调用方在动作完成后用 clearToast(key) 收掉——
   * 「等待用户确认」这类提示定时消失会让按钮跟着消失，确认就落空了。
   */
  action?: { label: string; onClick: () => void }
}

interface ToastItem {
  key: string
  node: HTMLDivElement
  hideTimer?: number
  /** 点击处理器要随 item 一起换掉，否则同 key 更新后触发的是旧的回调 */
  action?: { label: string; onClick: () => void }
}

let host: HTMLDivElement | null = null
let items: ToastItem[] = []
let placeRaf = 0
let onScrollBound = false
/** 全屏监听的注销函数，宿主存在期间保持一份 */
let unbindFullscreen: (() => void) | null = null

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

/**
 * 播放器左下角、控制条上方一点。
 *
 * 边距是照着用户反馈调的：左右各留 16px 时看起来像「浮在画面中间」，
 * 收到 4px 又贴得太死、像是被画面边框切了一半，现在取 12px；
 * 纵向离控制条 26px，免得跟那排按钮挤在一起、也躲开弹幕最密的那一横条。
 *
 * 横向锚的是 <video> 而不是播放器容器：容器在网页全屏/剧场模式下会带黑边，
 * 按容器算出来的位置会明显偏里。
 */
const TOAST_INSET_X = 12
const TOAST_GAP_BAR = 26

function place(node: HTMLDivElement) {
  const player = findOne(PLAYER_SELECTORS)
  const playerRect = player ? player.getBoundingClientRect() : null
  const video = findOne(VIDEO_SELECTORS)
  const videoRect = video ? video.getBoundingClientRect() : null
  const bar = findOne(CONTROL_BAR_SELECTORS)
  const barRect = bar ? bar.getBoundingClientRect() : null

  // 提示是往上叠的，锚点给最下面那一条用底部对齐
  const leftEdge = videoRect && videoRect.width > 0 ? videoRect.left : playerRect?.left
  if (leftEdge !== undefined) {
    node.style.left = `${Math.max(TOAST_INSET_X, leftEdge + TOAST_INSET_X)}px`
    node.style.bottom = barRect
      ? `${Math.max(8, window.innerHeight - barRect.top + TOAST_GAP_BAR)}px`
      : `${Math.max(8, window.innerHeight - (playerRect?.bottom ?? window.innerHeight) + 68)}px`
    return
  }
  node.style.left = `${TOAST_INSET_X}px`
  node.style.bottom = '136px'
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
  if (host && host.isConnected) {
    // 进出全屏后宿主换了地方（body ↔ 全屏元素），提示要跟过去，
    // 否则全屏下整片提示都看不见
    mountOverlay(host)
    return host
  }
  host = el('div', ROOT_CLASS)
  host.hidden = true
  mountOverlay(host)
  // 宿主重建后旧节点已经不在文档里，清掉免得留着悬空引用
  items = []
  // 全屏切换时浮动元素的定位基准变了，重新算一次
  if (!unbindFullscreen) unbindFullscreen = onFullscreenChange(() => {
    if (!host || host.hidden) return
    mountOverlay(host)
    place(host)
  })
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

function createItem(text: string, action?: { label: string; onClick: () => void }): ToastItem {
  const node = el('div', ITEM_CLASS)
  const icon = el('span', `${ROOT_CLASS}__icon`)
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.6 3.5A1 1 0 0 1 7 19.6V17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/></svg>'
  const label = el('span', `${ROOT_CLASS}__text`)
  label.textContent = text
  node.append(icon, label)
  if (action) {
    // pointer-events 要在这里重新打开：宿主容器整体是 none，
    // 不开的话按钮看得见点不着。
    const btn = el('button', `${ROOT_CLASS}__action`)
    btn.type = 'button'
    btn.textContent = action.label
    btn.addEventListener('click', () => action.onClick())
    node.append(btn)
  }
  return { key: text, node, action }
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
    // 按钮跟着 action 换：旧节点直接重建，比逐字段 patch 简单且不会残留监听
    const oldBtn = item.node.querySelector(`.${ROOT_CLASS}__action`)
    if (oldBtn) oldBtn.remove()
    if (opts.action) {
      const btn = el('button', `${ROOT_CLASS}__action`)
      btn.type = 'button'
      btn.textContent = opts.action.label
      btn.addEventListener('click', () => opts.action!.onClick())
      item.node.append(btn)
    }
    item.action = opts.action
    if (item.hideTimer !== undefined) {
      window.clearTimeout(item.hideTimer)
      item.hideTimer = undefined
    }
  } else {
    item = createItem(text, opts.action)
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

  // 带 action 的提示常驻到调用方主动 clearToast，定时消失会让确认落空
  if (!opts.action) {
    target.hideTimer = window.setTimeout(() => {
      target.hideTimer = undefined
      items = items.filter((o) => o !== target)
      removeItem(target)
    }, duration)
  }
}

/**
 * 清掉提示。
 *
 * - 不带参数：全清（换视频时用）
 * - 带 key：只清那一条（白名单的暂停说明用得上——匹配成功后要把它收掉，
 *   否则「已暂停」会一直挂在画面上，跟已经播起来的视频自相矛盾）
 */
export function clearToast(key?: string) {
  if (key === undefined) {
    const list = items
    items = []
    list.forEach((item) => removeItem(item))
    return
  }
  const target = items.find((o) => o.key === key)
  if (!target) return
  items = items.filter((o) => o !== target)
  removeItem(target)
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
  unbindFullscreen?.()
  unbindFullscreen = null
}
