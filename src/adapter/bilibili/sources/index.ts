/**
 * URL 弹幕源：从一个视频页 URL 解析出分集信息和弹幕。
 *
 * 目前内置两种站点：
 *   - bilibili.com   视频页/番剧页，弹幕走 seg.so 分段 protobuf
 *   - ani.gamer.com.tw 巴哈姆特动画疯，弹幕走 ajax/danmuGet.php 整集 JSON
 *
 * 新增站点只需实现 UrlSource，并注册到 SOURCES。
 */
import { decodeElems } from '../proto'
import { getBytes, getJson, postJson } from './net'

export type SourceId = 'bilibili' | 'bahamut'

export interface SourceEpisode {
  /** 站点内部分集标识：B站是 cid，巴哈姆特是 sn */
  id: string
  /** 集标题，用于面板展示 */
  title: string
  /** 该集在整季里的序号，从 1 开始；未知时 undefined */
  index?: number
  /** 该集时长（秒），未知时 undefined */
  durationSec?: number
}

export interface SourceSeries {
  source: SourceId
  /** 系列名 */
  title: string
  episodes: SourceEpisode[]
  /** 当前 URL 指向的那一集 */
  current?: SourceEpisode
}

export interface DanmakuItem {
  timeMs: number
  /** 1=滚动 4=底部 5=顶部 */
  mode: 1 | 4 | 5
  color: number
  text: string
}

export interface UrlSource {
  id: SourceId
  label: string
  /** 这个 URL 是否归本源处理 */
  match(url: URL): boolean
  /** 解析系列与分集 */
  resolve(url: URL): Promise<SourceSeries>
  /** 拉取整集弹幕（按时间升序） */
  load(episode: SourceEpisode, onProgress?: (msg: string) => void): Promise<DanmakuItem[]>
}

/** 从各种 URL 形态里抠出 bvid / av 号 / ep_id / season_id */
interface BiliRefs {
  bvid?: string
  aid?: number
  epId?: number
  seasonId?: number
  page?: number
}

function parseBiliRefs(url: URL): BiliRefs {
  const refs: BiliRefs = {}
  const path = url.pathname

  const bv = path.match(/\/(BV[0-9A-Za-z]{10})/)
  if (bv) refs.bvid = bv[1]
  const bvQuery = url.searchParams.get('bvid')
  if (!refs.bvid && bvQuery) refs.bvid = bvQuery

  const av = path.match(/\/av(\d+)/i)
  if (av) refs.aid = Number(av[1])
  const avQuery = url.searchParams.get('aid')
  if (!refs.aid && avQuery) refs.aid = Number(avQuery)

  const epQuery = url.searchParams.get('ep_id')
  if (epQuery) refs.epId = Number(epQuery)
  const epPath = path.match(/\/ep(\d+)/)
  if (!refs.epId && epPath) refs.epId = Number(epPath[1])

  const ssQuery = url.searchParams.get('season_id')
  if (ssQuery) refs.seasonId = Number(ssQuery)
  const ssPath = path.match(/\/ss(\d+)/)
  if (!refs.seasonId && ssPath) refs.seasonId = Number(ssPath[1])

  const p = Number(url.searchParams.get('p'))
  if (Number.isFinite(p) && p > 0) refs.page = p

  return refs
}

interface VideoView {
  code: number
  data?: {
    aid?: number
    bvid?: string
    cid?: number
    title?: string
    pages?: { cid?: number; page?: number; part?: string; duration?: number }[]
  }
}

interface SeasonView {
  code: number
  result?: {
    season_id?: number
    title?: string
    episodes?: {
      id?: number
      cid?: number
      bvid?: string
      title?: string
      long_title?: string
      duration?: number
    }[]
    section?: {
      title?: string
      episodes?: {
        id?: number
        cid?: number
        bvid?: string
        title?: string
        long_title?: string
        duration?: number
      }[]
    }[]
  }
}

const BILI_HEADERS = { Referer: 'https://www.bilibili.com/' }

export const bilibiliSource: UrlSource = {
  id: 'bilibili',
  label: '哔哩哔哩',

  match(url) {
    return /(^|\.)bilibili\.com$/.test(url.hostname)
  },

  async resolve(url) {
    const refs = parseBiliRefs(url)

    // 番剧/影视：ep_id 或 season_id
    if (refs.epId || refs.seasonId) {
      const params: Record<string, string | number> = refs.epId
        ? { ep_id: refs.epId }
        : { season_id: refs.seasonId! }
      const res = await getJson<SeasonView>(
        'https://api.bilibili.com/pgc/view/web/season',
        params
      )
      if (res.code !== 0 || !res.result) {
        throw new Error(`读取番剧信息失败（code=${res.code}）`)
      }

      const main = res.result.episodes || []
      const all = [...main]
      for (const section of res.result.section || []) {
        for (const ep of section.episodes || []) all.push(ep)
      }

      // 当前集按 ep_id 匹配（episode.id 是 ep_id，弹幕要用 cid）
      let currentIndex = -1
      const episodes: SourceEpisode[] = []
      all.forEach((ep, i) => {
        if (!ep.cid) return
        if (refs.epId && Number(ep.id) === Number(refs.epId)) currentIndex = episodes.length
        episodes.push({
          id: String(ep.cid),
          title: String(ep.long_title || ep.title || `第${i + 1}集`).trim(),
          index: i + 1,
          durationSec: ep.duration ? Math.round(ep.duration / 1000) : undefined,
        })
      })

      const current = currentIndex >= 0 ? episodes[currentIndex] : undefined

      return {
        source: 'bilibili',
        title: String(res.result.title || '').trim(),
        episodes,
        current,
      }
    }

    // 普通视频：bvid / aid
    const params: Record<string, string | number> = {}
    if (refs.bvid) params.bvid = refs.bvid
    else if (refs.aid) params.aid = refs.aid

    if (!params.bvid && !params.aid) {
      throw new Error('URL 里没有识别到 bvid / av 号 / ep_id')
    }

    const res = await getJson<VideoView>(
      'https://api.bilibili.com/x/web-interface/view',
      params
    )
    if (res.code !== 0 || !res.data) {
      throw new Error(`读取视频信息失败（code=${res.code}）`)
    }

    const pages = res.data.pages || []
    const episodes: SourceEpisode[] = pages.length
      ? pages.map((p, i) => ({
          id: String(p.cid || ''),
          title: pages.length > 1 ? String(p.part || `P${p.page ?? i + 1}`) : String(res.data!.title || ''),
          index: i + 1,
          durationSec: p.duration,
        }))
      : [
          {
            id: String(res.data.cid || ''),
            title: String(res.data.title || ''),
            index: 1,
          },
        ]

    const pageIndex = Math.max(1, refs.page || 1) - 1
    return {
      source: 'bilibili',
      title: String(res.data.title || '').trim(),
      episodes: episodes.filter((e) => e.id),
      current: episodes[pageIndex],
    }
  },

  async load(episode, onProgress) {
    if (!episode.id) return []

    const out: DanmakuItem[] = []
    // 每段 6 分钟；遇到 304 或空段就停，最多 60 段（6 小时）
    for (let segment = 1; segment <= 60; segment++) {
      let result
      try {
        result = await getBytes('https://api.bilibili.com/x/v2/dm/web/seg.so', {
          type: 1,
          oid: episode.id,
          segment_index: segment,
        })
      } catch (error) {
        // 单段失败就跳过，不影响已拿到的
        onProgress?.(`第 ${segment} 段失败：${(error as Error).message}`)
        break
      }

      if (result.status === 304 || !result.bytes || !result.bytes.length) {
        onProgress?.(`共 ${segment - 1} 段 ${out.length} 条`)
        break
      }

      const elems = decodeElems(result.bytes)
      if (!elems.length) {
        onProgress?.(`共 ${segment - 1} 段 ${out.length} 条`)
        break
      }

      for (const elem of elems) {
        out.push({
          timeMs: elem.timeMs,
          mode: (elem.mode as 1 | 4 | 5) || 1,
          color: elem.color,
          text: elem.text,
        })
      }
      onProgress?.(`已拉 ${segment} 段 ${out.length} 条`)
    }

    return out.sort((a, b) => a.timeMs - b.timeMs)
  },
}

interface BahamutDanmaku {
  text?: string
  color?: string
  size?: number
  /** 0=滚动 1=顶部 2=底部（待确认，实测 0 最多） */
  position?: number
  /** 秒 */
  time?: number
  sn?: number
}

function parseHexColor(color?: string) {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    return parseInt(color.slice(1), 16)
  }
  return 0xffffff
}

function bahamutPositionToMode(position?: number): 1 | 4 | 5 {
  // 实测 position: 0 最多（滚动），1 次多，2 最少
  if (position === 1) return 5
  if (position === 2) return 4
  return 1
}

export const bahamutSource: UrlSource = {
  id: 'bahamut',
  label: '巴哈姆特动画疯',

  match(url) {
    return /(^|\.)gamer\.com\.tw$/.test(url.hostname)
  },

  async resolve(url) {
    const videoSn = Number(url.searchParams.get('sn'))
    if (!Number.isFinite(videoSn) || videoSn <= 0) {
      throw new Error('巴哈姆特 URL 里没有 sn')
    }

    // 用 GM 请求拿 HTML，从 <section class="season"> 里抠出整季的 sn 列表
    const html = await new Promise<string>((resolve, reject) => {
      GM_xmlhttpRequest({
        url: `https://ani.gamer.com.tw/animeVideo.php?sn=${videoSn}`,
        method: 'GET',
        responseType: 'text' as any,
        headers: { Referer: 'https://ani.gamer.com.tw/' },
        timeout: 15000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 400) {
            reject(new Error(`HTTP ${res.status}`))
            return
          }
          resolve(String(res.responseText || ''))
        },
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('请求超时')),
      })
    })

    const titleMatch = html.match(/animefun\.title\s*=\s*'([^']*)'/)
    const rawTitle = titleMatch ? titleMatch[1] : ''
    // animefun.title 形如 “野生的大魔王出現了！ [1]”
    const seriesTitle = rawTitle.replace(/\s*\[[^\]]*\]\s*$/, '').trim()

    const epPattern = /data-ani-video-sn="(\d+)">([^<]*)</g
    const pairs: { sn: string; label: string }[] = []
    let epMatch: RegExpExecArray | null
    while ((epMatch = epPattern.exec(html))) {
      pairs.push({ sn: epMatch[1], label: String(epMatch[2] || '').trim() })
    }

    const episodes: SourceEpisode[] = pairs.length
      ? pairs.map((p, i) => ({
          id: p.sn,
          title: p.label ? `第 ${p.label} 集` : `第 ${i + 1} 集`,
          index: i + 1,
        }))
      : [{ id: String(videoSn), title: '当前集', index: 1 }]

    const current = episodes.find((e) => e.id === String(videoSn)) || episodes[0]

    return { source: 'bahamut', title: seriesTitle || rawTitle, episodes, current }
  },

  async load(episode, onProgress) {
    if (!episode.id) return []
    // 巴哈姆特必须用 POST，GET 会忽略 sn 返回默认内容
    const { response } = await postJson<BahamutDanmaku[]>(
      'https://ani.gamer.com.tw/ajax/danmuGet.php',
      `sn=${episode.id}`,
      { Referer: 'https://ani.gamer.com.tw/' }
    )

    const list = Array.isArray(response) ? response : []
    const out = list
      .map((item) => ({
        timeMs: Math.round((item.time || 0) * 1000),
        mode: bahamutPositionToMode(item.position),
        color: parseHexColor(item.color),
        text: String(item.text || '').trim(),
      }))
      .filter((item) => item.text)

    onProgress?.(`共 ${out.length} 条`)
    return out.sort((a, b) => a.timeMs - b.timeMs)
  },
}

export const SOURCES: UrlSource[] = [bilibiliSource, bahamutSource]

export function findSource(url: URL): UrlSource | undefined {
  return SOURCES.find((s) => s.match(url))
}
