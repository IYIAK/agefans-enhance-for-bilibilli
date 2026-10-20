import './index.scss'
import { runtime } from '../../runtime'
import { installHook, resetPageState, setCid, setDedupe, setEnabled } from './hook'
import { isLivePage, readPageInfo } from './info'
import { mountPanel } from './panel'
import { loadConfig } from './store'

/** 视频、番剧、影视、播放列表、合集等有播放器的页面 */
const PATH_TEST =
  /^\/(video|bangumi\/play|cheese\/play|list|festival|medialist)\b/

runtime.register({
  domains: ['bilibili.com'],
  spa: true,
  opts: [
    {
      test: PATH_TEST,
      setup: installHook,
      run() {
        if (isLivePage()) return

        const info = readPageInfo()
        if (info.live) return

        const config = loadConfig()
        resetPageState()
        setEnabled(config.enabled)
        setDedupe(config.dedupe)
        setCid(info.cid)

        const panel = mountPanel(info)
        return () => panel.dispose()
      },
    },
  ],
})
