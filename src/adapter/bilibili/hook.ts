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
  segments: number
  injected: number
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
  stats: { segments: 0, injected: 0 },
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
  state.stats = { segments: 0, injected: 0 }
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

  if (ps !== undefined && pe !== undefined && pe > ps) {
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

function pickComments(
  candidates: Candidate[],
  request: SegRequest,
  nativeElems: NativeElem[]
): InjectElem[] {
  const nativeTimes = new Map<string, number[]>()
  for (const elem of nativeElems) {
    addTime(nativeTimes, normalizeText(elem.text), elem.timeMs)
  }

  const injectedTimes = new Map<string, number[]>()
  const picked: InjectElem[] = []

  for (const item of candidates) {
    if (picked.length >= MAX_PER_SEGMENT) break

    const { timeMs } = item
    if (timeMs < request.startMs || timeMs >= request.endMs) continue

    const text = item.text
    if (!text) continue

    const key = normalizeText(text)
    if (state.dedupe) {
      if (hasNear(nativeTimes, key, timeMs, NATIVE_DEDUPE_MS)) continue
      if (hasNear(injectedTimes, key, timeMs, INJECT_DEDUPE_MS)) continue
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

  return picked
}

function buildInjections(
  request: SegRequest,
  bytes: Uint8Array
): Uint8Array | null {
  if (!state.enabled) return null
  // 请求的 cid 和当前页面不一致（比如预加载下一集）时不合并
  if (state.cid && request.oid && state.cid !== request.oid) return null

  // 弹弹play 和 URL 来源可以同时生效
  const candidates = [
    ...(state.comments ? candidatesFromComments(state.comments) : []),
    ...collectItems(),
  ]
  if (!candidates.length) return null

  const nativeElems = state.dedupe ? decodeElems(bytes) : []
  const elems = pickComments(candidates, request, nativeElems)
  if (!elems.length) return null

  const merged = appendElems(bytes, elems)
  state.stats.segments++
  state.stats.injected += elems.length
  return merged
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
        const raw = RESPONSE_GETTER
          ? RESPONSE_GETTER.call(xhr)
          : (xhr as any).__kdRawResponse

        if (computed) return result ?? raw
        if (
          !(raw instanceof ArrayBuffer) ||
          xhr.readyState !== 4 ||
          xhr.status !== 200
        ) {
          return raw
        }

        computed = true
        try {
          const merged = buildInjections(request, new Uint8Array(raw))
          if (merged) result = toArrayBuffer(merged)
        } catch (error) {
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

function patchXHR() {
  const proto = XMLHttpRequest.prototype as XHRWithContext
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
    if (!request || !state.enabled) {
      return originalSend.call(this, body as any)
    }

    const xhr = this
    void (async () => {
      await waitForLoading()
      // 等待期间可能被 abort 或复用
      if (xhr.readyState !== 1) return

      defineShadowResponse(xhr, request)
      try {
        originalSend.call(xhr, body as any)
      } catch (error) {
        console.warn('[danmaku-enhance] 发送弹幕请求失败', error)
      }
    })()
  }
}

function patchFetch() {
  const originalFetch = window.fetch
  if (typeof originalFetch !== 'function') return

  window.fetch = function (
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
  } as typeof window.fetch
}

export function installHook() {
  if (installed) return
  installed = true
  patchXHR()
  patchFetch()
}
