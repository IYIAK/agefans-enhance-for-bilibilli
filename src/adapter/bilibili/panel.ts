import { sleep } from '../../utils/sleep'
import { gm } from '../../utils/storage'
import { getStats, setCid, setComments, setDedupe, setEnabled, setLoading } from './hook'
import type { BiliPageInfo } from './info'
import {
  MatchError,
  commentsOf,
  episodeList,
  rememberMatch,
  resolveComments,
} from './match'
import type { AnimeItem, EpisodeItem } from './match'

export interface BiliConfig {
  enabled: boolean
  dedupe: boolean
}

export interface BiliPanel {
  dispose(): void
  load(): void
}

const CONFIG_KEY = 'bilibili-danmaku-config'

const ANCHOR_SELECTORS = [
  '#bilibili-player',
  '.bpx-player-container',
  '#playerWrap',
  '#player',
]

export function loadConfig(): BiliConfig {
  return gm.getItem<BiliConfig>(CONFIG_KEY, { enabled: false, dedupe: true })
}

export function saveConfig(config: Partial<BiliConfig>) {
  gm.setItem(CONFIG_KEY, { ...loadConfig(), ...config })
}

async function findAnchor(): Promise<JQuery | undefined> {
  const deadline = Date.now() + 15000

  while (Date.now() < deadline) {
    for (const selector of ANCHOR_SELECTORS) {
      const el = document.querySelector(selector)
      if (el) return $(el as HTMLElement)
    }
    await sleep(300)
  }

  return undefined
}

function createPanelDom(config: BiliConfig) {
  return $(`
<div class="k-bili-danmaku">
  <div class="k-bili-danmaku__head">
    <span class="k-bili-danmaku__title">第三方弹幕</span>
    <label class="k-bili-danmaku__switch" title="开启后把弹弹play 的弹幕混入 B 站原生弹幕">
      <input type="checkbox" class="k-bili-danmaku__enable" ${config.enabled ? 'checked' : ''}>
      <span class="k-bili-danmaku__slider"></span>
    </label>
  </div>
  <div class="k-bili-danmaku__body">
    <div class="k-bili-danmaku__status"></div>
    <div class="k-bili-danmaku__field">
      <span class="k-bili-danmaku__label">番剧</span>
      <select class="k-bili-danmaku__anime" disabled></select>
    </div>
    <div class="k-bili-danmaku__field">
      <span class="k-bili-danmaku__label">集数</span>
      <select class="k-bili-danmaku__episode" disabled></select>
    </div>
    <div class="k-bili-danmaku__actions">
      <button type="button" class="k-bili-danmaku__retry">重新匹配</button>
      <button type="button" class="k-bili-danmaku__reload">刷新页面</button>
    </div>
    <label class="k-bili-danmaku__dedupe">
      <input type="checkbox" class="k-bili-danmaku__dedupe-input" ${config.dedupe ? 'checked' : ''}>
      与 B 站弹幕去重
    </label>
    <div class="k-bili-danmaku__stats"></div>
    <div class="k-bili-danmaku__tip">
      开关只对之后加载的弹幕分段生效；切换分P/集数或刷新页面后完整生效。
    </div>
  </div>
</div>`)
}

export function mountPanel(info: BiliPageInfo): BiliPanel {
  const config = loadConfig()
  setEnabled(config.enabled)
  setDedupe(config.dedupe)
  setCid(info.cid)

  let disposed = false
  let $panel: JQuery | undefined
  let pendingStatus = ''
  let animes: AnimeItem[] = []
  let episodes: EpisodeItem[] = []
  let animeId: string | undefined
  let episodeId: number | undefined
  let loadToken = 0
  let statsTimer: number | undefined

  function setStatus(text: string) {
    pendingStatus = text
    $panel?.find('.k-bili-danmaku__status').text(text)
  }

  function currentAnime(): AnimeItem | undefined {
    return animes.find((o) => String(o.id) === String(animeId))
  }

  function currentEpisode(): EpisodeItem | undefined {
    return episodes.find((o) => o.id === episodeId)
  }

  function renderSelects() {
    if (!$panel) return

    const $anime = $panel.find('.k-bili-danmaku__anime')
    $anime.empty()
    if (animes.length) {
      animes.forEach((anime) => {
        $anime.append($('<option>').val(anime.id).text(anime.name))
      })
      $anime.val(String(animeId ?? animes[0].id)).prop('disabled', false)
    } else {
      $anime.append($('<option>').val('').text('（未匹配到番剧）'))
      $anime.prop('disabled', true)
    }

    const $episode = $panel.find('.k-bili-danmaku__episode')
    $episode.empty()
    if (episodes.length) {
      episodes.forEach((episode) => {
        $episode.append($('<option>').val(String(episode.id)).text(episode.name))
      })
      $episode
        .val(String(episodeId ?? episodes[0].id))
        .prop('disabled', false)
    } else {
      $episode.append($('<option>').val('').text('（无集数）'))
      $episode.prop('disabled', true)
    }
  }

  function renderStats() {
    if (!$panel) return
    const stats = getStats()
    $panel
      .find('.k-bili-danmaku__stats')
      .text(
        stats.injected
          ? `本次页面已混入 ${stats.injected} 条（${stats.segments} 个分段）`
          : ''
      )
  }

  async function load() {
    if (!config.enabled) {
      setStatus('未开启')
      return
    }

    const token = ++loadToken
    setStatus('正在匹配弹弹play 弹幕…')

    const task = (async () => {
      try {
        const result = await resolveComments(info, { animeId, episodeId })
        animes = result.animes
        episodes = result.episodes
        animeId = result.animeId
        episodeId = result.episodeId
        setCid(info.cid)
        setComments(result.comments)
        renderSelects()
        setStatus(
          `已注入「${result.animeName}」${result.episodeName}，共 ${result.comments.length} 条弹幕`
        )
      } catch (error) {
        setComments(null)
        if (error instanceof MatchError) {
          animes = error.animes
          episodes = error.episodes || []
          animeId = error.animeId ?? animeId
          episodeId = undefined
          renderSelects()
          setStatus(error.message)
        } else {
          setStatus(`匹配失败：${(error as Error)?.message || error}`)
        }
      }
    })()

    setLoading(
      task.then(
        () => undefined,
        () => undefined
      )
    )
    await task
    if (token === loadToken) setLoading(null)
  }

  async function fetchCommentsForEpisode(id: number) {
    setStatus('正在获取弹幕…')
    const task = commentsOf(id).then(
      (comments) => {
        setComments(comments)
        const anime = currentAnime()
        const episode = currentEpisode()
        if (anime && episode) rememberMatch(info, anime, episode)
        setStatus(
          `已注入「${anime?.name ?? ''}」${episode?.name ?? ''}，共 ${
            comments.length
          } 条弹幕`
        )
      },
      (error) => {
        setComments(null)
        setStatus(`获取弹幕失败：${(error as Error)?.message || error}`)
      }
    )
    setLoading(task.then(() => undefined, () => undefined))
    await task
    setLoading(null)
  }

  function bindEvents($panelDom: JQuery) {
    $panelDom.on('click', '.k-bili-danmaku__head', (e) => {
      if ($(e.target).closest('.k-bili-danmaku__switch').length) return
      $panelDom.toggleClass('is-collapsed')
    })

    $panelDom.on('change', '.k-bili-danmaku__enable', (e) => {
      config.enabled = (e.target as HTMLInputElement).checked
      saveConfig({ enabled: config.enabled })
      setEnabled(config.enabled)

      if (config.enabled) {
        void load()
      } else {
        setComments(null)
        setStatus('已关闭（已加载分段里的弹幕会保留到本集结束）')
      }
    })

    $panelDom.on('change', '.k-bili-danmaku__dedupe-input', (e) => {
      config.dedupe = (e.target as HTMLInputElement).checked
      saveConfig({ dedupe: config.dedupe })
      setDedupe(config.dedupe)
    })

    $panelDom.on('click', '.k-bili-danmaku__retry', () => {
      void load()
    })

    $panelDom.on('click', '.k-bili-danmaku__reload', () => {
      location.reload()
    })

    $panelDom.on('change', '.k-bili-danmaku__anime', async (e) => {
      animeId = String($(e.target).val() || '')
      episodeId = undefined
      const anime = currentAnime()
      setStatus(`正在读取「${anime?.name || ''}」的集数…`)

      try {
        episodes = await episodeList(animeId)
        renderSelects()
        setStatus(`共 ${episodes.length} 集，请选择集数`)
      } catch (error) {
        episodes = []
        renderSelects()
        setStatus(`读取集数失败：${(error as Error)?.message || error}`)
      }
    })

    $panelDom.on('change', '.k-bili-danmaku__episode', (e) => {
      const id = Number($(e.target).val())
      if (!id) return
      episodeId = id
      void fetchCommentsForEpisode(id)
    })
  }

  async function mountDom() {
    const anchor = await findAnchor()
    if (disposed) return

    $panel = createPanelDom(config)
    if (anchor && anchor.length) {
      anchor.append($panel)
      if (getComputedStyle(anchor[0]).position === 'static') {
        anchor.css('position', 'relative')
      }
    } else {
      $panel.addClass('is-fixed')
      $(document.body).append($panel)
    }

    bindEvents($panel)
    renderSelects()
    setStatus(pendingStatus || (config.enabled ? '已开启' : '未开启'))
    renderStats()

    statsTimer = window.setInterval(renderStats, 1000)
  }

  void mountDom()

  // 立即开始匹配，让播发器最早的分段请求也能等到弹幕
  if (config.enabled) void load()

  return {
    dispose() {
      disposed = true
      if (statsTimer) window.clearInterval(statsTimer)
      setLoading(null)
      $panel?.remove()
      $panel = undefined
    },
    load() {
      void load()
    },
  }
}
