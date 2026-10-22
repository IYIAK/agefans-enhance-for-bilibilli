import type { Comment } from '../../player/plugins/danmaku/types'
import { applyDensity, createBlockChecker, isSimilar, loadFilter } from './filters'
import type { FilterConfig, FilterTarget } from './filters'
import { decodeReply, rebuildReply, replaceElemText } from './proto'
import type { InjectElem } from './proto'
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
/** 等待弹幕匹配完成的最长时间（毫秒），只在实际有一次匹配在路上时才用满 */
const LOAD_WAIT_MS = 4000
/**
 * 启动宽限期（毫秒）。播放器可能在 panel 调 setLoading 之前就发出第一段请求，
 * 给这么一小段时间让匹配登记上来；超过还没登记就认定「没有匹配」，立刻放行。
 */
const STARTUP_GRACE_MS = 300
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
  /** 最近一次处理的分段序号（null 表示没有序号） */
  lastSeg: number | null
  /** 最近一次真正合并成功的分段序号 */
  lastMergedSeg: number | null
  /** 当前来源总共可用的弹幕条数（不受分段窗口限制） */
  available: number
  /** 被过滤器拦下的条数（屏蔽词 + 类型 + 密度） */
  filtered: number
  /** 从原生响应里剔除掉的条数（过滤器对原生弹幕生效） */
  droppedNative: number
  /** 被合并掉的重复弹幕条数 */
  merged: number
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
  lastRequestOid = null
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
    lastSeg: null,
    lastMergedSeg: null,
    available: 0,
    filtered: 0,
    droppedNative: 0,
    merged: 0,
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
  /** 最终要写进响应的字节；null 表示无需改写 */
  bytes: Uint8Array | null
  /** 注入的第三方弹幕条数 */
  injected: number
  /** 从原生弹幕里删掉的条数（过滤器对原生生效） */
  droppedNative: number
  /** 因不在本段时间窗内被丢掉的候选条数 */
  outOfWindow: number
  /** 候选被屏蔽词 / 类型开关 / 密度上限丢掉的条数 */
  filtered: number
  /** 候选与相同时段内其他弹幕合并掉的条数 */
  merged: number
  /** 候选因与原生弹幕重复被丢掉的条数 */
  dupNative: number
  /** 候选因与已注入弹幕重复被丢掉的条数 */
  dupInjected: number
  /** 候选空文本 */
  empty: number
}

/** 统一时间线上的一条弹幕：可能来自原生响应，也可能来自第三方候选 */
interface Entry {
  timeMs: number
  mode: number
  text: string
  /** >=0：原生记录下标；-1：第三方候选 */
  nativeIndex: number
  candidate?: Candidate
  /** 被后面的近似弹幕合并到时，指向保留下来代表它的那条 */
  absorbedBy?: Entry
  count: number
}

/**
 * 一次分段合并的全部工作。
 *
 * 过滤器对「画面上的所有弹幕」生效，所以原生记录也走同一条管线：屏蔽词和类型
 * 开关命中就从响应里剔掉，合并相似弹幕会把它的文字改成带计数的样子，每分钟上限
 * 则是在原生 + 第三方合起来之后统一抽样。只有真的要改写时才重建响应。
 */
function pickComments(
  candidates: Candidate[],
  request: SegRequest,
  raw: Uint8Array,
  filter: FilterConfig
): PickResult {
  const decoded = decodeReply(raw)
  const blocked = createBlockChecker(filter)

  // ── 1. 原生弹幕过屏蔽词 / 类型 ──────────────────────────
  let blockedNative = 0
  const entries: Entry[] = []
  decoded.records.forEach((record, index) => {
    if (blocked(record.elem)) {
      blockedNative++
      return
    }
    entries.push({
      timeMs: record.elem.timeMs,
      mode: record.elem.mode,
      text: record.elem.text,
      nativeIndex: index,
      count: 1,
    })
  })

  // ── 2. 候选弹幕：时间窗 + 空文本 + 屏蔽词 / 类型 ────────
  let outOfWindow = 0
  let empty = 0
  let blockedCandidate = 0
  for (const item of candidates) {
    if (item.timeMs < request.startMs || item.timeMs >= request.endMs) {
      outOfWindow++
      continue
    }
    if (!item.text) {
      empty++
      continue
    }
    if (blocked(item)) {
      blockedCandidate++
      continue
    }
    entries.push({
      timeMs: item.timeMs,
      mode: item.mode,
      text: item.text,
      nativeIndex: -1,
      candidate: item,
      count: 1,
    })
  }

  // ── 3. 去重：候选撞原生、以及多个来源之间互相撞 ──────────
  const nativeTimes = new Map<string, number[]>()
  for (const entry of entries) {
    if (entry.nativeIndex < 0) continue
    addTime(nativeTimes, normalizeText(entry.text), entry.timeMs)
  }

  let dupNative = 0
  let dupInjected = 0
  if (state.dedupe) {
    const injectedTimes = new Map<string, number[]>()
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.nativeIndex >= 0) continue
      const key = normalizeText(entry.text)
      if (hasNear(nativeTimes, key, entry.timeMs, NATIVE_DEDUPE_MS)) {
        dupNative++
        entries.splice(i, 1)
      }
    }
    // 倒序删完后重排，再按时间顺序做来源间去重（先来的留下）
    entries.sort((a, b) => a.timeMs - b.timeMs)
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.nativeIndex >= 0) continue
      const key = normalizeText(entry.text)
      if (hasNear(injectedTimes, key, entry.timeMs, INJECT_DEDUPE_MS)) {
        dupInjected++
        entries.splice(i, 1)
        continue
      }
      addTime(injectedTimes, key, entry.timeMs)
    }
  } else {
    for (const entry of entries) {
      if (entry.nativeIndex >= 0) continue
      addTime(nativeTimes, normalizeText(entry.text), entry.timeMs)
    }
  }

  // ── 4. 合并相似弹幕（原生与第三方放在同一时间线上）──────
  // 时间要正序，才能只朝后看固定窗口
  entries.sort((a, b) => a.timeMs - b.timeMs)

  const windowMs = Math.max(0, filter.mergeWindowSec) * 1000
  const reps: Entry[] = []
  let merged = 0
  const mergeOn = filter.enabled && filter.mergeSimilar && windowMs > 0

  for (const entry of entries) {
    if (mergeOn) {
      for (let i = reps.length - 1; i >= 0; i--) {
        const rep = reps[i]
        if (entry.timeMs - rep.timeMs > windowMs) break
        if (rep.mode !== entry.mode) continue
        if (!isSimilar(rep.text, entry.text)) continue
        rep.count++
        entry.absorbedBy = rep
        merged++
        break
      }
      if (entry.absorbedBy) continue
    }
    reps.push(entry)
  }

  // ── 5. 每分钟上限：原生 + 第三方放在一起抽样 ────────────
  const slots: (FilterTarget & { entry: Entry })[] = reps.map((entry) => ({
    timeMs: entry.timeMs,
    mode: entry.mode,
    text: entry.count > 1 ? `${entry.text} (${entry.count})` : entry.text,
    entry,
  }))
  const survived = new Set(applyDensity(slots, filter.perMinute).kept)

  // ── 6. 落成最终的响应 ──────────────────────────────────
  const finalBodies = new Array<Uint8Array | null>(decoded.records.length).fill(null)
  const finalInjected: InjectElem[] = []
  let injected = 0
  let droppedNative = 0
  // 原生是否被改写过（被屏蔽的、被密度抽掉的、合并后改文字的），
  // 只要有一条就算改写，否则原样返回这次响应
  let nativeChanged = blockedNative > 0

  for (const slot of slots) {
    if (!survived.has(slot)) {
      if (slot.entry.nativeIndex >= 0) {
        droppedNative++
        nativeChanged = true
      }
      continue
    }
    const { entry } = slot
    if (entry.nativeIndex >= 0) {
      // 计数大于 1 时要改文字，其余字段按原字节保留
      if (entry.count > 1) {
        finalBodies[entry.nativeIndex] = replaceElemText(
          decoded.records[entry.nativeIndex].body,
          `${entry.text} (${entry.count})`
        )
        nativeChanged = true
      } else {
        finalBodies[entry.nativeIndex] = decoded.records[entry.nativeIndex].body
      }
      continue
    }
    if (injected >= MAX_PER_SEGMENT) continue
    injected++
    finalInjected.push({
      timeMs: entry.timeMs,
      mode: entry.mode,
      color: entry.candidate?.color ?? 0xffffff,
      text: slot.text,
      dmid: makeDmid(entry.text, entry.timeMs),
      oid: request.oid,
    })
  }

  const changed = nativeChanged || finalInjected.length > 0

  return {
    bytes: changed ? rebuildReply(decoded, (_elem, index) => finalBodies[index], finalInjected) : null,
    injected: finalInjected.length,
    droppedNative,
    outOfWindow,
    filtered: blockedNative + blockedCandidate,
    merged,
    dupNative,
    dupInjected,
    empty,
  }
}

/** 当前播放位置（毫秒），拿不到返回 -1 */
function playbackMs() {
  try {
    const video = document.querySelector('video') as HTMLVideoElement | null
    return video && isFinite(video.currentTime)
      ? Math.round(video.currentTime * 1000)
      : -1
  } catch (error) {
    return -1
  }
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
  state.stats.lastSeg = request.index ?? null
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
  // 合并要求按时间有序，两路来源各自有序但拼起来不一定
  candidates.sort((a, b) => a.timeMs - b.timeMs)

  // 即使一个候选都没有也要继续：过滤器要作用在原生弹幕上，
  // 「没有第三方弹幕」不等于「这段响应不用改」。
  state.stats.available = candidates.length
  const result = pickComments(candidates, request, bytes, loadFilter())
  if (result.filtered) state.stats.filtered += result.filtered
  if (result.merged) state.stats.merged += result.merged
  if (result.droppedNative) state.stats.droppedNative += result.droppedNative

  if (!result.bytes) {
    const nativeTotal = decodeReply(bytes).records.length
    if (!candidates.length) {
      return detail(`没有候选弹幕，原生 ${nativeTotal} 条也不需要过滤，本段原样放行`)
    }
    // 打开右侧弹幕列表会一次性预取全部分段，那些段落在播放位置之外，
    // 本来就没有候选弹幕，不该显示成「全被丢弃」。
    const now = playbackMs()
    const ahead = now >= 0 && request.startMs > now + 30 * 1000
    const behind = now >= 0 && request.endMs < now - 60 * 1000
    if (ahead || behind) {
      return detail(
        `预取段（当前播放 ${Math.round(now / 1000)}s，本段 ${Math.round(
          request.startMs / 1000
        )}-${Math.round(request.endMs / 1000)}s），无需注入`
      )
    }

    // 候选时间范围能一眼看出「这一段本来就没弹幕」还是「时间轴整体错位」
    let min = Infinity
    let max = -Infinity
    for (const item of candidates) {
      if (item.timeMs < min) min = item.timeMs
      if (item.timeMs > max) max = item.timeMs
    }
    return detail(
      `候选 ${candidates.length} 条全被丢弃（窗外 ${result.outOfWindow}／过滤 ${result.filtered}／合并 ${result.merged}／撞原生 ${result.dupNative}／自撞 ${result.dupInjected}／空 ${result.empty}；本段 ${Math.round(
        request.startMs / 1000
      )}-${Math.round(request.endMs / 1000)}s，原生 ${nativeTotal} 条，候选 ${(
        min / 1000
      ).toFixed(1)}-${(max / 1000).toFixed(1)}s）`
    )
  }

  state.stats.segments++
  state.stats.injected += result.injected
  state.stats.lastMergedSeg = request.index ?? null
  const touches = [
    result.droppedNative ? `密度裁剪原生 ${result.droppedNative}` : '',
    result.filtered ? `过滤 ${result.filtered}` : '',
    result.merged ? `合并 ${result.merged}` : '',
  ]
    .filter(Boolean)
    .join('，')
  state.stats.lastDetail = result.injected
    ? `本段注入 ${result.injected} 条${touches ? `，${touches}` : ''}`
    : `本段未注入${touches ? `，只做了${touches}` : ''}`
  return result.bytes
}

/**
 * 播放器实际请求的 cid 变了（切了分P / 切了集）。
 *
 * 为什么需要这个：切分P 时 URL 上的 `?p=` 不一定更新，`__INITIAL_STATE__`
 * 更是只在首屏写过一次，于是面板那边靠读页面信息压根发现不了换集；
 * 但播放器每次换集都必须用新 cid 去请求弹幕。所以这里把「拦截到的 cid」
 * 当成换集的最可靠信号，让面板据此重新匹配集数。
 */
const cidListeners = new Set<(cid: number) => void>()

export function onCidChange(listener: (cid: number) => void) {
  cidListeners.add(listener)
  return () => {
    cidListeners.delete(listener)
  }
}

function notifyCid(cid: number) {
  if (!cidListeners.size) return
  for (const listener of cidListeners) {
    try {
      listener(cid)
    } catch (error) {
      console.warn('[danmaku-enhance] cid 变化回调出错', error)
    }
  }
}

/** 上一次见到的请求 cid，用来发现「换集了」 */
let lastRequestOid: number | null = null

/** 记一次弹幕分段请求（不管开关是否开启都记，方便诊断） */
function countRequest(request: SegRequest | undefined) {
  if (!request) return
  state.stats.requests++
  if (state.enabled) state.stats.armed++
  // 播放器请求的 cid 变了 = 真的换集了。这条信号比读页面信息可靠得多：
  // 切分P 时 URL 上的 p 不一定更新、__INITIAL_STATE__ 也不会重写。
  const oid = request.oid
  if (oid && oid !== lastRequestOid) {
    lastRequestOid = oid
    notifyCid(oid)
  }
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

  // 运行时强制重发弹幕的方案全部试过并被否掉：
  // reloadDanmaku/setDanmaku/弹幕开关在播放器 bundle 里不存在或只是渲染
  // 开关；player.reload 会整集重载把进度跳走；跨段 seek 会把播放位置挪走。
  // 现在唯一的用途是换集后探测播放器是否自行重发了请求——不再主动
  // 触发任何跳转，只观察 800ms 内 requests 计数有没有自然增长。
  const before = requestTicks()
  await sleep(RELOAD_WAIT_MS)
  return requestTicks() > before ? '播放器自行重载' : ''
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
 *
 * 但「等」必须是有前提的：只有在真的有一次匹配在路上时才值得等。
 * 之前是无条件等满 4 秒——匹配失败、开关刚打开还没开始匹配、
 * 或者根本没匹配上，这 4 秒就纯属白等，每段弹幕都晚 4 秒才显示。
 * 现在改成：没有匹配在路上就只给一个很短的启动宽限期（覆盖
 * 「请求先到、panel 后调 setLoading」这个竞态），然后立刻放行。
 */
async function waitForLoading() {
  if (state.comments) return

  const deadline = Date.now() + LOAD_WAIT_MS
  const graceDeadline = Date.now() + STARTUP_GRACE_MS
  let sawLoading = false

  while (Date.now() < deadline) {
    const loading = state.loading
    if (!loading) {
      // 已经在窄限期外，而且从头到尾没见过匹配：直接放行
      if (!sawLoading && Date.now() >= graceDeadline) return
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      continue
    }
    sawLoading = true
    await loading.then(
      () => undefined,
      () => undefined
    )
    // 这一轮匹配已经结束却没有结果（没匹配上），继续等也没意义
    if (!state.comments) return
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
    version:
      typeof GM_info !== 'undefined'
        ? ((GM_info as { script?: { version?: string } })?.script?.version ?? '')
        : '',
    sameWindow: page === window,
    hookUrl: SEG_PATH.source,
    mode: '接管 XHR',
    hasGM: typeof GM_xmlhttpRequest !== 'undefined',
  })
}
