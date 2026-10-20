import type { Comment } from '../../player/plugins/danmaku/types'
import { appendElems, decodeElems } from './proto'
import type { InjectElem, NativeElem } from './proto'
import { collectItems } from './sources/state'

/**
 * B 站播放器通过 XHR 请求 /x/v2/dm/(wbi/)web/seg.so 获取弹幕分段，
 * 响应是 DmSegMobileReply 的 protobuf 字节。这里在网络层拦截响应，
 * 把第三方弹幕追加成 protobuf 记录后再交给播放器，
 * 这样 B 站的弹幕渲染、过滤、设置都保持原样。
 */

const SEG_PATH = /\/x\/v2\/dm\/(?:wbi\/)?(?:web|list)\/seg\.so/

const SEGMENT_MS = 6 * 60 * 1000
/** 每个分段最多追加多少条，避免异常数据拖慢解码 */
const MAX_PER_SEGMENT = 3000
/** 等待弹幕匹配完成的最长时间（毫秒） */
const LOAD_WAIT_MS = 4000
/** 与原生弹幕去重的时间窗口（毫秒） */
const NATIVE_DEDUPE_MS = 1500
/** 第三方来源之间的去重窗口（巴哈姆特时间只精确到秒，放宽一点） */
const INJECT_DEDUPE_MS = 1800

interface SegRequest {
  oid?: number
  startMs: number
  endMs: number
  /** 分段序号，只用于诊断显示 */
  index?: number
}

interface HookStats {
  /** 拦截到的弹幕分段请求数（不管开关是否开启都统计） */
  requests: number
  /** 开关已开启时发出的分段请求数（这些才会走注入逻辑） */
  armed: number
  /** 播放器真正读取响应的次数（证明影子 getter 被走到了） */
  reads: number
  /** 走 XHR 通道的分段请求数 */
  xhrs: number
  /** 走 fetch 通道的分段请求数 */
  fetches: number
  /** 实际合并过的分段数 */
  segments: number
  /** 实际注入的弹幕条数 */
  injected: number
  /** 最近一次合并被丢弃的原因，用于面板上直接显示 */
  lastDetail: string
  /** 最近一次分段请求的生命周期（readyState/status/是否被中止/是否读了 response） */
  lastState: string
  /** response getter 的安装结果，装不上时这里写原因 */
  hook: string
}

interface HookState {
  enabled: boolean
  dedupe: boolean
  cid?: number
  /** 弹弹play 的弹幕 */
  comments: Comment[] | null
  loading: Promise<void> | null
  stats: HookStats
}

type LoadCallback = [string, (...args: any[]) => any]

type XHRWithContext = XMLHttpRequest & {
  __kdCtx?: SegRequest
  __kdUrl?: string
  __kdCallbacks?: LoadCallback[]
  __kdAborted?: boolean
  __kdMerged?: { result: ArrayBuffer | null }
  __kdRead?: boolean
}

const state: HookState = {
  enabled: false,
  dedupe: true,
  comments: null,
  loading: null,
  stats: emptyStats(),
}

let installed = false

export function getEnabled() {
  return state.enabled
}

export function setEnabled(enabled: boolean) {
  state.enabled = enabled
}

export function getDedupe() {
  return state.dedupe
}

export function setDedupe(dedupe: boolean) {
  state.dedupe = dedupe
}

export function setCid(cid?: number) {
  state.cid = cid
}

export function setComments(comments: Comment[] | null) {
  state.comments = comments
}

export function getComments() {
  return state.comments
}

export function setLoading(loading: Promise<void> | null) {
  state.loading = loading
}

export function getStats(): HookStats {
  return { ...state.stats }
}

/** 切集/换页面时重置，保留开关状态 */
export function resetPageState() {
  state.comments = null
  state.loading = null
  state.cid = undefined
  state.stats = emptyStats()
}

function emptyStats(): HookStats {
  return {
    requests: 0,
    armed: 0,
    reads: 0,
    xhrs: 0,
    fetches: 0,
    segments: 0,
    injected: 0,
    lastDetail: '',
    lastState: '',
    hook: '',
  }
}

function toNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseSegRequest(rawUrl: string): SegRequest | undefined {
  if (!SEG_PATH.test(rawUrl)) return undefined

  let url: URL
  try {
    url = new URL(rawUrl, location.href)
  } catch (error) {
    return undefined
  }

  const params = url.searchParams
  const oid = toNumber(params.get('oid'))
  const segment = toNumber(params.get('segment_index'))
  const ps = toNumber(params.get('ps'))
  const pe = toNumber(params.get('pe'))

  // ps/pe 正常情况下是毫秒，但也见过按秒传的（窗口只有 360），
  // 用「跨度至少 30 秒」来区分，避免把整段弹幕都过滤掉
  if (
    ps !== undefined &&
    pe !== undefined &&
    pe > ps &&
    pe - ps >= 30 * 1000
  ) {
    return { oid, startMs: ps, endMs: pe }
  }

  const index = segment && segment > 0 ? segment : 1
  return {
    oid,
    startMs: (index - 1) * SEGMENT_MS,
    endMs: index * SEGMENT_MS,
    index,
  }
}

function normalizeText(text: string) {
  return text.replace(/[\s\u3000]+/g, '').toLowerCase()
}

function addTime(map: Map<string, number[]>, key: string, timeMs: number) {
  const list = map.get(key)
  if (list) list.push(timeMs)
  else map.set(key, [timeMs])
}

function hasNear(
  map: Map<string, number[]>,
  key: string,
  timeMs: number,
  tolerance: number
) {
  const list = map.get(key)
  if (!list) return false
  for (const t of list) {
    if (Math.abs(t - timeMs) <= tolerance) return true
  }
  return false
}

function toBiliMode(mode?: string): 1 | 4 | 5 {
  if (mode === 'top') return 5
  if (mode === 'bottom') return 4
  return 1
}

function parseColor(color?: string) {
  if (typeof color === 'string' && color.startsWith('#')) {
    const hex = color.slice(1)
    if (/^[0-9a-f]{3,6}$/i.test(hex)) {
      const full =
        hex.length === 3
          ? hex
              .split('')
              .map((c) => c + c)
              .join('')
          : hex
      return parseInt(full, 16) & 0xffffff
    }
  }
  return 0xffffff
}

/** 生成稳定、数字形态的 dmid，避免和 B 站真实 id 冲突 */
function makeDmid(text: string, timeMs: number) {
  let hash = 2166136261
  const source = `${text}@${timeMs}`
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return String(1000000000000000 + (Math.abs(hash) % 900000000000000))
}

/** 统一成内部的候选弹幕形态 */
interface Candidate {
  timeMs: number
  mode: 1 | 4 | 5
  color: number
  text: string
}

function candidatesFromComments(comments: Comment[]): Candidate[] {
  return comments.map((comment) => ({
    timeMs: Math.round((comment.time || 0) * 1000),
    mode: toBiliMode(comment.mode),
    color: parseColor((comment.style as any)?.color),
    text: String(comment.text || '').trim(),
  }))
}

interface PickResult {
  picked: InjectElem[]
  /** 因不在本段时间窗内被丢掉的条数 */
  outOfWindow: number
  /** 因与原生弹幕重复被丢掉的条数 */
  dupNative: number
  /** 因与已注入弹幕重复被丢掉的条数 */
  dupInjected: number
  /** 空文本 */
  empty: number
}

function pickComments(
  candidates: Candidate[],
  request: SegRequest,
  nativeElems: NativeElem[]
): PickResult {
  const nativeTimes = new Map<string, number[]>()
  for (const elem of nativeElems) {
    addTime(nativeTimes, normalizeText(elem.text), elem.timeMs)
  }

  const injectedTimes = new Map<string, number[]>()
  const picked: InjectElem[] = []
  let outOfWindow = 0
  let dupNative = 0
  let dupInjected = 0
  let empty = 0

  for (const item of candidates) {
    if (picked.length >= MAX_PER_SEGMENT) break

    const { timeMs } = item
    if (timeMs < request.startMs || timeMs >= request.endMs) {
      outOfWindow++
      continue
    }

    const text = item.text
    if (!text) {
      empty++
      continue
    }

    const key = normalizeText(text)
    if (state.dedupe) {
      if (hasNear(nativeTimes, key, timeMs, NATIVE_DEDUPE_MS)) {
        dupNative++
        continue
      }
      if (hasNear(injectedTimes, key, timeMs, INJECT_DEDUPE_MS)) {
        dupInjected++
        continue
      }
    }

    picked.push({
      timeMs,
      mode: item.mode,
      color: item.color,
      text,
      dmid: makeDmid(text, timeMs),
      oid: request.oid,
    })
    addTime(injectedTimes, key, timeMs)
  }

  return { picked, outOfWindow, dupNative, dupInjected, empty }
}

/** 记录本次合并被丢弃的原因，面板上直接展示，方便一轮定位 */
function detail(reason: string) {
  state.stats.lastDetail = reason
  return null
}

function buildInjections(
  request: SegRequest,
  bytes: Uint8Array
): Uint8Array | null {
  if (!state.enabled) return detail('开关未开启')
  // 请求的 cid 和当前页面不一致（比如预加载下一集）时不合并
  if (state.cid && request.oid && state.cid !== request.oid) {
    return detail(`cid 不匹配：页面 ${state.cid} / 请求 ${request.oid}`)
  }

  // 弹弹play 和 URL 来源可以同时生效
  const fromComments = state.comments ? candidatesFromComments(state.comments) : []
  let fromUrls: Candidate[] = []
  try {
    fromUrls = collectItems()
  } catch (error) {
    return detail(`读取 URL 源失败：${(error as Error)?.message || error}`)
  }
  const candidates = [...fromComments, ...fromUrls]
  if (!candidates.length) {
    return detail(
      `没有候选弹幕（弹弹play ${state.comments ? state.comments.length : 0} 条 / URL 源 ${
        fromUrls.length
      } 条）`
    )
  }

  const nativeElems = state.dedupe ? decodeElems(bytes) : []
  const result = pickComments(candidates, request, nativeElems)
  const { picked: elems } = result
  if (!elems.length) {
    return detail(
      `候选 ${candidates.length} 条全被丢弃（窗外 ${result.outOfWindow}／撞原生 ${result.dupNative}／自撞 ${result.dupInjected}／空 ${result.empty}；本段 ${Math.round(
        request.startMs / 1000
      )}-${Math.round(request.endMs / 1000)}s，原生 ${nativeElems.length} 条）`
    )
  }

  const merged = appendElems(bytes, elems)
  state.stats.segments++
  state.stats.injected += elems.length
  state.stats.lastDetail = `本段注入 ${elems.length} 条`
  return merged
}

/** 记一次弹幕分段请求（不管开关是否开启都记，方便诊断） */
function countRequest(request: SegRequest | undefined) {
  if (!request) return
  state.stats.requests++
  if (state.enabled) state.stats.armed++
}

/**
 * 让播放器重新拉一遍弹幕。
 *
 * 播放器按 cid 把分段缓存在内存里，开关是在视频已经在播之后才打开的，
 * 这时当前分段早已请求过、不会再发请求，hook 也就没机会合并。
 * 这里挨个试常见的重新加载手段，每种都等一会儿看请求计数有没有涨。
 */
const RELOAD_WAIT_MS = 800

function requestTicks() {
  return state.stats.requests
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** 播放器控制器（不同版本挂在不同的全局变量上） */
function playerController(): any {
  const win = window as any
  return (
    win.player ||
    win.bilibiliPlayer ||
    win.__BILI_PLAYER__ ||
    win.playerConfig?.player
  )
}

export async function forceReloadDanmaku(): Promise<string> {
  const player = playerController()
  const video = document.querySelector('video') as HTMLVideoElement | null

  const attempts: { name: string; fn: () => void }[] = [
    { name: 'player.reloadDanmaku', fn: () => player?.reloadDanmaku?.() },
    {
      name: 'player.setDanmaku',
      fn: () => player?.setDanmaku?.(true),
    },
    {
      name: '弹幕开关切换',
      fn: () => {
        // 关掉再打开，播放器会清掉分段缓存并重新请求
        const btn = document.querySelector(
          [
            '.bpx-player-ctrl-dm',
            '.bpx-player-dm-switch',
            '.bilibili-player-video-btn-danmaku',
            '[aria-label*="弹幕"]',
            '[aria-label*="danmaku" i]',
          ].join(',')
        ) as HTMLElement | null
        if (!btn) return
        btn.click()
        setTimeout(() => btn.click(), 150)
      },
    },
    {
      name: 'player.seek',
      fn: () => {
        if (!video) return
        const t = video.currentTime
        player?.seek?.(Math.max(0, t - 0.3))
        player?.seek?.(t)
      },
    },
    {
      name: 'video.currentTime',
      fn: () => {
        if (!video) return
        const t = video.currentTime
        video.currentTime = Math.max(0, t - 0.3)
        video.currentTime = t
      },
    },
  ]

  for (const attempt of attempts) {
    try {
      const before = requestTicks()
      attempt.fn()
      await sleep(RELOAD_WAIT_MS)
      if (requestTicks() > before) return attempt.name
    } catch (error) {
      console.warn('[danmaku-enhance] 重新加载弹幕失败', attempt.name, error)
    }
  }
  return ''
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer
}

/** 记下模块加载时的构造器，换成页面 realm 之前也能用 */
const XmlHttpRequestCtor = XMLHttpRequest

/**
 * 跨 realm 时 `x instanceof ArrayBuffer` 会失效（页面那份 ArrayBuffer
 * 和油猴沙箱的构造器不是同一个），所以按鸭子类型判断。
 */
function asBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (Object.prototype.toString.call(raw) !== '[object ArrayBuffer]') {
    return null
  }
  try {
    return new Uint8Array(raw as ArrayBuffer)
  } catch (error) {
    return null
  }
}


/**
 * 合并逻辑本身。raw 由调用方从「原始 getter」取出，保证不会递归。
 * 同一个 xhr 只合并一次，后续读取复用结果。
 */
function mergeResponse(
  xhr: XHRWithContext,
  request: SegRequest,
  raw: unknown
): unknown {
  const cached = xhr.__kdMerged
  if (cached) return cached.result ?? raw

  if (xhr.readyState !== 4) return raw
  if (xhr.status !== 200) {
    // 304 = 该分段没有弹幕，属于正常情况
    if (xhr.status !== 304) state.stats.lastDetail = `响应状态 ${xhr.status}`
    return raw
  }

  const bytes = asBytes(raw)
  if (!bytes) {
    state.stats.lastDetail = `响应不是 ArrayBuffer（responseType=${JSON.stringify(
      (xhr as any).responseType
    )}，实际 ${Object.prototype.toString.call(raw)}）`
    return raw
  }

  let result: ArrayBuffer | null = null
  try {
    const merged = buildInjections(request, bytes)
    if (merged) result = toArrayBuffer(merged)
  } catch (error) {
    const msg = (error as Error)?.message || String(error)
    state.stats.lastDetail = `合并异常：${msg}`
    console.warn('[danmaku-enhance] 合并弹幕失败', error)
  }
  // 只在真的合并出内容时缓存：否则等弹弹play 数据到位后，
  // 播放器再读一次同一个响应还能补上。
  if (result) xhr.__kdMerged = { result }
  return result ?? raw
}

/**
 * 在原型上替换 response getter。之前用实例上的 defineProperty，
 * 但只要页面某处缓存了原型 getter 再 .call(xhr)，实例属性就被绕过，
 * 表现为「请求发出去了、播放器一次都没读」。
 */
/**
 * 沿原型链找 `response` 的访问器。油猴沙箱里它未必是 prototype 的自有属性，
 * 直接 getOwnPropertyDescriptor 会拿到 undefined，补丁就静默失效了。
 */
function findResponseAccessor(
  proto: unknown
): { holder: any; desc: PropertyDescriptor } | null {
  let obj: any = proto
  let depth = 0
  while (obj && depth < 8) {
    try {
      const desc = Object.getOwnPropertyDescriptor(obj, 'response')
      if (desc && typeof desc.get === 'function') return { holder: obj, desc }
    } catch (error) {
      // 跨 realm 的代理对象取描述符可能抛错，继续往上找
    }
    obj = Object.getPrototypeOf(obj)
    depth++
  }
  return null
}

function installResponseGetter(target?: any): boolean {
  const Ctor = target?.XMLHttpRequest || XmlHttpRequestCtor
  const proto = Ctor?.prototype
  if (!proto) {
    state.stats.hook = '找不到 XMLHttpRequest.prototype'
    return false
  }

  const found = findResponseAccessor(proto)
  if (!found) {
    state.stats.hook = '原型链上找不到 response 访问器'
    return false
  }
  const { holder, desc } = found
  if ((holder as any).__kdResponsePatched) {
    state.stats.hook = 'ok'
    return true
  }

  const originalGet = desc.get as (this: XMLHttpRequest) => unknown
  try {
    Object.defineProperty(holder, 'response', {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: XHRWithContext) {
        const raw = originalGet.call(this)
        const ctx = this.__kdCtx
        if (!ctx) return raw
        this.__kdRead = true
        if (!state.enabled) return raw
        state.stats.reads++
        return mergeResponse(this, ctx, raw)
      },
    })
  } catch (error) {
    state.stats.hook = `替换 response 失败：${(error as Error).message}`
    return false
  }

  ;(holder as any).__kdResponsePatched = true
  state.stats.hook = 'ok'
  return true
}

/**
 * 记录一个分段请求的完整生命周期。播放器不读 response 时，靠这些字段区分
 * 「请求被取消了」「请求还在路上」「请求完成了但没人读」三种情况。
 */
function trackRequest(xhr: XHRWithContext, request: SegRequest) {
  const describe = (why: string) => {
    const seg = request.index ? `第${request.index}段` : '分段'
    state.stats.lastState = `${seg} ${why} readyState=${xhr.readyState} status=${
      (xhr as any).status
    } responseType=${JSON.stringify((xhr as any).responseType)} read=${
      xhr.__kdRead ? 'yes' : 'no'
    }`
  }

  describe('发出')
  try {
    xhr.addEventListener('load', () => describe('load'))
    xhr.addEventListener('error', () => describe('error'))
    xhr.addEventListener('abort', () => describe('abort'))
    xhr.addEventListener('timeout', () => describe('timeout'))
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState >= 2) describe(`rs${xhr.readyState}`)
    })
  } catch (error) {
    // 个别实现不允许加监听，忽略
  }
}

/**
 * 等匹配出结果。播放器往往在弹弹play 返回之前就请求了第一段，
 * 现在请求由我们接管，可以放心地等数据到齐再回填回调。
 */
async function waitForLoading() {
  if (state.comments) return
  const deadline = Date.now() + LOAD_WAIT_MS
  while (!state.comments && Date.now() < deadline) {
    const loading = state.loading
    if (!loading) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      continue
    }
    await loading.then(
      () => undefined,
      () => undefined
    )
    // 这一轮匹配已经结束却没有结果（没匹配上），继续等也没意义
    if (!state.comments && state.loading === loading) break
  }
}

// ── 接手整个 XHR（思路来自 pakku.js）────────────────────────
//
// 只读写时拦截不可靠：播放器可能把 load 回调注册在别处、或者根本不读
// 我们挂的 getter。pakku.js 的办法是干脆不调用原生 send —— 自己把字节
// 取回来，把 response/status/readyState 变成可写属性后手动回填，
// 再直接调用播放器注册过的回调。这样播放器拿到的一定是合并后的数据。

const LOAD_EVENTS = ['load', 'readystatechange', 'loadend']

/** 自己把分段字节取回来（GM 请求，绕过页面 CORS 与缓存） */
function fetchSegBytes(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      url,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 8000,
      onload: (res: any) => {
        // 304 = 这一段没有原生弹幕，按空处理（第三方弹幕照样注入）
        if (res.status === 304) {
          resolve(new Uint8Array(0))
          return
        }
        if (res.status >= 200 && res.status < 400) {
          resolve(new Uint8Array(res.response || new ArrayBuffer(0)))
          return
        }
        reject(new Error(`HTTP ${res.status}`))
      },
      onerror: () => reject(new Error('网络错误')),
      ontimeout: () => reject(new Error('请求超时')),
    })
  })
}

/** 把合并后的字节写成这个 xhr 自己的响应 */
function writeResponse(xhr: XHRWithContext, bytes: Uint8Array, url: string) {
  const fields = [
    'response',
    'responseText',
    'responseURL',
    'readyState',
    'status',
    'statusText',
    'getAllResponseHeaders',
    'getResponseHeader',
  ]
  for (const key of fields) {
    try {
      Object.defineProperty(xhr, key, { configurable: true, writable: true })
    } catch (error) {
      // 个别环境不让改，忽略
    }
  }

  const type = (xhr as any).responseType
  const buffer = toArrayBuffer(bytes)
  if (type === 'arraybuffer' || type === 'blob') {
    ;(xhr as any).response =
      type === 'blob'
        ? new Blob([buffer], { type: 'application/octet-stream' })
        : buffer
    ;(xhr as any).responseText = ''
  } else {
    const text = new TextDecoder('utf-8').decode(bytes)
    ;(xhr as any).response = text
    ;(xhr as any).responseText = text
  }

  ;(xhr as any).responseURL = url
  ;(xhr as any).readyState = 4
  ;(xhr as any).status = 200
  ;(xhr as any).statusText = 'OK'
  ;(xhr as any).getAllResponseHeaders = () =>
    'Content-Type: application/octet-stream\r\n'
  ;(xhr as any).getResponseHeader = (name: string) =>
    String(name).toLowerCase() === 'content-type'
      ? 'application/octet-stream'
      : null
}

/** 按注册顺序调用播放器自己的回调，事件对象照着 LoadEvent 伪造 */
function fireCallbacks(xhr: XHRWithContext, callbacks: LoadCallback[]) {
  for (const [type, cb] of callbacks) {
    const event = {
      type,
      target: xhr,
      currentTarget: xhr,
      srcElement: xhr,
      isTrusted: true,
      bubbles: false,
      cancelable: false,
      composed: false,
      defaultPrevented: false,
      eventPhase: 2,
      timeStamp: 0,
      lengthComputable: false,
      loaded: 1,
      total: 1,
    }
    try {
      cb.call(xhr, event)
    } catch (error) {
      console.warn('[danmaku-enhance] 播放器回调执行失败', type, error)
    }
  }
}

function patchXHR(target?: any): boolean {
  const Ctor = target?.XMLHttpRequest || XmlHttpRequestCtor
  const proto = Ctor?.prototype as XHRWithContext
  if (!proto) return false
  if ((proto as any).__kdPatched) return true

  const originalOpen = proto.open
  const originalSend = proto.send
  const originalAddEventListener = proto.addEventListener

  ;(proto as any).open = function (
    this: XHRWithContext,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      const href = typeof url === 'string' ? url : url.href
      this.__kdUrl = new URL(href, location.href).href
      this.__kdCtx = parseSegRequest(href)
    } catch (error) {
      this.__kdCtx = undefined
      this.__kdUrl = undefined
    }
    return (originalOpen as any).apply(this, [method, url, ...rest])
  }

  // 播放器普遍用 addEventListener 注册 load，先把这些回调截下来
  ;(proto as any).addEventListener = function (
    this: XHRWithContext,
    name: string,
    cb: any,
    options?: any
  ) {
    if (LOAD_EVENTS.indexOf(name) >= 0 && typeof cb === 'function') {
      if (!this.__kdCallbacks) this.__kdCallbacks = []
      this.__kdCallbacks.push([name, cb])
    }
    if (name === 'abort') {
      const mark = () => {
        this.__kdAborted = true
      }
      try {
        originalAddEventListener.call(this, 'abort', mark, options)
      } catch (error) {
        // 忽略
      }
      return
    }
    return originalAddEventListener.call(this, name, cb, options)
  }

  ;(proto as any).send = function (
    this: XHRWithContext,
    body?: Document | XMLHttpRequestBodyInit | null
  ) {
    const request = this.__kdCtx
    countRequest(request)
    if (!request || !state.enabled) {
      return originalSend.call(this, body as any)
    }

    const xhr = this
    state.stats.xhrs++
    trackRequest(xhr, request)

    const callbacks: LoadCallback[] = (xhr.__kdCallbacks || []).slice()
    const onReadyState = (xhr as any).onreadystatechange
    const onLoad = (xhr as any).onload
    const onLoadEnd = (xhr as any).onloadend
    if (typeof onReadyState === 'function') {
      callbacks.push(['readystatechange', onReadyState])
    }
    if (typeof onLoad === 'function') callbacks.push(['load', onLoad])
    if (typeof onLoadEnd === 'function') callbacks.push(['loadend', onLoadEnd])

    const url = xhr.__kdUrl
    // 没有回调、或者连 URL 都没记下来，就老老实实走原生
    if (!callbacks.length || !url) {
      state.stats.lastDetail = callbacks.length
        ? '没拿到请求 URL，退回原生请求'
        : '播放器没注册 load 回调，退回原生请求'
      return originalSend.call(this, body as any)
    }

    void (async () => {
      let bytes: Uint8Array | null = null
      try {
        bytes = await fetchSegBytes(url)
      } catch (error) {
        state.stats.lastDetail = `自行拉取失败退回原生：${
          (error as Error)?.message || error
        }`
      }

      if (xhr.__kdAborted) {
        state.stats.lastDetail = '接管期间播放器取消了请求'
        return
      }

      if (!bytes) {
        try {
          originalSend.call(xhr, body as any)
        } catch (error) {
          state.stats.lastDetail = `退回原生发送失败：${
            (error as Error)?.message || error
          }`
        }
        return
      }

      // 字节已经到手，可以安心等匹配结果——播放器不拿到回调就不会走
      await waitForLoading()

      let merged = bytes
      try {
        const injected = buildInjections(request, bytes)
        if (injected) merged = injected
      } catch (error) {
        state.stats.lastDetail = `合并异常：${(error as Error)?.message || error}`
      }

      writeResponse(xhr, merged, url)
      state.stats.reads++
      fireCallbacks(xhr, callbacks)
    })()
  }

  ;(proto as any).__kdPatched = true
  return true
}

function patchFetch(target: any) {
  const originalFetch = target.fetch
  if (typeof originalFetch !== 'function') return
  // 跨 realm 时用页面自己的 Response，否则页面的 instanceof 判断会失败
  const ResponseCtor: typeof Response = target.Response || Response

  target.fetch = function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    let request: SegRequest | undefined
    try {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : input.url
      request = parseSegRequest(href)
    } catch (error) {
      request = undefined
    }

    countRequest(request)
    if (!request || !state.enabled) {
      return originalFetch.call(this, input, init)
    }

    state.stats.fetches++

    const ctx = request
    return (async () => {
      await waitForLoading()

      const response = await originalFetch.call(this, input, init)
      if (!state.enabled) {
        state.stats.lastDetail = '响应返回时开关已关闭'
        return response
      }

      // 304 = 该分段没有原生弹幕。播放器看到 304 会当作「无弹幕」，
      // 但第三方弹幕仍要注入，所以合成为 200 空体 + 注入内容。
      if (response.status === 304) {
        state.stats.reads++
        const merged = buildInjections(ctx, new Uint8Array(0))
        if (!merged) return response
        return new ResponseCtor(toArrayBuffer(merged), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/octet-stream' },
        })
      }

      if (!response.ok) {
        state.stats.lastDetail = `fetch 响应状态 ${response.status}`
        return response
      }

      state.stats.reads++
      try {
        const bytes = new Uint8Array(await response.clone().arrayBuffer())
        const merged = buildInjections(ctx, bytes)
        if (!merged) return response

        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')

        return new ResponseCtor(toArrayBuffer(merged), {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      } catch (error) {
        const msg = (error as Error)?.message || String(error)
        state.stats.lastDetail = `合并 fetch 弹幕异常：${msg}`
        console.warn('[danmaku-enhance] 合并 fetch 弹幕失败', error)
        return response
      }
    })()
  } as any
}

/**
 * 油猴沙箱里的 window 是代理对象，直接改 window.fetch / 全局变量
 * 常常打不到页面自己的那份。优先拿到页面真实的 window。
 */
function pageWindow(): any {
  const win = window as any
  return win.unsafeWindow || win.wrappedJSObject || win
}

export function installHook() {
  if (installed) return
  installed = true

  const page = pageWindow()

  patchXHR(window)
  patchFetch(window)

  // 沙箱模式下页面用的是自己那份构造器/fetch，得单独打
  if (page !== window) {
    try {
      patchXHR(page)
    } catch (error) {
      console.warn('[danmaku-enhance] 无法拦截页面 XHR', error)
    }
    try {
      patchFetch(page)
    } catch (error) {
      console.warn('[danmaku-enhance] 无法拦截页面 fetch', error)
    }
  }

  console.info('[danmaku-enhance] 已安装弹幕拦截', {
    sameWindow: page === window,
    hookUrl: SEG_PATH.source,
    mode: '接管 XHR',
    hasGM: typeof GM_xmlhttpRequest !== 'undefined',
  })
}
