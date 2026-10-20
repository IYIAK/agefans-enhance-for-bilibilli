/**
 * URL 弹幕源的运行时状态：最多 3 条来源、各自的时间偏移、顺序预取。
 *
 * 预取由各 UrlSource.load() 自己按顺序发分段、并发 1、遇到 304/空段即停，
 * 这样不需要知道总时长也能拉完整集。
 */
import { loadSources, saveSources, storageSourceOffset } from '../store'
import { findSource } from './index'
import type { DanmakuItem, SourceEpisode, UrlSource } from './index'

export interface UrlSourceEntry {
  /** 唯一 id，用于删除/更新 */
  key: string
  url: string
  sourceId: string
  sourceLabel: string
  seriesTitle: string
  episode: SourceEpisode
  /** 时间偏移（毫秒），正数表示弹幕整体延后 */
  offsetMs: number
  items: DanmakuItem[]
  loading: boolean
  error?: string
  progress: string
}

const MAX_SOURCES = 3

let entries: UrlSourceEntry[] = []
/**
 * 当前页面标识。URL 来源按页面分开存：在 A 视频上加的来源不该出现在 B 视频里。
 */
let pageKey = ''
const listeners = new Set<() => void>()
/** 每条来源的加载序号，用来丢弃过期的回调 */
const loadSeq = new Map<string, number>()

function notify() {
  listeners.forEach((fn) => fn())
}

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getEntries(): UrlSourceEntry[] {
  return entries
}

/** 当前所有来源的弹幕，已应用各自的偏移 */
export function collectItems(): DanmakuItem[] {
  const out: DanmakuItem[] = []
  for (const entry of entries) {
    if (!entry.items.length) continue
    for (const item of entry.items) {
      const timeMs = item.timeMs + entry.offsetMs
      if (timeMs < 0) continue
      out.push({ ...item, timeMs })
    }
  }
  return out.sort((a, b) => a.timeMs - b.timeMs)
}

export function getTotalCount() {
  return entries.reduce((sum, entry) => sum + entry.items.length, 0)
}

export function setOffset(key: string, offsetSec: number) {
  const entry = entries.find((e) => e.key === key)
  if (!entry) return
  const value = Number.isFinite(offsetSec) ? offsetSec : 0
  entry.offsetMs = Math.round(value * 1000)
  storageSourceOffset(entry.url, entry.offsetMs)
  notify()
}

/** 解析 URL 并加入列表；同一集不重复添加，只重新拉取 */
export async function addSource(rawUrl: string): Promise<UrlSourceEntry> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch (error) {
    throw new Error('URL 格式不对')
  }

  const source = findSource(url)
  if (!source) {
    throw new Error('暂不支持这个网站（目前支持 bilibili.com 和 ani.gamer.com.tw）')
  }

  const series = await source.resolve(url)
  if (!series.episodes.length) {
    throw new Error('没有解析到可用的分集')
  }

  const episode = series.current || series.episodes[0]
  const key = `${source.id}:${episode.id}`

  const existing = entries.find((e) => e.key === key)
  if (existing) {
    existing.url = rawUrl.trim()
    await loadEntry(existing, source)
    return existing
  }

  if (entries.length >= MAX_SOURCES) {
    throw new Error(`最多同时使用 ${MAX_SOURCES} 个 URL 来源`)
  }

  const entry: UrlSourceEntry = {
    key,
    url: rawUrl.trim(),
    sourceId: source.id,
    sourceLabel: source.label,
    seriesTitle: series.title,
    episode,
    offsetMs: storageSourceOffset(rawUrl.trim()) || 0,
    items: [],
    loading: false,
    progress: '',
  }
  entries = [...entries, entry]
  persist()
  notify()
  await loadEntry(entry, source)
  return entry
}

export function removeSource(key: string) {
  entries = entries.filter((e) => e.key !== key)
  persist()
  notify()
}

export function clearSources() {
  entries = []
  persist()
  notify()
}

/** 加载某一来源；失败只影响这条 */
async function loadEntry(entry: UrlSourceEntry, source: UrlSource) {
  const mine = (loadSeq.get(entry.key) || 0) + 1
  loadSeq.set(entry.key, mine)

  entry.loading = true
  entry.error = undefined
  entry.progress = '开始拉取…'
  entry.items = []
  notify()

  try {
    const items = await source.load(entry.episode, (msg) => {
      if (loadSeq.get(entry.key) !== mine) return
      entry.progress = msg
      notify()
    })
    if (loadSeq.get(entry.key) !== mine) return
    entry.items = items
    entry.progress = items.length ? `共 ${items.length} 条` : '这一集没有弹幕'
  } catch (error) {
    if (loadSeq.get(entry.key) !== mine) return
    entry.items = []
    entry.error = (error as Error)?.message || String(error)
    entry.progress = ''
  } finally {
    if (loadSeq.get(entry.key) === mine) {
      entry.loading = false
      notify()
    }
  }
}

function persist() {
  saveSources(
    pageKey,
    entries.map((e) => ({ url: e.url, offsetMs: e.offsetMs }))
  )
}

/** 切换页面时先设好 pageKey，再 restoreSources() */
export function setPageKey(next: string) {
  if (next === pageKey) return
  pageKey = next
  entries = []
  loadSeq.clear()
  notify()
}

export function getPageKey() {
  return pageKey
}

/** 切换到新页面/新分集时清空内存状态（持久化列表保留） */
export function resetUrlSources() {
  loadSeq.clear()
  entries = []
  notify()
}

/** 从持久化恢复**当前页面**上次使用的来源 */
export async function restoreSources() {
  const saved = loadSources(pageKey)
  if (!saved.length) return
  const mine = pageKey

  for (const item of saved.slice(0, MAX_SOURCES)) {
    try {
      const entry = await addSource(item.url)
      if (entry && item.offsetMs) {
        entry.offsetMs = item.offsetMs
        notify()
      }
    } catch (error) {
      console.warn('[danmaku-enhance] 恢复 URL 来源失败', item.url, error)
    }
    // 期间切了页面就别继续往旧列表里塞了
    if (mine !== pageKey) return
  }
}

