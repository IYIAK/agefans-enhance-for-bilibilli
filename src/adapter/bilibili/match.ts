/**
 * 弹弹play 的匹配：候选关键词生成、番剧/集数选择、弹幕拉取。
 *
 * 弹弹play 的搜索是纯子串包含（LIKE %keyword%），没有分词和模糊匹配，
 * 而且最多只回 25 条、按 bangumiId 升序、不支持翻页。所以这里把“页面标题
 * 和库里的番名不完全一致”拆成若干个仍然保证是子串的候选关键词，逐个试。
 */
import {
  getComments,
  queryAnimes,
  queryEpisodes,
} from '../../player/plugins/danmaku/apis'
import type { Anime, Comment, Episode } from '../../player/plugins/danmaku/types'
import {
  storageAnimeName,
  storageEpisodeName,
} from '../../player/plugins/danmaku/utils'
import type { BiliPageInfo } from './info'

export type AnimeItem = Anime
export type EpisodeItem = Episode

/** 生成候选关键词时最多发几个搜索请求 */
const MAX_KEYWORD_TRIES = 12
/** 关键词与返回番名的最长公共子串低于这个长度就认为无关 */
const MIN_LCS = 3
/** 关键词最短长度，弹弹play 少于 2 字会直接报错 */
const MIN_KEYWORD_LEN = 3
/** 滑窗长度上下限：太短定位不到番剧，太长又躲不开译名里多出来的词 */
const WINDOW_MIN_LEN = 6
const WINDOW_MAX_LEN = 14

export interface MatchContext {
  /** 已经试过的关键词，失败时展示给用户 */
  tried: string[]
  animes: AnimeItem[]
  animeId?: string
  episodes?: EpisodeItem[]
}

export class MatchError extends Error {
  context: MatchContext

  constructor(message: string, context: Partial<MatchContext> = {}) {
    super(message)
    this.name = 'MatchError'
    this.context = { tried: [], animes: [], ...context }
  }
}

const commentCache = new Map<number, Comment[]>()

/** 集数标记：第3话 / 第 12 集 / 第1~4话 / 全25话 / [1] / EP12 */
const EPISODE_MARKERS: RegExp[] = [
  // 区间写法要先处理，否则「第1~4话」只会被啃掉后半截
  /第\s*[0-9]+(?:\.[0-9]+)?\s*[~～\-–—至到]\s*[0-9]+(?:\.[0-9]+)?\s*[集话話期回]/g,
  /第\s*[0-9]+(?:\.[0-9]+)?\s*[集话話期回]/g,
  /全\s*[0-9]+\s*[集话話期回]/g,
  /\[\s*[0-9]+(?:\.[0-9]+)?\s*\]/g,
  /\bEP?\.?\s*[0-9]+\b/gi,
]

/**
 * 更新状态词。番剧列表页会把这些词塞进标题，
 * 但弹弹play 的番名里不会有，留着就整串搜不到。
 * 只收「一定不是作品名一部分」的写法 —— 像光秃秃的「完结」
 * 有可能是「XX 完结篇」这种真标题，不敢动。
 */
const STATUS_WORDS =
  /(?:每周|每週|周更|週更|周更新|更新至|更新到|连载中|連載中|已完结|已完結)/g

/** 首尾要剥掉的标点与括号（成对出现的两边都剥） */
const EDGE_PUNCT =
  /[\s\-–—_:：、,，.。!！?？|~～【】［］\[\]（）()《》<>『』「」“”"'‘’]+/g

/** 成对的括号：页面标题里经常只有一半，另一半被集数标记啃掉了 */
const BRACKET_PAIRS: [string, string][] = [
  ['【', '】'],
  ['［', '］'],
  ['[', ']'],
  ['（', '）'],
  ['(', ')'],
  ['《', '》'],
  ['<', '>'],
  ['『', '』'],
  ['「', '」'],
]

/**
 * 删掉落单的括号。
 *
 * 页面标题常写成 `『佐佐木与文鸟小哔 第二季』第3话`：集数标记「第3话」在
 * 末尾，先被删掉之后，`』` 就孤零零地留在字符串中间，只剥首尾是不管用的。
 * 于是清洗结果里带着一个 `』`，整串搜不到，只能靠后面的短候选兜底。
 * 这里把每种成对括号数量对不上的一方全部删掉。
 */
function dropLoneBrackets(text: string): string {
  let out = text
  for (const [ open, close ] of BRACKET_PAIRS) {
    const left = out.split(open).length - 1
    const right = out.split(close).length - 1
    if (left === right) continue
    if (left > right) out = out.split(open).join(' ')
    else out = out.split(close).join(' ')
  }
  return out
}

/** 清洗标题：去掉集数标记、更新状态、落单括号与首尾装饰，保留内部分隔符 */
export function cleanTitle(raw: string): string {
  let title = String(raw || '').trim()

  for (const pattern of EPISODE_MARKERS) {
    title = title.replace(pattern, ' ')
  }
  title = title.replace(STATUS_WORDS, ' ')

  // 去掉常见的站点后缀
  title = title.replace(/\s*[-_|]\s*(在线观看|線上看|免费观看|高清).*$/g, ' ')

  // 集数标记删掉之后括号常常只剩下一边，先清掉再剥首尾
  title = dropLoneBrackets(title)

  // 首尾标点与括号
  title = title.replace(new RegExp(`^${EDGE_PUNCT.source}`), '')
  title = title.replace(new RegExp(`${EDGE_PUNCT.source}$`), '')
  // 剥一轮之后可能又露出新的，再来一次
  title = dropLoneBrackets(title)
  title = title.replace(new RegExp(`^${EDGE_PUNCT.source}`), '')
  title = title.replace(new RegExp(`${EDGE_PUNCT.source}$`), '')

  return title.replace(/\s+/g, ' ').trim()
}

/** 去掉所有分隔符与空格，处理全角半角差异 */
export function squash(title: string): string {
  return String(title || '').replace(
    /[\s\u3000\-–—_:：、,，.。!！?？|~～【】\[\]（）()《》<>『』「」“”・·'’"’]+/g,
    ''
  )
}

/** 按分隔符切段 */
function segments(title: string): string[] {
  return title
    .split(/[\s\u3000\-–—_:：、,，.。!！?？|~～【】\[\]（）()《》<>『』「」“”・·]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function half(text: string, which: 'head' | 'tail'): string {
  const middle = Math.ceil(text.length / 2)
  return which === 'head' ? text.slice(0, middle) : text.slice(middle)
}

/**
 * 生成候选关键词。顺序即尝试顺序，前面的更可能是精确命中。
 *
 * 例：`克雷瓦提斯-魔兽之王与婴儿与尸之勇者`
 *   ① 原样                       → 库里写法一致时直接命中
 *   ② 去掉全部分隔符              → 库里用空格/顿号代替横线时命中
 *   ③ 最长的片段                  → 副标题独立成条时命中
 *   ④ 该片段前半                  → 差异在尾部时命中
 *   ⑤ 第一个片段（通常是主标题）    → 库里只收了主标题时命中
 *   ⑥ 该片段后半                  → 差异在头部时命中
 *   ⑦ 该片段的滑窗                → 译名中间被加了词，整串搜不到时兜底
 *
 * ⑦ 是最后手段：页面标题常常在译名里多塞「身为」「迷情」这类词，
 * 于是整串必然不是库名的子串，只有退化成一段仍然连续的子串才搜得到。
 * 窗口长度取最长片段的一半，位置按剩余请求预算均匀取样，避免把预算
 * 全花在开头几个字上。
 */
export function buildKeywords(rawTitle: string): string[] {
  const title = cleanTitle(rawTitle)
  if (!title) return []

  const all = segments(title)
  const longest = [...all].sort((a, b) => b.length - a.length)[0]
  const first = all[0]

  const candidates = [
    title,
    squash(title),
    longest,
    longest && longest.length >= 6 ? half(longest, 'head') : '',
    first,
    longest && longest.length >= 6 ? half(longest, 'tail') : '',
  ]

  const seen = new Set<string>()
  const out: string[] = []
  const push = (raw: string | undefined, minLength = MIN_KEYWORD_LEN) => {
    const text = (raw || '').trim()
    if (text.length < minLength) return
    const key = squash(text)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(text)
  }

  candidates.forEach((raw, index) => {
    if (out.length >= MAX_KEYWORD_TRIES) return
    // 第 0 个就是清洗后的番名本身，哪怕只有两个字也得试。
    // 弹弹play 的搜索下限是两个字符，而《冰菓》《虫师》这类两字番名
    // 派生出任何候选都还是它自己，卡在 3 字会被整条丢光，
    // 于是 findAnime 直接报「没有可用的番剧名」，一次请求都不发。
    push(raw, index === 0 ? 2 : MIN_KEYWORD_LEN)
  })

  if (longest && out.length < MAX_KEYWORD_TRIES) {
    const budget = MAX_KEYWORD_TRIES - out.length
    const length = Math.max(
      WINDOW_MIN_LEN,
      Math.min(WINDOW_MAX_LEN, Math.floor(longest.length / 2))
    )
    const total = longest.length - length + 1
    if (total > 0) {
      // 预算不够覆盖每个位置时均匀跳着取样，而不是只取开头
      const stride = Math.max(1, Math.ceil(total / budget))
      for (let offset = 0; offset < total; offset += stride) {
        if (out.length >= MAX_KEYWORD_TRIES) break
        push(longest.slice(offset, offset + length))
      }
    }
  }

  return out
}

/** 最长公共子串长度，用来判断搜索结果是否跟关键词有关 */
export function longestCommonSubstring(a: string, b: string): number {
  const x = squash(a)
  const y = squash(b)
  if (!x || !y) return 0

  let best = 0
  let prev = new Array(y.length + 1).fill(0) as number[]
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0) as number[]
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

export function normalizeName(name: string) {
  return squash(name).toLowerCase()
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 解析「十二」「二十」「三」这类中文数字，纯数字原样返回 */
function parseCount(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text)

  const tensAt = text.indexOf('十')
  if (tensAt < 0) {
    return text.length === 1 ? CN_DIGITS[text] : undefined
  }
  const head = text.slice(0, tensAt)
  const tail = text.slice(tensAt + 1)
  const tens = head ? CN_DIGITS[head] : 1
  const ones = tail ? CN_DIGITS[tail] : 0
  if (tens === undefined || ones === undefined) return undefined
  return tens * 10 + ones
}

/**
 * 从番名里读出「第几季」。
 *
 * 这是为了防止把别的季的弹幕当成这一季：弹弹play 的搜索是子串匹配，
 * 页面写「镇魂街 第五季」而库里只有「镇魂街 第四季」时，搜索照样返回
 * 第四季。要是那成了唯一结果又被自动选中，屏幕上飘的就是上一季的弹幕，
 * 而状态行看着一切正常 —— 这种错比匹配失败更难发现。
 */
export function seasonOf(title: string): number | undefined {
  const marked = /第\s*([0-9]+|[零一二两三四五六七八九十]+)\s*[季期部]/.exec(title)
  if (marked) return parseCount(marked[1])

  const english = /\b(?:season|s)\s*([0-9]{1,2})\b/i.exec(title)
  if (english) return Number(english[1])

  return undefined
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sameId(a: unknown, b: unknown) {
  return String(a) === String(b)
}

export function searchAnime(keyword: string): Promise<AnimeItem[]> {
  return queryAnimes(keyword)
}

/**
 * 手动搜索：直接搜用户输入的内容，不再做候选生成。
 * 结果按与关键词的相关度（公共子串长度）排序，方便用户挑。
 */
export async function manualSearch(keyword: string): Promise<AnimeItem[]> {
  const text = keyword.trim()
  if (squash(text).length < 2) return []
  const list = await searchAnime(text)
  return [...list].sort(
    (a, b) =>
      longestCommonSubstring(text, b.name) - longestCommonSubstring(text, a.name)
  )
}

export async function episodeList(animeId: string): Promise<EpisodeItem[]> {
  return queryEpisodes(animeId)
}

export async function commentsOf(episodeId: number): Promise<Comment[]> {
  const cached = commentCache.get(episodeId)
  if (cached) return cached

  const comments = await getComments(episodeId)
  commentCache.set(episodeId, comments)
  return comments
}

/** 逐个试候选关键词，命中即停 */
export async function findAnime(
  rawTitle: string,
  log?: (msg: string) => void
): Promise<{ animes: AnimeItem[]; keyword: string; tried: string[] }> {
  const keywords = buildKeywords(rawTitle)
  if (!keywords.length) {
    throw new MatchError('没有可用的番剧名', { tried: [] })
  }

  const title = cleanTitle(rawTitle)
  const tried: string[] = []
  for (const keyword of keywords) {
    tried.push(keyword)
    let list: AnimeItem[]
    try {
      list = await searchAnime(keyword)
    } catch (error) {
      log?.(`搜索「${keyword}」失败：${(error as Error)?.message || error}`)
      continue
    }

    // 关键词本身比 MIN_LCS 还短时（两字番名），不可能有 3 字的公共子串，
    // 这时要求整串都对上，否则会把所有结果误杀。
    const need = Math.min(MIN_LCS, squash(keyword).length)
    const relevant = list.filter(
      (o) => longestCommonSubstring(keyword, o.name) >= need
    )
    if (relevant.length) {
      log?.(`「${keyword}」命中 ${relevant.length} 条`)
      // 弹弹play 按 bangumiId 升序返回，跟相关度无关；
      // 这里按「跟清洗后的页面标题的公共子串长度」重排，
      // 让最像的那条排在候选列表第一个。季数对得上的再往前放，
      // 免得「第五季」的候选列表第一条是「第四季」。
      const want = seasonOf(title)
      const ranked = [...relevant].sort((a, b) => {
        if (want !== undefined) {
          const pa = seasonOf(a.name) === want ? 1 : 0
          const pb = seasonOf(b.name) === want ? 1 : 0
          if (pa !== pb) return pb - pa
        }
        return (
          longestCommonSubstring(title, b.name) -
          longestCommonSubstring(title, a.name)
        )
      })
      return { animes: ranked, keyword, tried }
    }
    log?.(`「${keyword}」${list.length} 条结果都不相关`)
  }

  throw new MatchError(`弹弹play 未找到「${title}」`, { tried })
}

/** 从候选里挑最可能的番剧；只有高置信才自动选中 */
export function chooseAnime(
  animes: AnimeItem[],
  info: BiliPageInfo,
  hints: { animeId?: string } = {}
): AnimeItem | undefined {
  if (hints.animeId) {
    const hit = animes.find((o) => sameId(o.id, hints.animeId))
    if (hit) return hit
  }

  const stored = storageAnimeName(info.seriesName)
  if (stored) {
    const hit = animes.find((o) => sameId(o.id, stored.id))
    if (hit) return hit
  }

  const target = normalizeName(info.seriesName)
  const exact = animes.find((o) => normalizeName(o.name) === target)
  if (exact) return exact

  // 页面标题写了第几季，就必须挑同一季。库里只有别的季时宁可让用户
  // 自己选，也不能默默注入错的弹幕。
  const want = seasonOf(info.seriesName)
  if (want !== undefined) {
    const sameSeason = animes.filter((o) => seasonOf(o.name) === want)
    if (sameSeason.length === 1) return sameSeason[0]
    if (sameSeason.length > 1) return undefined

    // 一条同季的都没有：只接受压根没标季数的那种，
    // 弹弹play 常把一部番的所有季塞进同一个条目（比如「因为太怕痛就
    // 全点防御力了」只有一条，B 站页面却写「第二季」）。
    //
    // 但如果候选里还有别的条目标了季数，说明库里确实按季分开收，
    // 那条没标季数的就是更早的季，不能拿来顶。
    const seasonless = animes.filter((o) => seasonOf(o.name) === undefined)
    if (seasonless.length === 1 && seasonless.length === animes.length) {
      return seasonless[0]
    }
    return undefined
  }

  // 只有一条候选时就是它
  if (animes.length === 1) return animes[0]

  // 否则交给用户选
  return undefined
}

/** 从候选里挑出之前记住的那一部（用户在面板里手动选过） */
export function rememberedAnime(
  animes: AnimeItem[],
  seriesName: string
): AnimeItem | undefined {
  const stored = storageAnimeName(seriesName)
  if (!stored) return undefined
  const hit = animes.find((o) => sameId(o.id, stored.id))
  return hit
}

function parseEpisodeNumber(episode: string) {
  const match = episode.match(/([0-9]+(?:\.[0-9]+)?)/)
  return match ? match[1] : undefined
}

export function chooseEpisode(
  episodes: EpisodeItem[],
  info: BiliPageInfo,
  hints: { episodeId?: number } = {}
): EpisodeItem | undefined {
  if (hints.episodeId) {
    const hit = episodes.find((o) => sameId(o.id, hints.episodeId))
    if (hit) return hit
  }

  const storageKey = `${info.seriesName}.${info.episode}`
  const storedId = storageEpisodeName(storageKey)
  if (storedId) {
    const hit = episodes.find((o) => sameId(o.id, storedId))
    if (hit) return hit
  }

  if (info.episode) {
    const num = parseEpisodeNumber(info.episode)
    if (num) {
      const target = String(parseFloat(num))
      const strong = episodes.find((o) =>
        new RegExp(`第\\s*0*${escapeRegExp(target)}\\s*[集话話期回]`).test(o.name)
      )
      if (strong) return strong

      const loose = episodes.find((o) =>
        new RegExp(`(^|[^0-9])0*${escapeRegExp(target)}([^0-9]|$)`).test(o.name)
      )
      if (loose) return loose
    } else {
      const hit = episodes.find((o) => o.name.includes(info.episode))
      if (hit) return hit
    }
  }

  if (episodes.length === 1) return episodes[0]

  return undefined
}

/** 记住用户/自动选中的映射，下次打开同系列/同集时直接命中 */
export function rememberMatch(
  info: BiliPageInfo,
  anime: AnimeItem,
  episode?: EpisodeItem
) {
  storageAnimeName(info.seriesName, {
    id: anime.id,
    name: anime.name,
    keyword: info.seriesName,
  })
  if (episode) {
    storageEpisodeName(`${info.seriesName}.${info.episode}`, String(episode.id))
  }
}

export interface ResolvedMatch {
  comments: Comment[]
  animes: AnimeItem[]
  anime?: AnimeItem
  episodes?: EpisodeItem[]
  episode?: EpisodeItem
  keyword: string
  tried: string[]
}

/**
 * 完整流程：搜番 → 选集 → 取弹幕。
 * 任何一步不确定就抛 MatchError，由面板渲染选择框。
 */
export async function resolveMatch(
  info: BiliPageInfo,
  hints: { animeId?: string; episodeId?: number } = {},
  log?: (msg: string) => void
): Promise<ResolvedMatch> {
  if (!info.seriesName) {
    throw new MatchError('未识别到当前视频的标题')
  }

  const { animes, keyword, tried } = await findAnime(info.seriesName, log)

  const anime = chooseAnime(animes, info, hints)
  if (!anime) {
    throw new MatchError('请选择番剧', { tried, animes })
  }

  const episodes = await episodeList(anime.id)
  if (!episodes.length) {
    throw new MatchError(`「${anime.name}」没有可用的集数`, {
      tried,
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  const episode = chooseEpisode(episodes, info, hints)
  if (!episode) {
    throw new MatchError('请选择集数', {
      tried,
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  const comments = await commentsOf(episode.id)
  if (!comments.length) {
    throw new MatchError(`「${anime.name}」${episode.name} 没有弹幕`, {
      tried,
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  rememberMatch(info, anime, episode)

  return { comments, animes, anime, episodes, episode, keyword, tried }
}
