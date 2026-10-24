/**
 * 浮层的挂载点。
 *
 * B 站进全屏用的是元素全屏（Fullscreen API）：全屏元素一旦成为「顶层」，
 * 只有它的后代会被绘制出来——挂在 `document.body` 上的面板、提示、兜底按钮
 * 在全屏下会整个消失（用户报的「全屏后看不到面板」就是这个）。
 *
 * 所以浮层不能固定挂 body，要跟着 `document.fullscreenElement` 走，
 * 并在进出全屏时搬一次家。
 */

/** 当前应该挂浮层的宿主：全屏元素优先，否则 body */
export function overlayHost(): HTMLElement {
  const fullscreen = document.fullscreenElement
  return fullscreen instanceof HTMLElement ? fullscreen : document.body
}

/** 把节点挪到当前宿主里；已经在里面就不动（避免每帧无谓的 DOM 操作） */
export function mountOverlay(node: HTMLElement) {
  const host = overlayHost()
  if (node.parentElement !== host) host.append(node)
}

/**
 * 监听全屏切换。捕获阶段是为了拿到播放器内部元素全屏的事件
 * （事件目标可能不是 document，但 fullscreenchange 会冒泡到 document）。
 */
export function onFullscreenChange(handler: () => void): () => void {
  const events = ['fullscreenchange', 'webkitfullscreenchange']
  for (const name of events) document.addEventListener(name, handler, true)
  return () => {
    for (const name of events) document.removeEventListener(name, handler, true)
  }
}
