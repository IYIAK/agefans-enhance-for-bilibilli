/**
 * 读取 B 站当前页面正在播放的视频信息。
 *
 * 视频页：window.__INITIAL_STATE__（videoData / p）
 * 番剧页：window.__playinfo__（result.arc / result.supplement）
 * 兜底：document.title + 页面 DOM
 */
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

/** 直播页没有可注入的 cid，且播放器实现完全不同 */
export function isLivePage(): boolean {
  if (/(^|\.)live\.bilibili\.com$/.test(location.hostname)) return true
  return /^\/(live|blanc|p\/html\/blanc|room)\b/.test(location.pathname)
}

function readVideoInfo(): BiliPageInfo | undefined {
  const state = (window as any).__INITIAL_STATE__ as InitialState | undefined
  const videoData = state?.videoData
  if (!videoData) return undefined

  // SPA 切分P 时 __INITIAL_STATE__ 可能还没更新，优先用 URL 上的 p
  const urlPage = toNumber(new URLSearchParams(location.search).get('p'))
  const page = Math.max(1, urlPage ?? (Number(state?.p) || 1))
  const pages = Array.isArray(videoData.pages) ? videoData.pages : []
  const pageData = pages[page - 1]
  const cid = toNumber(pageData?.cid) ?? toNumber(videoData.cid)
  const title = String(videoData.title || '').trim()

  if (!cid && !title) return undefined

  // 多分P 时用分P 名当集名；单P 视频没有“集”的概念，交给手动选择
  const episode = pages.length > 1 ? String(pageData?.part || '').trim() : ''

  return {
    live: false,
    seriesName: title,
    episode,
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

  const episodeMatch = title.match(/第\s*([0-9]+(?:\.[0-9]+)?)\s*[集话期]/)
  const episode = episodeMatch ? episodeMatch[1] : ''

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
