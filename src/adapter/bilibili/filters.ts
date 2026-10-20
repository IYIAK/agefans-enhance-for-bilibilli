/**
 * 弹幕过滤器。
 *
 * 能力对齐 pakku.js 里真正有用的那几项：
 * - 屏蔽词（字符串 / 正则），对应 pakku 的 blacklist 与「读播放器屏蔽设定」
 * - 按弹幕类型过滤（滚动 / 顶部 / 底部），对应 PROC_TYPE4 / PROC_TYPE7
 * - 合并时间窗内内容相近的重复弹幕，对应 THRESHOLD / MAX_DIST / DANMU_MARK
 * - 每分钟条数上限，对应 SHRINK_THRESHOLD 一类密度控制
 *
 * 过滤发生在注入管线里（hook.ts 的 pickComments），第三方弹幕与 B 站原生
 * 弹幕走的是同一套规则：原生弹幕在重建响应时按同样的条件被剔除，
 * 所以「屏蔽词」「屏蔽顶部」这类开关对画面上的所有弹幕一视同仁。
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
  /** B 站的 mode：1-3 滚动、4 底部、5 顶部、6 逆向、7 高级、8 代码、9 BAS */
  mode: number
  text: string
}

export type ModeKind = 'scroll' | 'top' | 'bottom' | 'other'

/** 把 B 站的 mode 归到面板上的三类开关 */
export function modeKind(mode: number): ModeKind {
  if (mode === 5) return 'top'
  if (mode === 4) return 'bottom'
  // 1-3 普通滚动、6 逆向滚动、7 高级、8 代码弹幕都跟着视频滚，算滚动类
  if (mode >= 1 && mode <= 3) return 'scroll'
  if (mode === 6) return 'scroll'
  return 'other'
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

export type BlockReason = 'mode' | 'keyword' | null

/**
 * 编译成「这一条该不该拦」的判定函数。
 *
 * 用判定函数而不是批量过滤，是因为原生弹幕要按下标剔除 —— 它们的原始字节
 * 需要按位置对应回 protobuf 记录。
 */
export function createBlockChecker(
  config: FilterConfig
): (item: FilterTarget) => BlockReason {
  if (!config.enabled) return () => null

  const rules = compileRules(config.keywords)
  const { hideScroll, hideTop, hideBottom } = config

  return (item) => {
    const kind = modeKind(item.mode)
    if (kind === 'scroll' && hideScroll) return 'mode'
    if (kind === 'top' && hideTop) return 'mode'
    if (kind === 'bottom' && hideBottom) return 'mode'
    if (rules.length && rules.some((rule) => rule.test(item.text))) {
      return 'keyword'
    }
    return null
  }
}

export interface RuleOutcome<T> {
  kept: T[]
  /** 被屏蔽词拦下的条数 */
  blockedKeyword: number
  /** 被类型开关拦下的条数 */
  blockedMode: number
}

/**
 * 屏蔽词 + 类型两道过滤。输入可以是第三方候选弹幕，也可以是解出来的原生
 * 弹幕 —— 两边的 mode 都是 B 站的编号，对「屏蔽顶部/底部」的判定一致。
 */
export function applyRules<T extends FilterTarget>(
  items: T[],
  config: FilterConfig
): RuleOutcome<T> {
  if (!config.enabled) {
    return { kept: items, blockedKeyword: 0, blockedMode: 0 }
  }

  const check = createBlockChecker(config)
  const kept: RuleOutcome<T>['kept'] = []
  let blockedKeyword = 0
  let blockedMode = 0

  for (const item of items) {
    const reason = check(item)
    if (reason === 'mode') blockedMode++
    else if (reason === 'keyword') blockedKeyword++
    else kept.push(item)
  }

  return { kept, blockedKeyword, blockedMode }
}

export interface DensityOutcome<T> {
  kept: T[]
  blocked: number
}

/**
 * 每分钟条数上限。输入应当是「同一分段里已经合并好的全部弹幕」（原生 + 第三方），
 * 这样画面上的密度才真的受控，而不是只限第三方那一半。
 * 超出时按等间距抽样，保留分布而不是砍掉尾巴。
 */
export function applyDensity<T extends FilterTarget>(
  items: T[],
  perMinute: number
): DensityOutcome<T> {
  const limit = Math.max(0, Math.round(perMinute))
  if (!limit || items.length <= limit) {
    return { kept: items, blocked: 0 }
  }

  const byMinute = new Map<number, T[]>()
  for (const item of items) {
    const bucket = Math.floor(item.timeMs / 60000)
    const list = byMinute.get(bucket)
    if (list) list.push(item)
    else byMinute.set(bucket, [item])
  }

  const result: DensityOutcome<T>['kept'] = []
  let blocked = 0
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
    blocked += list.length - limit
  }

  result.sort((a, b) => a.timeMs - b.timeMs)
  return { kept: result, blocked }
}

export interface FilterOutcome<T> {
  kept: T[]
  blockedKeyword: number
  blockedMode: number
  blockedDensity: number
}

/** 对单独一组弹幕跑完整的三道过滤，主要给测试与简单场景用 */
export function applyFilter<T extends FilterTarget>(
  items: T[],
  config: FilterConfig
): FilterOutcome<T> {
  if (!config.enabled) {
    return { kept: items, blockedKeyword: 0, blockedMode: 0, blockedDensity: 0 }
  }
  const rules = applyRules(items, config)
  const density = applyDensity(rules.kept, config.perMinute)
  return {
    kept: density.kept,
    blockedKeyword: rules.blockedKeyword,
    blockedMode: rules.blockedMode,
    blockedDensity: density.blocked,
  }
}
