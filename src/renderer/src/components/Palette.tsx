import { useEffect, useMemo, useRef, useState } from 'react'
import { fuzzyFilter } from '@shared/fuzzy'
import type { ActionDescriptor } from '@shared/types'
import { runAction } from '../actions'
import { rpc } from '../api'
import { useApp } from '../store'

/** Что ищем: подпись плюс скрытые синонимы (латиница к русскому и наоборот). */
const searchText = (a: ActionDescriptor): string => `${a.title} ${a.keywords ?? ''} ${a.group}`

/**
 * Палитра команд ⌘K (docs/02 §4, US-11): один реестр действий на всё приложение,
 * fuzzy-поиск, параметризованные действия спрашивают аргумент вторым шагом.
 *
 * Каталог берётся при каждом открытии: подписи зависят от текущего окружения и
 * состояния прокси («включить dev» / «выключить dev»), кэшировать их нельзя.
 */
export function Palette(): React.JSX.Element | null {
  const { paletteOpen, setPaletteOpen } = useApp()
  const [items, setItems] = useState<ActionDescriptor[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  /** Выбрано действие с параметром — второй шаг: ввод аргумента. */
  const [pending, setPending] = useState<ActionDescriptor | null>(null)
  const [param, setParam] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paletteOpen) return
    setQuery('')
    setCursor(0)
    setPending(null)
    setParam('')
    void rpc('actions.list').then(setItems)
  }, [paletteOpen])

  const found = useMemo(() => fuzzyFilter(query, items, searchText), [query, items])
  const active = found[Math.min(cursor, found.length - 1)]

  // курсор всегда виден: список длиннее экрана, ходить по нему приходится вслепую
  useEffect(() => {
    listRef.current?.querySelector('.pal-row-active')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, query])

  if (!paletteOpen) return null

  const close = (): void => setPaletteOpen(false)

  const launch = async (action: ActionDescriptor, arg: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await runAction(action.id, { param: arg })
      // reveal закрывает палитру сам; действие без reveal (тумблер) — закрываем тут
      if (res.ok) close()
    } finally {
      setBusy(false)
    }
  }

  const pick = (action: ActionDescriptor): void => {
    if (action.param && param.trim() === '') {
      setPending(action)
      return
    }
    void launch(action, param)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      // из шага параметра Esc возвращает к списку, а не закрывает всё
      if (pending) setPending(null)
      else close()
      return
    }
    if (pending) {
      if (e.key === 'Enter' && param.trim() !== '') {
        e.preventDefault()
        void launch(pending, param)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, found.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && active) {
      e.preventDefault()
      pick(active)
    }
  }

  let group = ''
  return (
    <div className="pal-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        {pending ?
          <>
            <div className="pal-pending">
              {pending.dangerous && <span className="chip chip-red">PROD</span>}
              {pending.title}
            </div>
            <input
              className="pal-input"
              autoFocus
              disabled={busy}
              placeholder={pending.param?.placeholder ?? ''}
              value={param}
              onChange={(e) => setParam(e.target.value)}
            />
            <div className="pal-hint">{pending.param?.label} · Enter — выполнить, Esc — назад</div>
          </>
        : <>
            <input
              className="pal-input"
              autoFocus
              disabled={busy}
              placeholder="Действие: bash api, прокси dev, dump…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
            />
            <div className="pal-list" ref={listRef}>
              {found.length === 0 && <div className="pal-empty">Ничего не нашлось</div>}
              {found.map((a, i) => {
                const head = a.group !== group ? a.group : null
                group = a.group
                return (
                  <div key={a.id}>
                    {head && <div className="pal-group">{head}</div>}
                    <div
                      className={`pal-row ${i === cursor ? 'pal-row-active' : ''} ${
                        a.dangerous ? 'pal-row-prod' : ''
                      }`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => pick(a)}
                    >
                      <span className="pal-title">{a.title}</span>
                      {a.param && <span className="pal-param">параметр</span>}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="pal-hint">↑↓ — выбор, Enter — выполнить, Esc — закрыть</div>
          </>
        }
      </div>
    </div>
  )
}
