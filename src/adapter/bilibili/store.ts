/** B 站弹幕注入的本地配置与持久化 */
import { gm } from '../../utils/storage'

const CONFIG_KEY = 'bilibili-danmaku-config-v2'
const SOURCES_KEY = 'bilibili-danmaku-sources-v2'
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

export function storageUrlSources(list?: SavedSource[]): SavedSource[] {
  if (list) {
    gm.setItem(SOURCES_KEY, list)
    return list
  }
  const raw = gm.getItem<any>(SOURCES_KEY, [])
  return Array.isArray(raw) ? raw.filter((o) => o && typeof o.url === 'string') : []
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
