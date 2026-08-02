import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Высота строки — фиксированная: на ней держится виртуализация (FR-Q1). */
const ROW_H = 22
/** Запас строк за краями окна, чтобы при скролле не мелькали пустоты. */
const OVERSCAN = 8

/**
 * Таблица результата запроса с виртуализацией: в DOM живут только видимые
 * строки, поэтому тысяча строк по два десятка колонок не роняет рендер.
 * NULL показывается отдельно от пустой строки — в SQL это разные вещи.
 */
export function ResultTable({
  columns,
  rows
}: {
  columns: string[]
  rows: (string | null)[][]
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(320)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const sync = (): void => setHeight(el.clientHeight)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // новый результат — назад к первой строке (иначе смотрели бы в пустоту)
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 })
    setScrollTop(0)
  }, [columns, rows])

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const visible = Math.ceil(height / ROW_H) + OVERSCAN * 2
  const slice = rows.slice(first, first + visible)
  const template = `repeat(${columns.length}, minmax(90px, max-content))`

  return (
    <div className="sql-table" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div className="sql-table-inner">
        <div className="sql-row sql-thead" style={{ gridTemplateColumns: template }}>
          {columns.map((c, i) => (
            <span key={`${c}-${i}`} className="sql-cell">
              {c}
            </span>
          ))}
        </div>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {slice.map((row, i) => (
            <div
              key={first + i}
              className="sql-row"
              style={{
                gridTemplateColumns: template,
                position: 'absolute',
                top: (first + i) * ROW_H,
                height: ROW_H
              }}
            >
              {row.map((value, c) => (
                <span key={c} className="sql-cell" title={value ?? 'NULL'}>
                  {value === null ?
                    <i className="sql-null">NULL</i>
                  : value}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
