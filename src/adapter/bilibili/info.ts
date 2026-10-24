/**
 * 读取 B 站当前页面正在播放的视频信息。
 *
 * 视频页：window.__INITIAL_STATE__（videoData / p）
 * 番剧页：window.__playinfo__（result.arc / result.supplement）
 * 兜底：document.title + 页面 DOM
 */
import { cleanTitle, splitCompoundTitle } from './match'

export interface BiliPageInfo {
  live: boolean
  /** 番剧/系列名 */
  seriesName: string
  /** 当前集，可能为空字符串 */
  episode: string
  cid?: number
  aid?: number
  source: 'video' | 'bangumi' | 'dom' | 'none'
}

interface InitialState {
  videoData?: {
    bvid?: string
    aid?: number
    title?: string
    cid?: number
    pages?: { cid?: number; page?: number; part?: string }[]
    owner?: { mid?: number; name?: string }
  }
  p?: number
  aid?: number
  cid?: number
}

interface PlayInfoResult {
  arc?: { aid?: number; cid?: number; title?: string }
  supplement?: {
    ogv_episode_info?: { episode_id?: number; index_title?: string; long_title?: string }
    ogv_season_info?: { season_id?: number; title?: string }
  }
  play_view_business_info?: {
    episode_info?: { aid?: number; cid?: number; ep_id?: number }
  }
  video_info?: { title?: string }
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

interface PageItem {
  cid?: number
  page?: number
  part?: string
}

/** 当前 URL 上的视频号。软跳转（相关推荐）时只有它一定会变。 */
export function readBvid(): string | undefined {
  return location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/)?.[1]
}

/**
 * 当前 URL 上的番剧集号（ep_id）。
 *
 * 番剧页没有 bvid，换集/点相关推荐时 URL 上变的是 `/bangumi/play/ep123`，
 * 所以这一路要单独有一个「不会撒谎」的信号，否则番剧页永远发现不了换集。
 */
export function readEpisodeId(): number | undefined {
  const fromPath = location.pathname.match(/\/bangumi\/play\/ep(\d+)/)
  if (fromPath) return toNumber(fromPath[1])
  return toNumber(new URLSearchParams(location.search).get('ep_id'))
}

/** 视频作者（UP 主） */
export interface BiliOwner {
  mid: number
  name: string
}

/**
 * 当前视频的 UP 主。
 *
 * 内存状态里 `videoData.owner` 直接给了 `{mid, name, face}`，连网络都不用；
 * 但它只属于「当前 URL 那个视频」（软跳转后可能是上一个视频的），
 * 所以先交给 `currentVideoData()` 把不属于当前 bvid 的情况挡掉，
 * 挡掉了再问 `x/web-interface/view?bvid=`（匿名可用）。
 */
export function readOwner(): BiliOwner | undefined {
  const videoData = currentVideoData()
  const owner = videoData?.owner
  const mid = toNumber(owner?.mid)
  if (mid) return { mid, name: String(owner?.name || '').trim() }
  return undefined
}

const ownerCache = new Map<string, BiliOwner>()

/** 内存里没有 owner 时的接口兜底（按 bvid 缓存，同一视频只会问一次） */
export async function fetchOwner(bvid: string): Promise<BiliOwner | undefined> {
  const cached = ownerCache.get(bvid)
  if (cached) return cached
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
      { credentials: 'omit' }
    )
    const body = (await res.json()) as {
      code?: number
      data?: { owner?: { mid?: number; name?: string } }
    }
    if (body?.code !== 0) return undefined
    const mid = toNumber(body.data?.owner?.mid)
    if (!mid) return undefined
    const owner = { mid, name: String(body.data?.owner?.name || '').trim() }
    ownerCache.set(bvid, owner)
    return owner
  } catch {
    return undefined
  }
}

/** 当前视频的 UP 主：先内存、再接口。用于白名单比对与「添加当前 UP 主」。 */
export async function resolveOwner(): Promise<BiliOwner | undefined> {
  const local = readOwner()
  if (local) return local
  const bvid = readBvid()
  if (!bvid) return undefined
  return fetchOwner(bvid)
}

/**
 * 按 mid 查名字，只给白名单做展示用。
 *
 * 用 `x/web-interface/card`（匿名可用，实测 code 0）；
 * `space/wbi/acc/info` 会报 -352 风控、按名字搜人的 `search/type` 报 412，
 * 两条都不能用。拿不到就返回空字符串，白名单照旧按 mid 生效。
 */
export async function fetchUserName(mid: number): Promise<string> {
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/web-interface/card?mid=${mid}`,
      { credentials: 'omit' }
    )
    const body = (await res.json()) as {
      code?: number
      data?: { card?: { name?: string } }
    }
    if (body?.code !== 0) return ''
    return String(body.data?.card?.name || '').trim()
  } catch {
    return ''
  }
}

/**
 * 当前分P 序号。B 站不会给 p=1 写参数，所以没有 p 就是第 1 分P；
 * `__INITIAL_STATE__.p` 在站内切换后是过期值，不能用来兜底。
 */function readUrlPage(): number {
  return toNumber(new URLSearchParams(location.search).get('p')) ?? 1
}

/**
 * 多分P 时用分P 名当集名；单P 视频没有「集」的概念，交给手动选择。
 * UGC 合集（投稿的「视频选集」）分P 名常常就是纯数字 `01`、`02`，
 * 这时归一成 `2`，交给 chooseEpisode 的强匹配去对「第2话」；
 * 分P 名为空也退回分P 序号，否则合集里永远匹配不到集数。
 */
function episodeOf(pages: PageItem[], index: number): string {
  if (pages.length <= 1) return ''
  const rawPart = String(pages[index]?.part || '').trim()
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(rawPart)) return String(parseFloat(rawPart))
  return rawPart || String(index + 1)
}

/** 直播页没有可注入的 cid，且播放器实现完全不同 */
export function isLivePage(): boolean {
  if (/(^|\.)live\.bilibili\.com$/.test(location.hostname)) return true
  return /^\/(live|blanc|p\/html\/blanc|room)\b/.test(location.pathname)
}

function readVideoInfo(): BiliPageInfo | undefined {
  const videoData = currentVideoData()
  if (!videoData) return undefined
  return buildVideoInfo(videoData, readUrlPage())
}

/**
 * 按 cid 反查分P。
 *
 * 为什么需要它：切分P 时 URL 上的 `?p=` 并不总是更新（有的入口是纯前端切，
 * 有的合集页干脆没有 p 参数），`__INITIAL_STATE__` 更是只在首屏渲染时写过一次。
 * 但播放器每次换集都必须用新的 cid 去请求弹幕——这个 cid 我们拦得到，
 * 拿它回查 pages 就能定出到底是第几分P，比猜 URL 可靠。
 *
 * 注意：某些页面（如新版「视频播客」合集页）在运行时会把
 * `__INITIAL_STATE__.videoData.pages` 替换或清空，SSR 里明明有 19 条、
 * 运行时却查不到。所以这里做两层：先查内存里的 pages，查不到再
 * 异步拉 `x/player/pagelist` 接口（匿名可用，返回全量分P）。
 */
export function readVideoInfoByCid(cid: number): BiliPageInfo | undefined {
  const videoData = currentVideoData()
  if (!videoData) return undefined
  const pages = Array.isArray(videoData.pages) ? videoData.pages : []
  const index = pages.findIndex((o) => toNumber(o?.cid) === cid)
  if (index < 0) return undefined
  return buildVideoInfo(videoData, index + 1)
}

/**
 * 内存里的视频状态，只在它确实属于当前 URL 的视频时才返回。
 *
 * 点相关推荐软跳转时 `__INITIAL_STATE__` 不重写，里面还是上一个视频的
 * title 和 pages —— 直接拿来用就会「换了视频还在用旧标题匹配」，
 * 而且旧视频的 pages 里查不到新视频的 cid，cid 反查也会跟着失效。
 */
function currentVideoData(): NonNullable<InitialState['videoData']> | undefined {
  const state = (window as any).__INITIAL_STATE__ as InitialState | undefined
  const videoData = state?.videoData
  if (!videoData) return undefined
  const urlBvid = readBvid()
  if (urlBvid && videoData.bvid && videoData.bvid !== urlBvid) return undefined
  return videoData
}

/**
 * cid 反查的接口兜底：`x/player/pagelist?bvid=`（匿名可用，零 header）。
 * 结果按 bvid 缓存——一个视频的分P 列表不会变。
 */
const pageListCache = new Map<string, PageItem[]>()
const titleCache = new Map<string, string>()

/** 拿不到页面标题时的接口兜底（软跳转到新视频、DOM 还没刷出新标题时） */
async function fetchVideoTitle(bvid: string): Promise<string> {
  const cached = titleCache.get(bvid)
  if (cached) return cached
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      credentials: 'omit',
    })
    const body = (await res.json()) as { code?: number; data?: { title?: string } }
    if (body?.code !== 0) return ''
    const title = String(body.data?.title || '').trim()
    if (title) titleCache.set(bvid, title)
    return title
  } catch {
    return ''
  }
}

export async function readVideoInfoByCidAsync(cid: number): Promise<BiliPageInfo | undefined> {
  // 1) 内存里的 pages 还能用就直接用
  const local = readVideoInfoByCid(cid)
  if (local) return local

  // 2) 从 URL 提 bvid，走接口拉全量分P
  const bvid = readBvid()
  if (!bvid) return undefined

  let pages = pageListCache.get(bvid)
  if (!pages) {
    try {
      const res = await fetch(
        `https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`,
        { credentials: 'omit' }
      )
      const body = (await res.json()) as { code?: number; data?: PageItem[] }
      if (body?.code !== 0 || !Array.isArray(body.data)) return undefined
      pages = body.data
      pageListCache.set(bvid, pages)
    } catch {
      return undefined
    }
  }

  const index = pages.findIndex((o) => toNumber(o?.cid) === cid)
  if (index < 0) return undefined

  // 标题按可靠性排序：内存状态（只在属于当前视频时才有效）→ 按 bvid 问接口
  // → 页面 DOM。
  //
  // 接口必须排在 DOM 前面：软跳转（点相关推荐）之后 `document.title` 常常
  // 还是上一个视频的名字，比接口慢一拍甚至好几秒。之前把 DOM 排在前面，
  // 于是「换集」这条路径也会把上一个视频的标题带进来 —— 面板看着换了页，
  // 匹配却仍拿旧番名在搜。接口结果按 bvid 缓存，同一视频只会问一次。
  const videoData = currentVideoData()
  const title = videoData
    ? String(videoData.title || '').trim()
    : (await fetchVideoTitle(bvid)) || readDomInfo().seriesName
  if (!title) return undefined

  // 同 buildVideoInfo：复合标题的番名/集数拆分，单分P 的集数补回标题标记。
  const compound = splitCompoundTitle(title)
  return {
    live: false,
    seriesName: compound?.seriesName || title,
    episode: episodeOf(pages, index) || compound?.episode || '',
    cid,
    aid: toNumber(videoData?.aid),
    source: 'video',
  }
}

/**
 * 按 bvid 拿当前页面视频的信息。
 *
 * 专门用于「点相关推荐软跳到另一个视频」：URL 已经是新 bvid，但
 * `__INITIAL_STATE__` 还在上一个视频上（`currentVideoData()` 会因此返回
 * undefined），`document.title` 也可能慢半拍。这时只能问接口。
 */
export async function readVideoInfoByBvidAsync(bvid: string): Promise<BiliPageInfo | undefined> {
  const local = currentVideoData()
  if (local) {
    const info = buildVideoInfo(local, readUrlPage())
    if (info) return info
  }

  const title = await fetchVideoTitle(bvid)
  if (!title) return undefined

  const page = readUrlPage()
  let pages = pageListCache.get(bvid)
  if (!pages) {
    try {
      const res = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, {
        credentials: 'omit',
      })
      const body = (await res.json()) as { code?: number; data?: PageItem[] }
      if (body?.code === 0 && Array.isArray(body.data)) {
        pages = body.data
        pageListCache.set(bvid, pages)
      }
    } catch {
      pages = undefined
    }
  }

  // 同 buildVideoInfo：复合标题拆分 + 单分P 集数兜底。
  const compound = splitCompoundTitle(title)
  return {
    live: false,
    seriesName: compound?.seriesName || title,
    episode: (pages ? episodeOf(pages, page - 1) : '') || compound?.episode || '',
    cid: toNumber(pages?.[page - 1]?.cid),
    source: 'video',
  }
}

function buildVideoInfo(
  videoData: NonNullable<InitialState['videoData']>,
  page: number
): BiliPageInfo | undefined {
  const pages = Array.isArray(videoData.pages) ? videoData.pages : []
  const pageData = pages[page - 1]
  const cid = toNumber(pageData?.cid) ?? toNumber(videoData.cid)
  const title = String(videoData.title || '').trim()

  if (!cid && !title) return undefined

  // 复合标题（「转发合集」式）：番名取最后一个标记内侧那部；集数优先分P 名
  // （多分P/合集的 part 就是集名），单分P 没有集名时退到标题里最后一个标记。
  // 之前只在 readDomInfo 的兜底里拆复合标题，而视频页走的是这条路——
  // 「【向日葵马戏团】第8集『花织同学…』第7话」这类单P 投稿就永远拿不到集数。
  const compound = splitCompoundTitle(title)
  return {
    live: false,
    seriesName: compound?.seriesName || title,
    episode: episodeOf(pages, page - 1) || compound?.episode || '',
    cid,
    aid: toNumber(videoData.aid),
    source: 'video',
  }
}

function readBangumiInfo(): BiliPageInfo | undefined {
  const result = (window as any).__playinfo__?.result as PlayInfoResult | undefined
  if (!result) return undefined

  const arc = result.arc || {}
  const episodeInfo = result.supplement?.ogv_episode_info
  const seasonInfo = result.supplement?.ogv_season_info
  const business = result.play_view_business_info?.episode_info

  const cid = toNumber(arc.cid) ?? toNumber(business?.cid)
  const seriesName = String(seasonInfo?.title || arc.title || result.video_info?.title || '').trim()
  // 切集时 __playinfo__ 可能还是上一集的数据，document.title 更新更及时
  const domEpisode = readDomInfo().episode
  const episode = (
    domEpisode ||
    String(episodeInfo?.index_title ?? episodeInfo?.long_title ?? '')
  ).trim()

  if (!cid && !seriesName) return undefined

  return {
    live: false,
    seriesName,
    episode,
    cid,
    aid: toNumber(arc.aid) ?? toNumber(business?.aid),
    source: 'bangumi',
  }
}

function readDomInfo(): BiliPageInfo {
  const title = document.title || ''

  // 「转发合集」式复合标题优先：【A】第8集『B』第7话 —— 第一个集数属于
  // 原作 A，真正在播的是『B』；取最后一个标记的番名与集数。DOM 里的
  // 系列名常是合集标题（「向日葵马戏团」），用它会把集数对到错误的番上。
  const compound = splitCompoundTitle(title)

  // 番剧/影视页左侧的系列名
  const $mediaTitle = $('a[class*="mediainfo_mediaTitle"]').first()
  let seriesName = String($mediaTitle.attr('title') || '').trim()

  if (!seriesName) {
    const $heading = $('h1.video-title, .video-title, [class*="videoTitle"]').first()
    seriesName = String($heading.text() || '').trim()
  }

  if (!seriesName) {
    seriesName = String(title.split(/[-_|]/)[0] || '').trim()
  }

  // 集数单位要跟 match.ts 的 EPISODE_MARKERS 对齐，繁体「話」和「回」也算：
  // 港台番剧页标题常写「第3話」，只认简体就会漏。
  const episodeMatch = title.match(/第\s*([0-9]+(?:\.[0-9]+)?)\s*[集话話期回]/)
  let episode = episodeMatch ? episodeMatch[1] : ''

  if (compound) {
    // 复合标题：番名与集数都以最后一个标记为准（在播的那部）。
    seriesName = compound.seriesName
    episode = compound.episode
  } else if (seriesName && episode) {
    // 普通标题：把「第N集」这类尾巴从系列名里剥掉，
    // 留给弹弹play 的是纯番名。
    seriesName = cleanTitle(seriesName) || seriesName
  }

  return {
    live: false,
    seriesName,
    episode,
    source: seriesName ? 'dom' : 'none',
  }
}

export function readPageInfo(): BiliPageInfo {
  if (isLivePage()) {
    return { live: true, seriesName: '', episode: '', source: 'none' }
  }

  return readVideoInfo() ?? readBangumiInfo() ?? readDomInfo()
}
