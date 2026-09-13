import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { makeOverlay, relockAncestors, unlockAncestors, watchZoom } from './zoom.ts'

const React = globalThis.React
const { useEffect, useRef } = React

export const name = 'page-terminal'
export const inject = ['pageEditor']

const DEFAULTS = { title: '终端', height: 240 }

// 历史记录：写进块数据里，agent 直接读页面 markdown 就能看到用户跑过什么。
const HISTORY_MAX = 200      // 最多保留的命令条数
const HISTORY_OUT_LINES = 10 // 每条命令最多保留的输出行数
const HISTORY_OUT_CHARS = 600 // 单条输出字符上限，防止撑爆 markdown
const OUTPUT_SETTLE_MS = 600 // 输出安静这么久，就认为这条命令跑完了

type HistoryEntry = { cmd: string; at: number; out?: string }

// ---------------------------------------------------------------------------
// xterm 附带的「辅助节点」处理（踩坑总结，改动前务必读 README）：
//  1. helper-textarea 是 xterm 接收键盘输入的节点，**不能 display:none**
//     —— 隐藏元素无法聚焦，会导致整个终端打不了字。
//  2. .xterm-helpers 里住着字符测量元素，**不能整块压掉**，
//     否则它量不出字符宽度 → 字间距错乱、光标消失。
//  3. 字符测量元素会因祖先 transform/backdrop-filter 改变包含块而显形，
//     表现为"顶部多出一行会自己变的乱码"。用 clip-path 裁成 0 面积：
//     仍在布局树里（能测量），但不绘制。
// ---------------------------------------------------------------------------
const HELPER_TEXTAREA = '.xterm-helper-textarea'
const MEASURE_SELECTORS = ['.xterm-char-measure-element', '.xterm-width-cache-measure-container'].join(',')
const BURIED_SELECTORS = [
  '.xterm-accessibility',
  '.xterm-accessibility-tree',
  '.xterm-message',
  '.live-region',
  '.composition-view',
].join(',')

function styleHelperTextarea(el: HTMLElement) {
  const s = el.style
  s.setProperty('position', 'absolute', 'important')
  s.setProperty('left', '-9999px', 'important')
  s.setProperty('top', '0', 'important')
  s.setProperty('width', '1px', 'important')
  s.setProperty('height', '1px', 'important')
  s.setProperty('opacity', '0', 'important')
  s.setProperty('color', 'transparent', 'important')
  s.setProperty('caret-color', 'transparent', 'important')
  s.setProperty('background', 'transparent', 'important')
  s.setProperty('border', '0', 'important')
  s.setProperty('padding', '0', 'important')
  s.setProperty('margin', '0', 'important')
  s.setProperty('overflow', 'hidden', 'important')
  s.setProperty('resize', 'none', 'important')
  s.setProperty('z-index', '-5', 'important')
  // 不要 display:none。
  s.removeProperty('display')
}

function buryAuxiliaryNodes(root: HTMLElement) {
  for (const node of root.querySelectorAll(MEASURE_SELECTORS)) {
    const s = (node as HTMLElement).style
    s.setProperty('position', 'absolute', 'important')
    s.setProperty('left', '0', 'important')
    s.setProperty('top', '0', 'important')
    s.setProperty('visibility', 'hidden', 'important')
    s.setProperty('clip-path', 'inset(100%)', 'important')
    s.setProperty('pointer-events', 'none', 'important')
    s.removeProperty('display')
  }
  for (const node of root.querySelectorAll(HELPER_TEXTAREA)) {
    styleHelperTextarea(node as HTMLElement)
  }
  for (const node of root.querySelectorAll(BURIED_SELECTORS)) {
    const el = node as HTMLElement
    if (el.style.display !== 'none') el.style.setProperty('display', 'none', 'important')
  }
}

const STYLE_ID = 'pt-xterm-style-v1'
const STYLE_CSS = `
.pt-pane .xterm { padding: 0 !important; height: 100%; }
.pt-pane .xterm-viewport { background: transparent !important; }
.pt-pane .xterm-screen { background: transparent !important; }
.pt-pane canvas { background: transparent !important; }

/* 无需滚动时把滚动条彻底藏掉 */
.pt-pane .scrollbar.invisible { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }
.pt-pane .scrollbar.invisible > .slider { opacity: 0 !important; height: 0 !important; background: transparent !important; }

/* xterm 自绘滚动条：细条 + 圆角 + 半透明 */
.pt-pane .scrollbar { width: 12px !important; min-width: 12px !important; max-width: 12px !important; }
.pt-pane .scrollbar > .slider {
  width: 8px !important; min-width: 8px !important; max-width: 8px !important;
  left: 2px !important; right: auto !important;
  border-radius: 999px !important;
  background: color-mix(in srgb, var(--dsw-label-3, rgba(242,241,237,0.45)) 55%, transparent) !important;
  border: 0 !important;
}
.pt-pane .scrollbar > .slider:hover,
.pt-pane .scrollbar > .slider.active {
  background: color-mix(in srgb, var(--dsw-label-2, rgba(242,241,237,0.72)) 70%, transparent) !important;
}
`

function useTerminalStyle() {
  useEffect(() => {
    // 每次用最新内容覆盖，不能"已存在就 return"，否则旧版本内容会一直挡着。
    const id = STYLE_ID
    for (const stale of document.querySelectorAll('style[id^="pt-xterm-style"]')) {
      if (stale.id !== id) stale.remove()
    }
    const existing = document.getElementById(id)
    const el = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
    el.id = id
    el.textContent = STYLE_CSS
    if (el.parentNode !== document.head) document.head.appendChild(el)
  }, [])
}

const THEME = {
  background: 'rgba(0,0,0,0)',
  foreground: '#f0efed',
  cursor: '#f0efed',
  cursorAccent: '#191919',
  selectionBackground: 'rgba(242,241,237,0.22)',
  black: '#191919',
  red: '#e5484d',
  green: '#30a46c',
  yellow: '#ffb224',
  blue: '#5b9fd6',
  magenta: '#b07cd6',
  cyan: '#12a594',
  white: '#bcbab6',
  brightBlack: '#5f5f5a',
  brightRed: '#ff6369',
  brightGreen: '#4cc38a',
  brightYellow: '#ffc53d',
  brightBlue: '#78b4e4',
  brightMagenta: '#c496e4',
  brightCyan: '#3ddbd9',
  brightWhite: '#f0efed',
}

/** 单个终端面：一个块 = 一个 PTY。 */
function TerminalSurface({
  height,
  history,
  onHistory,
  sessionKey,
  fill,
}: {
  height: number
  history: HistoryEntry[]
  onHistory: (next: HistoryEntry[]) => void
  /** 后端会话键：同一个块刷新/切页都能连回同一个 shell。 */
  sessionKey: string
  /** 放大时撑满容器，而不是固定高度。 */
  fill?: boolean
}) {
  useTerminalStyle()
  const host = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return

    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: true,
      scrollback: 2000,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)

    buryAuxiliaryNodes(element)
    const observer = new MutationObserver(() => buryAuxiliaryNodes(element))
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })

    const fitted = () => {
      try {
        fit.fit()
        return true
      } catch {
        return false
      }
    }
    fitted()

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket | undefined
    let raf = 0
    // 连接延后到布局稳定，避免用错误尺寸启动 shell。
    raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitted()
        socket = new WebSocket(
          `${protocol}//${location.host}/ws/page-terminal` +
            `?cols=${term.cols}&rows=${term.rows}&session=${encodeURIComponent(sessionKey)}`,
        )
        socket.addEventListener('open', () => {
          const sync = () =>
            socket?.readyState === WebSocket.OPEN &&
            socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
          sync()
          window.setTimeout(sync, 60)
          window.setTimeout(sync, 220)
        })
        // 纯直通：不做任何清屏 / 干预。同时把输出喂给历史缓冲。
        socket.addEventListener('message', (event) => {
          const chunk = typeof event.data === 'string' ? event.data : ''
          term.write(chunk)
          recordOutput(chunk)
        })
      })
    })

    // ---- 历史记录采集 ----------------------------------------------------
    // 思路：累积用户按键，遇到回车就认为一条命令输入完毕；
    // 该命令之后的 PTY 输出先缓存起来，等"输出安静"后取前几行，写回块数据。
    //
    // 之所以用 onData（用户输入）而不是解析回显：onData 给的是纯按键，
    // 不受 shell 提示符格式影响，简单可靠。
    const historyRef = [...history]
    let pendingLine = ''            // 当前正在输入的一行
    let capturing = false           // 是否正在为「上一条命令」收集输出
    let outBuffer = ''              // 缓存的输出
    let outTimer: number | undefined

    const stripAnsi = (text: string) =>
      // 去掉 ANSI 转义、回车覆盖、退格等控制符，只留可读文本
      text
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b[()][0-9A-Za-z]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

    // 判断一行是否是 shell 提示符（或提示符擦行残渣）。
    // 提示符没有统一格式，这里用几个常见特征做启发式判断。
    const isPromptLike = (line: string) => {
      const text = line.trim()
      if (!text) return false
      // 擦行残渣：整行几乎都是 % 或空格
      if (/^[%\s]+$/.test(text)) return true
      // 常见的 user@host 提示符
      if (/^\S*@\S*\s*[:~\/.]/.test(text)) return true
      // 以 (env) user@host 开头
      if (/^\([^)]*\)\s*\S*@\S*/.test(text)) return true
      // 结尾是 % / $ / # 且含有 @ 或路径
      if (/[@~\/]/.test(text) && /[%$#]\s*$/.test(text)) return true
      return false
    }

    const flushHistory = () => {
      if (outTimer) {
        window.clearTimeout(outTimer)
        outTimer = undefined
      }
      if (!capturing) return
      capturing = false
      const clean = stripAnsi(outBuffer)
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        // shell 在命令跑完后会立刻画出下一条提示符（含擦行序列残渣），
        // 那些属于"下一条"，从尾部砍掉，避免污染这条命令的输出。
        .filter((line) => !isPromptLike(line))
        .filter((line, index, all) => !(index === all.length - 1 && line === ''))
      outBuffer = ''
      if (clean.length === 0) return
      const out = clean.slice(0, HISTORY_OUT_LINES).join('\n').slice(0, HISTORY_OUT_CHARS)
      const last = historyRef[historyRef.length - 1]
      if (!last || last.out !== undefined) return
      last.out = out || undefined
      onHistory([...historyRef])
    }

    const recordOutput = (chunk: string) => {
      if (!capturing) return
      outBuffer += chunk
      // 输出一直在动就继续等，安静下来才算这条命令跑完。
      if (outTimer) window.clearTimeout(outTimer)
      outTimer = window.setTimeout(flushHistory, OUTPUT_SETTLE_MS)
    }

    const recordInput = (data: string) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const cmd = pendingLine.trim()
          pendingLine = ''
          if (!cmd) continue
          historyRef.push({ cmd, at: Date.now() })
          if (historyRef.length > HISTORY_MAX) historyRef.splice(0, historyRef.length - HISTORY_MAX)
          onHistory([...historyRef])
          capturing = true
          outBuffer = ''
          continue
        }
        if (ch === '\x7f' || ch === '\b') {
          pendingLine = pendingLine.slice(0, -1)
          continue
        }
        if (ch === '\x03' || ch === '\x04' || ch === '\x1b') {
          // Ctrl-C / Ctrl-D / ESC：放弃当前行
          pendingLine = ''
          continue
        }
        if (ch >= ' ') pendingLine += ch
      }
    }
    // ---------------------------------------------------------------------

    const dataSub = term.onData((data) => {
      recordInput(data)
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }))
    })
    // xterm 列数一变就同步给 PTY，保证 shell 的擦行宽度和显示宽度一致。
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    const resizeObs = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    resizeObs.observe(element)

    return () => {
      if (outTimer) window.clearTimeout(outTimer)
      cancelAnimationFrame(raf)
      observer.disconnect()
      resizeObs.disconnect()
      resizeSub.dispose()
      dataSub.dispose()
      try {
        socket?.close()
      } catch {
        // 可能还没连上。
      }
      term.dispose()
    }
  }, [])

  return (
    <div
      ref={host}
      className="pt-pane"
      onKeyDown={(event) => event.stopPropagation()}
      style={{
        position: 'relative',
        width: '100%',
        height: fill ? undefined : height,
        flex: fill ? 1 : undefined,
        minHeight: 0,
        padding: '8px 10px',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background: '#191919',
      }}
    />
  )
}

/** 历史面板：和终端分开的独立组件，只负责把块数据里的 history 画出来。
   不往 xterm 里塞内容，避免干扰真实 shell 的输出。 */
/** 把毫秒差格式化成「刚刚 / 3 分钟 / 2 小时 / 1 天」。 */
function formatSpan(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时`
  return `${Math.floor(hour / 24)} 天`
}

function HistoryPanel({
  history,
  writable,
  onClear,
}: {
  history: HistoryEntry[]
  writable: boolean
  onClear: () => void
}) {
  const React2 = React
  // 默认折叠：历史是参考信息，不该一上来占满屏幕。
  const [open, setOpen] = React2.useState(false)
  if (history.length === 0) return null

  const mono = '"SF Mono", Menlo, Monaco, Consolas, monospace'

  // 统计：总条数 + 最常用的几条命令（去掉参数，按命令名归并）。
  const counts = new Map<string, number>()
  for (const entry of history) {
    const head = entry.cmd.trim().split(/\s+/)[0] || entry.cmd.trim()
    counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4)
  const span = history.length > 1 && history[0].at && history[history.length - 1].at
    ? formatSpan(history[history.length - 1].at - history[0].at)
    : ''

  return (
    <div
      style={{
        borderBottom: '1px solid var(--dsw-border, rgba(242,241,237,0.1))',
        background: 'color-mix(in srgb, var(--dsw-bg, #191919) 70%, transparent)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 26,
          padding: '0 10px',
          color: 'var(--dsw-label-3, rgba(242,241,237,0.45))',
          font: '11px ui-sans-serif, system-ui, sans-serif',
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            minWidth: 0,
            border: 0,
            padding: 0,
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              transform: open ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms ease',
              fontSize: 9,
            }}
          >
            ▶
          </span>
          历史记录
          <span style={{ opacity: 0.7 }}>{history.length} 条</span>
          {top.length > 0 ? (
            <span style={{ opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              · {top.map(([name, n]) => `${name}×${n}`).join(' · ')}
            </span>
          ) : null}
          {span ? <span style={{ opacity: 0.45 }}>· {span}</span> : null}
        </button>
        <span style={{ flex: 1 }} />
        {writable ? (
          <button
            type="button"
            onClick={onClear}
            style={{
              border: 0,
              padding: 0,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            清空
          </button>
        ) : null}
      </div>
      {open ? (
        <div
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            padding: '4px 10px 10px',
            fontFamily: mono,
            fontSize: 12,
            lineHeight: 1.45,
            color: 'var(--dsw-label-2, rgba(242,241,237,0.72))',
          }}
        >
          {history.map((entry, index) => (
            <div key={`${entry.at}-${index}`} style={{ marginTop: index === 0 ? 0 : 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ color: '#4cc38a', flex: '0 0 auto' }}>$</span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{entry.cmd}</span>
              </div>
              {entry.out ? (
                <pre
                  style={{
                    margin: '2px 0 0',
                    paddingLeft: 14,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    color: 'var(--dsw-label-3, rgba(242,241,237,0.45))',
                    font: 'inherit',
                  }}
                >
                  {entry.out}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 标题栏图标按钮。 */
function IconButton({
  label,
  active,
  dataZoomExit,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  dataZoomExit?: boolean
  onClick: () => void
  children: unknown
}) {
  return (
    <button
      type="button"
      data-zoom-exit={dataZoomExit ? '' : undefined}
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        border: 0,
        padding: 0,
        borderRadius: 5,
        background: active ? 'color-mix(in srgb, var(--dsw-label, #f0efed) 12%, transparent)' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      {children as never}
    </button>
  )
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.455 1.45A.5.5 0 0 1 6.952 1h2.096a.5.5 0 0 1 .497.45l.186 1.858a4.996 4.996 0 0 1 1.466.848l1.703-.769a.5.5 0 0 1 .639.206l1.047 1.814a.5.5 0 0 1-.14.656l-1.517 1.09a5.026 5.026 0 0 1 0 1.694l1.516 1.09a.5.5 0 0 1 .141.656l-1.047 1.814a.5.5 0 0 1-.639.206l-1.703-.768c-.433.36-.928.649-1.466.847l-.186 1.858a.5.5 0 0 1-.497.45H6.952a.5.5 0 0 1-.497-.45l-.186-1.858a4.993 4.993 0 0 1-1.466-.848l-1.703.769a.5.5 0 0 1-.639-.206l-1.047-1.814a.5.5 0 0 1 .14-.656l1.517-1.09a5.033 5.026 0 0 1 0-1.694l-1.516-1.09a.5.5 0 0 1-.141-.656L2.46 3.593a.5.5 0 0 1 .639-.206l1.703.769c.433-.36.928-.65 1.466-.848l.186-1.858Zm-.177 7.567-.022-.037a2 2 0 0 1 3.466-1.997l.022.037a2 2 0 0 1-3.466 1.997Z"
      />
    </svg>
  )
}

function ExpandIcon({ shrink }: { shrink?: boolean }) {
  return shrink ? (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.2 9.8 2.5 13.5M9.8 6.2l3.7-3.7M2.5 13.5h3.2M2.5 13.5v-3.2M13.5 2.5h-3.2M13.5 2.5v3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 6.5 13.5 2.5M13.5 2.5h-3.2M13.5 2.5v3.2M6.5 9.5 2.5 13.5M2.5 13.5h3.2M2.5 13.5v-3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** 放大放映：不搬 DOM、不重建子树，只把当前块用 fixed 提升到全屏。
   xterm 是命令式操作真实 DOM 的，搬动或重建都会丢节点，所以只改样式。
   同时临时解开沿途祖先的 overflow/position（否则会被编辑器容器裁掉）。 */
/** 放大：把块的真实 DOM 节点搬到 document.body 顶层，并铺满视口。
   为什么必须搬到 body：
     宿主把界面切成多层容器，各层常带 position:relative / z-index，
     会形成各自的层叠上下文（例如检查器的 .app-side-bar-head 是 relative+z-index:3）。
     节点留在原容器里时，z-index 再大也只在那个上下文内生效，
     压不住其它分支里的 UI（顶部 tab 栏就压不住）。
     挂到 body 顶层才能真正浮在一切之上。
   为什么不重建 React 子树 / 用 Portal：xterm 命令式持有真实 DOM，
   重建会让它画在脱离文档的节点上（实测黑屏）。
   还原靠原位置留下的注释锚点。 */
function useZoom() {
  const [zoomed, setZoomed] = React.useState(false)
  const slotRef = React.useRef<HTMLElement | null>(null)
  const markRef = React.useRef<Comment | null>(null)
  const nativeOffRef = React.useRef<(() => void) | null>(null)

  const stopRef = React.useRef<() => void>(() => {})

  const stop = React.useCallback(() => {
    const slot = slotRef.current
    const mark = markRef.current
    if (slot && mark && mark.parentNode) {
      mark.parentNode.insertBefore(slot, mark)
      mark.remove()
    }
    markRef.current = null
    nativeOffRef.current?.()
    nativeOffRef.current = null
    relockAncestors()
    setZoomed(false)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }, [])
  stopRef.current = stop

  const start = React.useCallback(() => {
    const slot = slotRef.current
    if (!slot || markRef.current) return
    // 原位留注释锚点，退出时据此还原。
    const mark = document.createComment('page-terminal-zoom-anchor')
    slot.parentNode?.insertBefore(mark, slot)
    markRef.current = mark
    unlockAncestors(mark)
    document.body.appendChild(slot)
    setZoomed(true)
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    // 节点被搬走后，React 的合成事件委托链会断，onClick 不再触发。
    // 补一个原生监听，保证放大后还能点按钮退出。
    window.setTimeout(() => {
      const btn = slot.querySelector('[data-zoom-exit]') as HTMLElement | null
      if (!btn) return
      const handler = (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        stopRef.current()
      }
      btn.addEventListener('click', handler, true)
      nativeOffRef.current = () => btn.removeEventListener('click', handler, true)
    }, 0)
  }, [])

  // Esc 退出。用原生 keydown，捕获阶段优先。
  React.useEffect(() => {
    if (!zoomed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoomed, stop])

  // 卸载兜底还原。
  React.useEffect(() => () => relockAncestors(), [])

  return { zoomed, start, stop, slotRef }
}

/** 终端设置：小悬浮窗，贴标题栏齿轮，点窗外关闭。 */
function SettingsPanel({ onClose }: { onClose: () => void }) {
  const React2 = React
  const box = React2.useRef<HTMLDivElement | null>(null)
  const [state, setState] = React2.useState<{
    loading: boolean
    error?: string
    settings?: Record<string, number>
    limits?: Record<string, { min: number; max: number }>
    sessions?: number
  }>({ loading: true })

  React2.useEffect(() => {
    let cancelled = false
    fetch('/api/page-terminal/settings')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setState({ loading: false, settings: data.settings, limits: data.limits, sessions: data.sessions })
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, error: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  React2.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const patch = (key: string, value: number) => {
    setState((cur) => ({ ...cur, settings: { ...(cur.settings ?? {}), [key]: value } }))
    fetch('/api/page-terminal/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    })
      .then((res) => res.json())
      .then((data) => setState((cur) => ({ ...cur, settings: data.settings, sessions: data.sessions })))
      .catch(() => {
        // 忽略：下次打开会重读。
      })
  }

  const row = (key: string, label: string, hint: string) => {
    const value = state.settings?.[key]
    const limit = state.limits?.[key]
    return (
      <label
        key={key}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto',
          gap: '2px 10px',
          padding: '8px 0',
          borderTop: '1px solid var(--dsw-border, rgba(242,241,237,0.1))',
        }}
      >
        <span style={{ color: 'var(--dsw-label, #f0efed)', fontWeight: 600 }}>{label}</span>
        <input
          type="number"
          value={value ?? ''}
          min={limit?.min}
          max={limit?.max}
          disabled={state.loading}
          onChange={(event) => patch(key, Number(event.target.value))}
          style={{
            width: 64,
            height: 26,
            border: 0,
            borderRadius: 7,
            padding: '0 8px',
            background: 'var(--dsw-hover, rgba(242,241,237,0.08))',
            color: 'var(--dsw-label, #f0efed)',
            font: 'inherit',
            textAlign: 'right',
            outline: 'none',
          }}
        />
        <span style={{ gridColumn: '1 / -1', color: 'var(--dsw-label-3, rgba(242,241,237,0.45))', fontSize: 11, lineHeight: 1.4 }}>
          {hint}
          {limit ? ` · ${limit.min}–${limit.max}` : ''}
        </span>
      </label>
    )
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label="终端设置"
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        zIndex: 40,
        width: 268,
        padding: '10px 12px 8px',
        border: '1px solid var(--dsw-border, rgba(242,241,237,0.12))',
        borderRadius: 10,
        background: 'color-mix(in srgb, var(--dsw-sidebar, #222220) 92%, #111)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.42)',
        color: 'var(--dsw-label-2, rgba(242,241,237,0.72))',
        font: '12px ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0 8px' }}>
        <span style={{ color: 'var(--dsw-label, #f0efed)', fontWeight: 600, fontSize: 13 }}>设置</span>
        {typeof state.sessions === 'number' ? (
          <span style={{ color: 'var(--dsw-label-3, rgba(242,241,237,0.45))' }}>{state.sessions} 个后台会话</span>
        ) : null}
      </div>
      {state.error ? (
        <div style={{ padding: '6px 0', color: '#ff6369' }}>读取失败：{state.error}</div>
      ) : (
        <>
          {row('maxSessions', '后台保留', '关掉页面后仍留着的会话，超出按最久未用淘汰')}
          {row('bufferKB', '回放缓冲 KB', '每个会话缓存的输出，重连时回放')}
          {row('replayLines', '回放行数', '重连时最多回放多少行')}
        </>
      )}
    </div>
  )
}

function PageTerminal({
  data,
  update,
  writable,
}: {
  data: Record<string, unknown>
  update: (patch: Record<string, unknown>) => void
  writable: boolean
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const settingsWrap = React.useRef<HTMLDivElement | null>(null)
  const zoom = useZoom()
  const sessionKey = typeof data.sid === 'string' && data.sid ? data.sid : ''
  useEffect(() => {
    if (sessionKey || !writable) return
    const sid = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    update({ sid })
  }, [sessionKey, writable, update])

  React.useEffect(() => {
    if (!settingsOpen) return
    const onDown = (event: MouseEvent) => {
      const node = settingsWrap.current
      if (!node) return
      if (event.target instanceof Node && node.contains(event.target)) return
      setSettingsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [settingsOpen])

  const height = typeof data.height === 'number' && data.height > 0 ? Math.min(900, data.height) : DEFAULTS.height

  // 历史存在块数据里，agent 读页面 markdown 即可看到用户跑过什么。
  const history: HistoryEntry[] = Array.isArray(data.history)
    ? (data.history as unknown[])
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          cmd: String(item.cmd ?? ''),
          at: Number(item.at) || 0,
          ...(typeof item.out === 'string' && item.out ? { out: item.out } : {}),
        }))
        .filter((item) => item.cmd)
    : []

  const body = (
    <section
      ref={(el: HTMLElement | null) => {
        zoom.slotRef.current = el
      }}
      data-testid="page-terminal"
      style={{
        display: 'flex',
        flexDirection: 'column',
        ...(zoom.zoomed
          ? {
              position: 'fixed',
              inset: 0,
              width: '100%',
              height: '100%',
              zIndex: 2147483647,
            }
          : {}),
        border: zoom.zoomed ? 'none' : '1px solid var(--dsw-border, rgba(242,241,237,0.1))',
        borderRadius: zoom.zoomed ? 0 : 8,
        overflow: 'hidden',
        background: '#191919',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 30,
          padding: '0 8px 0 10px',
          borderBottom: '1px solid var(--dsw-border, rgba(242,241,237,0.1))',
          background: 'color-mix(in srgb, var(--dsw-label, #f0efed) 4%, transparent)',
          color: 'var(--dsw-label-3, rgba(242,241,237,0.45))',
          font: '11px ui-sans-serif, system-ui, sans-serif',
          userSelect: 'none',
        }}
      >
        <span style={{ flex: '0 0 auto', color: 'var(--dsw-label-2, rgba(242,241,237,0.72))' }}>终端</span>
        <span style={{ flex: 1 }} />
        <div ref={settingsWrap} style={{ position: 'relative', flex: '0 0 auto' }}>
          <IconButton label="设置" active={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
            <GearIcon />
          </IconButton>
          {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
        </div>
        <IconButton
          label={zoom.zoomed ? '退出全屏' : '全屏放大'}
          active={zoom.zoomed}
          dataZoomExit
          onClick={() => (zoom.zoomed ? zoom.stop() : zoom.start())}
        >
          <ExpandIcon shrink={zoom.zoomed} />
        </IconButton>
      </header>
      <HistoryPanel
        history={history}
        writable={writable}
        onClear={() => update({ history: [] })}
      />
      {sessionKey ? (
        <TerminalSurface
          height={height}
          history={history}
          onHistory={(next) => update({ history: next })}
          sessionKey={sessionKey}
          fill={zoom.zoomed}
        />
      ) : null}
    </section>
  )

  return body
}

export function apply(ctx: {
  pageEditor: {
    registerBlock: (spec: {
      kind: string
      plugin: string
      label: string
      blockType?: string
      blockTypeLabel?: string
      hint?: string
      aliases?: string[]
      defaults?: Record<string, unknown>
      View: (props: {
        data: Record<string, unknown>
        update: (patch: Record<string, unknown>) => void
        writable: boolean
      }) => unknown
    }) => void
  }
}) {
  ctx.pageEditor.registerBlock({
    kind: 'terminal',
    plugin: name,
    label: '终端',
    blockType: 'terminal',
    blockTypeLabel: '终端',
    hint: '可交互的真实终端，每块一个独立 shell',
    aliases: ['terminal', 'term', 'shell', '终端', '命令行'],
    defaults: DEFAULTS,
    View: PageTerminal,
  })
}
