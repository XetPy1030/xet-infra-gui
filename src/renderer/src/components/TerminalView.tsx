import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import type { EventMap } from '@shared/types'
import { replaySlice } from '@shared/stream'
import { onEvent, rpc } from '../api'

const THEME = {
  background: '#12161c',
  foreground: '#d8dee9',
  cursor: '#7aa2f7',
  selectionBackground: '#2c3a52'
}

/**
 * xterm, привязанный к сессии: snapshot (ring buffer) → live-поток → ввод.
 * WebGL с фолбэком на DOM (ADR-0002). Для follow-логов сверху — панель
 * «пауза + поиск» (FR-K6): пауза останавливает PTY в main, поиск — по буферу xterm.
 */
export function TerminalView({
  sessionId,
  logTools = false,
  paused = false
}: {
  sessionId: string
  logTools?: boolean
  paused?: boolean
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, monospace',
      theme: THEME,
      scrollback: 8000,
      cursorBlink: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    const search = new SearchAddon()
    term.loadAddon(search)
    searchRef.current = search
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // потеря/отсутствие WebGL — остаёмся на DOM-рендерере
    }
    fit.fit()

    // Сначала подписка (копим в очередь) — без дыры до снапшота; watermark режет
    // пересечение снапшота и живых чанков, чтобы ничего не задвоилось (shared/stream).
    // Ack после реального xterm.write — backpressure (docs/03 §6): main приостановит
    // PTY, если renderer не поспевает. Offset абсолютный — дубли ack безвредны.
    let replayDone = false
    let written = 0
    const ackTo = (upTo: number): void => {
      void rpc('session.ack', { id: sessionId, upTo })
    }
    const queue: EventMap['session/data'][] = []
    const apply = (chunk: EventMap['session/data']): void => {
      const r = replaySlice(written, chunk)
      if (!r) {
        ackTo(chunk.end) // целиком уже показан снапшотом
        return
      }
      written = r.written
      term.write(r.text, () => ackTo(chunk.end))
    }
    const offData = onEvent('session/data', (p) => {
      if (p.id !== sessionId) return
      if (replayDone) apply(p)
      else queue.push(p)
    })
    void rpc('session.snapshot', { id: sessionId }).then((snap) => {
      if (snap) {
        if (snap.buffer) term.write(snap.buffer)
        written = snap.cursor
        ackTo(snap.cursor)
      }
      for (const chunk of queue) apply(chunk)
      queue.length = 0
      replayDone = true
    })

    const input = term.onData((data) => {
      void rpc('session.write', { id: sessionId, data })
    })

    // Скрытая/схлопнутая панель даёт нулевую высоту, а fit.fit() — 1×1: это не
    // размер терминала, PTY на одну строку переформатировал бы вывод. Такой размер
    // не отправляем (main отбивает его схемой), ждём осмысленной геометрии.
    // Заодно не шлём неизменившийся размер: ResizeObserver срабатывает и на пиксели.
    let sent = ''
    const syncSize = (): void => {
      fit.fit()
      const { cols, rows } = term
      if (cols < 2 || rows < 2 || `${cols}x${rows}` === sent) return
      sent = `${cols}x${rows}`
      void rpc('session.resize', { id: sessionId, cols, rows })
    }
    const ro = new ResizeObserver(syncSize)
    ro.observe(host)
    syncSize()
    term.focus()

    return () => {
      ro.disconnect()
      offData()
      input.dispose()
      searchRef.current = null
      term.dispose()
    }
  }, [sessionId])

  return (
    <div className="terminal-wrap">
      {logTools && (
        <div className="logtools">
          <button
            className={paused ? 'primary' : ''}
            title="Пауза потока: PTY останавливается, вывод копится и придёт после снятия"
            onClick={() => void rpc('session.setPaused', { id: sessionId, paused: !paused })}
          >
            {paused ? '▶︎ Продолжить' : '⏸ Пауза'}
          </button>
          <input
            className="logtools-search"
            placeholder="поиск по выводу"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || query.length === 0) return
              if (e.shiftKey) searchRef.current?.findPrevious(query)
              else searchRef.current?.findNext(query)
            }}
          />
          <button
            disabled={query.length === 0}
            onClick={() => searchRef.current?.findPrevious(query)}
          >
            ↑
          </button>
          <button disabled={query.length === 0} onClick={() => searchRef.current?.findNext(query)}>
            ↓
          </button>
          {paused && <span className="chip chip-yellow">поток на паузе</span>}
        </div>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  )
}
