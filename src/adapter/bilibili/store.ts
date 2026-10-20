/** B 站弹幕注入的本地配置与持久化 */
import { gm } from '../../utils/storage'

const CONFIG_KEY = 'bilibili-danmaku-config-v2'
/** v3 起 URL 来源按「页面」分开存，避免在别的视频上加的来源跑过来 */
const SOURCES_KEY = 'bilibili-danmaku-sources-v3'
const OFFSET_KEY = 'bilibili-danmaku-offset-v2'

export interface BiliConfig {
  /** 总开关：开启后才注入弹幕 */
  enabled: boolean
  /** 与 B 站原生弹幕去重 */
  dedupe: boolean
}

const DEFAULT_CONFIG: BiliConfig = {
  enabled: false,
  dedupe: true,
}

export function loadConfig(): BiliConfig {
  const raw = gm.getItem<any>(CONFIG_KEY, {})
  return { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) }
}

export function saveConfig(config: BiliConfig) {
  gm.setItem(CONFIG_KEY, config)
}

export interface SavedSource {
  url: string
  offsetMs: number
}

type SourceMap = Record<string, SavedSource[]>

function readSourceMap(): SourceMap {
  const raw = gm.getItem<any>(SOURCES_KEY, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const map: SourceMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    map[key] = value.filter(
      (o: any) => o && typeof o.url === 'string'
    ) as SavedSource[]
  }
  return map
}

/** 读某个页面自己的 URL 来源列表 */
export function loadSources(pageKey: string): SavedSource[] {
  if (!pageKey) return []
  return readSourceMap()[pageKey] || []
}

/** 覆盖某个页面的 URL 来源列表 */
export function saveSources(pageKey: string, list: SavedSource[]) {
  if (!pageKey) return
  const map = readSourceMap()
  if (list.length) map[pageKey] = list
  else delete map[pageKey]
  gm.setItem(SOURCES_KEY, map)
}

/** 读/写某条来源的时间偏移（毫秒） */
export function storageSourceOffset(url: string, offsetMs?: number): number {
  const map = gm.getItem<any>(OFFSET_KEY, {}) || {}
  if (offsetMs !== undefined) {
    map[url] = offsetMs
    gm.setItem(OFFSET_KEY, map)
    return offsetMs
  }
  const value = Number(map[url])
  return Number.isFinite(value) ? value : 0
}
