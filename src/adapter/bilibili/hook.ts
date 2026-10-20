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
}

interface HookStats {
  /** 拦截到的弹幕分段请求数（不管开关是否开启都统计） */
  requests: number
  /** 开关已开启时发出的分段请求数（这些才会走注入逻辑） */
  armed: number
  /** 播放器真正读取响应的次数（证明影子 getter 被走到了） */
  reads: number
  /** 实际合并过的分段数 */
  segments: number
  /** 实际注入的弹幕条数 */
  injected: number
  /** 最近一次合并被丢弃的原因，用于面板上直接显示 */
  lastDetail: string
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

type XHRWithContext = XMLHttpRequest & { __kdCtx?: SegRequest }

const state: HookState = {
  enabled: false,
  dedupe: true,
  comments: null,
  loading: null,
  stats: { requests: 0, armed: 0, reads: 0, segments: 0, injected: 0, lastDetail: '' },
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
  state.stats = { requests: 0, armed: 0, reads: 0, segments: 0, injected: 0, lastDetail: '' }
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

const RESPONSE_GETTER = Object.getOwnPropertyDescriptor(
  XMLHttpRequest.prototype,
  'response'
)?.get

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


/** 读取 raw response，跨 realm 时退回原型 getter */
function readRawResponse(xhr: XHRWithContext): unknown {
  const own = (xhr as any).__kdRawResponse
  if (own !== undefined) return own
  try {
    if (RESPONSE_GETTER) return RESPONSE_GETTER.call(xhr)
  } catch (error) {
    // 跨 realm 调沙箱的 getter 会 Illegal invocation，退回直接读
  }
  try {
    const proto = Object.getPrototypeOf(xhr) as any
    const getter = Object.getOwnPropertyDescriptor(proto, 'response')?.get
    return getter ? getter.call(xhr) : (xhr as any).response
  } catch (error) {
    return (xhr as any).response
  }
}

/**
 * 用实例上的 getter 覆盖 xhr.response：播放器可能在我们之前注册
 * onreadystatechange，所以必须在 send 前就把 getter 装好，读取时再合并。
 */
function defineShadowResponse(xhr: XHRWithContext, request: SegRequest) {
  let computed = false
  let result: ArrayBuffer | null = null

  try {
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      enumerable: true,
      get() {
        state.stats.reads++
        const raw = readRawResponse(xhr)

        if (computed) return result ?? raw
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

        computed = true
        try {
          const merged = buildInjections(request, bytes)
          if (merged) result = toArrayBuffer(merged)
        } catch (error) {
          const msg = (error as Error)?.message || String(error)
          state.stats.lastDetail = `合并异常：${msg}`
          console.warn('[danmaku-enhance] 合并弹幕失败', error)
        }
        return result ?? raw
      },
    })
  } catch (error) {
    // 极少数环境不允许覆盖，退化为不合并
    console.warn('[danmaku-enhance] 无法拦截弹幕响应', error)
  }
}

async function waitForLoading() {
  const loading = state.loading
  if (!loading || state.comments) return

  await Promise.race([
    loading.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => setTimeout(resolve, LOAD_WAIT_MS)),
  ])
}

function patchXHR(target?: any): boolean {
  const Ctor = target?.XMLHttpRequest || XMLHttpRequest
  const proto = Ctor.prototype as XHRWithContext
  if (!proto) return false
  if ((proto as any).__kdPatched) return true
  const originalOpen = proto.open
  const originalSend = proto.send

  ;(proto as any).open = function (
    this: XHRWithContext,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      this.__kdCtx = parseSegRequest(typeof url === 'string' ? url : url.href)
    } catch (error) {
      this.__kdCtx = undefined
    }
    return (originalOpen as any).apply(this, [method, url, ...rest])
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
    // 先同步装好 getter：一旦进入异步等待，播放器可能 abort/复用这个 xhr，
    // 等回来时 readyState 已不是 1，就再也没机会合并了。
    defineShadowResponse(xhr, request)

    void (async () => {
      await waitForLoading()
      if (xhr.readyState !== 1) {
        // 已经完成或已被 abort，getter 装不上了
        state.stats.lastDetail = `发送时 readyState=${xhr.readyState}（等待期间已被处理或取消）`
        return
      }
      try {
        originalSend.call(xhr, body as any)
      } catch (error) {
        state.stats.lastDetail = `发送失败：${(error as Error)?.message || error}`
        console.warn('[danmaku-enhance] 发送弹幕请求失败', error)
      }
    })()
  }

  ;(proto as any).__kdPatched = true
  return true
}

function patchFetch(target: any) {
  const originalFetch = target.fetch
  if (typeof originalFetch !== 'function') return

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

    const ctx = request
    return (async () => {
      await waitForLoading()

      const response = await originalFetch.call(this, input, init)
      if (!state.enabled || !response.ok) return response

      try {
        const bytes = new Uint8Array(await response.clone().arrayBuffer())
        const merged = buildInjections(ctx, bytes)
        if (!merged) return response

        const headers = new Headers(response.headers)
        headers.delete('content-length')
        headers.delete('content-encoding')

        return new Response(toArrayBuffer(merged), {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      } catch (error) {
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
  })
}
