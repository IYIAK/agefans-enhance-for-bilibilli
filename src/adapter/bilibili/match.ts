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

export interface MatchResult {
  comments: Comment[]
  animes: AnimeItem[]
  episodes: EpisodeItem[]
  animeId: string
  animeName: string
  episodeId: number
  episodeName: string
}

export interface MatchHints {
  animeId?: string
  episodeId?: number
}

/** 匹配失败时携带面板渲染选择框所需的上下文 */
export class MatchError extends Error {
  animes: AnimeItem[]
  animeId?: string
  episodes?: EpisodeItem[]

  constructor(
    message: string,
    context: {
      animes?: AnimeItem[]
      animeId?: string
      episodes?: EpisodeItem[]
    } = {}
  ) {
    super(message)
    this.name = 'MatchError'
    this.animes = context.animes || []
    this.animeId = context.animeId
    this.episodes = context.episodes
  }
}

const commentCache = new Map<number, Comment[]>()

function normalizeName(name: string) {
  return name
    .replace(/[\s\u3000]+/g, '')
    .replace(/[【】\[\]（）()《》<>·!！?？:：,，.。'’"“”\-—_~～]/g, '')
    .toLowerCase()
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sameId(a: unknown, b: unknown) {
  return String(a) === String(b)
}

export async function searchAnimeList(info: BiliPageInfo): Promise<AnimeItem[]> {
  const keyword = info.seriesName.trim()
  if (!keyword) return []
  return queryAnimes(keyword)
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

function chooseAnime(
  animes: AnimeItem[],
  info: BiliPageInfo,
  hints: MatchHints
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

  // 没有精确匹配时先选第一个，面板里会提示并允许手动更换
  return animes[0]
}

function parseEpisodeNumber(episode: string) {
  const match = episode.match(/([0-9]+(?:\.[0-9]+)?)/)
  return match ? match[1] : undefined
}

function chooseEpisode(
  episodes: EpisodeItem[],
  info: BiliPageInfo,
  hints: MatchHints
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
        new RegExp(`第\\s*0*${escapeRegExp(target)}\\s*[集话期]`).test(o.name)
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

export async function resolveComments(
  info: BiliPageInfo,
  hints: MatchHints = {}
): Promise<MatchResult> {
  if (!info.seriesName) {
    throw new MatchError('未识别到当前视频的标题')
  }

  const animes = await searchAnimeList(info)
  if (!animes.length) {
    throw new MatchError(`弹弹play 未找到「${info.seriesName}」`, { animes })
  }

  const anime = chooseAnime(animes, info, hints)
  if (!anime) {
    throw new MatchError('请选择番剧', { animes })
  }

  const episodes = await episodeList(anime.id)
  if (!episodes.length) {
    throw new MatchError(`「${anime.name}」没有可用的集数`, {
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  const episode = chooseEpisode(episodes, info, hints)
  if (!episode) {
    throw new MatchError('请选择集数', {
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  const comments = await commentsOf(episode.id)
  if (!comments.length) {
    throw new MatchError(`「${anime.name}」${episode.name} 没有弹幕`, {
      animes,
      animeId: anime.id,
      episodes,
    })
  }

  rememberMatch(info, anime, episode)

  return {
    comments,
    animes,
    episodes,
    animeId: anime.id,
    animeName: anime.name,
    episodeId: episode.id,
    episodeName: episode.name,
  }
}
