/**
 * 弹幕过滤器。
 *
 * 能力对齐 pakku.js 里真正有用的那几项：
 * - 屏蔽词（字符串 / 正则），对应 pakku 的 blacklist 与「读播放器屏蔽设定」
 * - 按弹幕类型过滤（滚动 / 顶部 / 底部），对应 PROC_TYPE4 / PROC_TYPE7
 * - 合并时间窗内内容相近的重复弹幕，对应 THRESHOLD / MAX_DIST / DANMU_MARK
 * - 每分钟条数上限，对应 SHRINK_THRESHOLD 一类密度控制
 *
 * 过滤发生在注入管线里（hook.ts 的 pickComments），所以只影响第三方弹幕，
 * B 站原生弹幕照旧由播放器自己处理。
 */
import { gm } from '../../utils/storage'

const FILTER_KEY = 'bilibili-danmaku-filter-v1'

export interface FilterConfig {
  /** 关闭后只做时间窗筛选，不做任何过滤 */
  enabled: boolean
  /** 屏蔽词，一行一条；`/pattern/flags` 或 `re:pattern` 视为正则 */
  keywords: string[]
  hideScroll: boolean
  hideTop: boolean
  hideBottom: boolean
  /** 合并内容相近的重复弹幕（pakku 的默认行为） */
  mergeSimilar: boolean
  /** 合并的时间窗口，单位秒；pakku 默认 30 */
  mergeWindowSec: number
  /** 每分钟最多注入多少条，0 表示不限 */
  perMinute: number
}

export const DEFAULT_FILTER: FilterConfig = {
  enabled: true,
  keywords: [],
  hideScroll: false,
  hideTop: false,
  hideBottom: false,
  mergeSimilar: true,
  mergeWindowSec: 30,
  perMinute: 0,
}

export function loadFilter(): FilterConfig {
  const raw = gm.getItem<any>(FILTER_KEY, {})
  const base = raw && typeof raw === 'object' ? raw : {}
  const config: FilterConfig = { ...DEFAULT_FILTER, ...base }
  config.keywords = Array.isArray(config.keywords)
    ? config.keywords.filter((o) => typeof o === 'string')
    : []
  if (!Number.isFinite(config.mergeWindowSec)) {
    config.mergeWindowSec = DEFAULT_FILTER.mergeWindowSec
  }
  if (!Number.isFinite(config.perMinute)) {
    config.perMinute = DEFAULT_FILTER.perMinute
  }
  return config
}

export function saveFilter(config: FilterConfig) {
  gm.setItem(FILTER_KEY, config)
}

export interface FilterTarget {
  timeMs: number
  mode: 1 | 4 | 5
  text: string
}

/** 一条已经编译好的屏蔽规则 */
interface Rule {
  test(text: string): boolean
}

function compileRule(raw: string): Rule | null {
  const rule = raw.trim()
  if (!rule) return null

  // `/pattern/flags` 或 `re:pattern` 用正则，其余按子串（不区分大小写）
  const regex =
    /^\/(.+)\/([a-z]*)$/.exec(rule) ||
    (/^re:/i.test(rule) ? ([rule, rule.slice(3), ''] as any) : null)

  if (regex) {
    try {
      const re = new RegExp(regex[1], regex[2] || 'i')
      return { test: (text) => re.test(text) }
    } catch (error) {
      console.warn('[danmaku-enhance] 屏蔽词正则无效，按子串处理', rule)
    }
  }

  const needle = rule.toLowerCase()
  return { test: (text) => text.toLowerCase().includes(needle) }
}

export function compileRules(keywords: string[]): Rule[] {
  const rules: Rule[] = []
  for (const keyword of keywords) {
    const rule = compileRule(keyword)
    if (rule) rules.push(rule)
  }
  return rules
}

/** 去掉不参与比较的字符：空白、常见标点、全角转半角、统一小写 */
export function normalizeForCompare(text: string) {
  return text
    .replace(/[\uff01-\uff5e]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/[\s\u3000]+/g, '')
    .replace(/[~!@#$%^&*()\-_=+[\]{}\\|;:'",.<>/?、。，！？；：""''《》【】「」『』…—·]/g, '')
    .toLowerCase()
}

function levenshtein(a: string, b: string) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array<number>(b.length + 1)
  let next = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    next[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = next
    next = swap
  }
  return prev[b.length]
}

/**
 * 两条弹幕是否算「同一句」。pakku 用编辑距离 + 余弦相似度两路判断，
 * 这里用归一化后的编辑距离近似，够覆盖「哈哈哈」「哈哈哈哈哈」这类刷屏。
 */
export function isSimilar(a: string, b: string) {
  const left = normalizeForCompare(a)
  const right = normalizeForCompare(b)
  if (!left || !right) return false
  if (left === right) return true

  const short = Math.min(left.length, right.length)
  const long = Math.max(left.length, right.length)
  // 太短的句子只认完全相同，否则「好」「好耶」会被误合并
  if (short < 3) return false
  // 长度差太多的直接排除，省掉一次动态规划
  if (long - short > Math.max(4, long * 0.5)) return false
  // 长句只比较前缀区域，避免编辑距离失效
  if (long > 64) return left.includes(right) || right.includes(left)

  const dist = levenshtein(left, right)
  return dist <= 5 && dist / long <= 0.45
}

export interface FilterOutcome<T> {
  kept: T[]
  /** 被屏蔽词拦下的条数 */
  blockedKeyword: number
  /** 被类型开关拦下的条数 */
  blockedMode: number
  /** 因为每分钟上限被丢掉的条数 */
  blockedDensity: number
}

/** 类型 / 屏蔽词 / 密度三道过滤；相似合并由调用方在时间窗内做 */
export function applyFilter<T extends FilterTarget>(
  items: T[],
  config: FilterConfig
): FilterOutcome<T> {
  if (!config.enabled) {
    return { kept: items, blockedKeyword: 0, blockedMode: 0, blockedDensity: 0 }
  }

  const rules = compileRules(config.keywords)
  const kept: FilterOutcome<T>['kept'] = []
  let blockedKeyword = 0
  let blockedMode = 0

  for (const item of items) {
    if (item.mode === 1 && config.hideScroll) {
      blockedMode++
      continue
    }
    if (item.mode === 5 && config.hideTop) {
      blockedMode++
      continue
    }
    if (item.mode === 4 && config.hideBottom) {
      blockedMode++
      continue
    }
    if (rules.length && rules.some((rule) => rule.test(item.text))) {
      blockedKeyword++
      continue
    }
    kept.push(item)
  }

  const limit = Math.max(0, Math.round(config.perMinute))
  if (!limit) {
    return { kept, blockedKeyword, blockedMode, blockedDensity: 0 }
  }

  // 每分钟超出上限时按等间距抽样，保留分布而不是砍掉尾巴
  const byMinute = new Map<number, T[]>()
  for (const item of kept) {
    const bucket = Math.floor(item.timeMs / 60000)
    const list = byMinute.get(bucket)
    if (list) list.push(item)
    else byMinute.set(bucket, [item])
  }

  const result: FilterOutcome<T>['kept'] = []
  let blockedDensity = 0
  for (const list of byMinute.values()) {
    if (list.length <= limit) {
      result.push(...list)
      continue
    }
    const step = list.length / limit
    for (let i = 0; i < limit; i++) {
      // 取每个区间的中点，避免抽样整体偏向开头
      const idx = Math.min(list.length - 1, Math.floor((i + 0.5) * step))
      result.push(list[idx])
    }
    blockedDensity += list.length - limit
  }

  result.sort((a, b) => a.timeMs - b.timeMs)
  return { kept: result, blockedKeyword, blockedMode, blockedDensity }
}
