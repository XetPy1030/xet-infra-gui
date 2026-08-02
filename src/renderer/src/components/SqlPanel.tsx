import { useCallback, useEffect, useState } from 'react'
import { formatBytes } from '@shared/bytes'
import type { DumpTaskView, SqlExecResult, SqlHistoryEntry, SqlTarget } from '@shared/types'
import { rpc } from '../api'
import { startProxy } from '../proxy'
import { useApp } from '../store'
import { ResultTable } from './ResultTable'

type Ok = Extract<SqlExecResult, { ok: true }>

/**
 * Подсказка «добавь LIMIT» по мере набора: намеренно наивная и живёт в UI, а не
 * в ядре — она ни на что не влияет. Настоящая защита от огромного ответа —
 * `maxRows` в SqlService (флаг `truncated` в результате).
 */
const looksUnbounded = (q: string): boolean => {
  const text = q.toLowerCase()
  return /\bselect\b/.test(text) && !/\blimit\b/.test(text) && !/\bfetch\s+(first|next)\b/.test(text)
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`)

/** «1 строка / 2 строки / 5 строк» — числа человеку (docs/06 §10). */
const rowsWord = (n: number): string => {
  const tens = n % 100
  const ones = n % 10
  if (tens > 10 && tens < 20) return 'строк'
  if (ones === 1) return 'строка'
  if (ones >= 2 && ones <= 4) return 'строки'
  return 'строк'
}

/**
 * Раздел «SQL» (docs/02 §3, FR-Q1…Q5): запрос в поднятый туннель через драйвер
 * `pg`, результат таблицей, история, `psql` в терминале и пресеты `pg_dump`.
 * Боевая база красная: мутирующий запрос требует подтверждения, читающий
 * выполняется в read-only транзакции (это решает ядро, здесь — только диалог).
 */
export function SqlPanel(): React.JSX.Element {
  const { sql, sqlPresetId, sqlQuery, setSqlPreset, setSqlQuery, proxies, dumps, setActive } =
    useApp()
  const [result, setResult] = useState<Ok | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<SqlHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)

  const refreshHistory = useCallback(() => {
    void rpc('sql.history').then(setHistory)
  }, [])
  useEffect(refreshHistory, [refreshHistory])

  if (!sql || sql.targets.length === 0) {
    return (
      <div className="empty">
        <p>Пресетов БД нет.</p>
        <p>
          Секция <b>db.presets</b> конфига пуста — добавь туннели, и здесь появится консоль.
        </p>
      </div>
    )
  }

  const target = sql.targets.find((t) => t.presetId === sqlPresetId) ?? sql.targets[0]
  if (!target) return <div className="empty">Пресет не выбран.</div>
  const proxy = proxies[target.presetId]
  const ready = proxy?.state === 'healthy'
  const myDumps = Object.values(dumps).filter((d) => d.presetId === target.presetId)

  const run = async (confirmed: boolean): Promise<void> => {
    if (sqlQuery.trim() === '') return
    setRunning(true)
    try {
      const res = await rpc('sql.exec', { presetId: target.presetId, query: sqlQuery, confirmed })
      if (res.ok) {
        setResult(res)
        setError(null)
        return
      }
      if (res.reason === 'needs-confirm') {
        // US-14: мутирующий запрос на боевой базе — только с явным «да»
        if (window.confirm(`${res.error}\n\nВыполнить на «${target.label}»?`)) {
          await run(true)
        }
        return
      }
      setResult(null)
      setError(res.error)
    } finally {
      setRunning(false)
      refreshHistory()
    }
  }

  const withBusy = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const openSession = async (
    res: { ok: true; session: { id: string } } | { ok: false; error: string | null }
  ): Promise<void> => {
    if (res.ok) setActive(res.session.id)
    else if (res.error) setError(res.error)
  }

  return (
    <div className="sql">
      <div className="sql-head">
        <div className="envs">
          {sql.targets.map((t) => (
            <button
              key={t.presetId}
              className={`env ${t.presetId === target.presetId ? 'env-active' : ''} ${
                t.dangerous ? 'env-prod' : ''
              }`}
              onClick={() => {
                setSqlPreset(t.presetId)
                setResult(null)
                setError(null)
              }}
            >
              {t.dangerous ? '🔴 ' : ''}
              {t.label}
            </button>
          ))}
        </div>

        <TunnelChip target={target} state={proxy?.state ?? 'off'} />
        {!ready && (
          <button
            className="primary"
            disabled={busy || proxy === undefined}
            onClick={() => void withBusy(async () => proxy && (await startProxy(proxy)))}
          >
            Включить туннель
          </button>
        )}

        <span className="sql-spacer" />
        <button
          disabled={busy || !ready}
          title={`psql -U ${target.dbUser} -h 127.0.0.1 -p ${target.port} ${target.dbName}`}
          onClick={() =>
            void withBusy(async () => openSession(await rpc('sql.psql', { presetId: target.presetId })))
          }
        >
          psql в терминале
        </button>
        {sql.dumps.map((d) => (
          <button
            key={d.id}
            disabled={busy || !ready}
            title="Выбрать файл и запустить дамп"
            onClick={() =>
              void withBusy(async () => {
                if (target.dangerous && !window.confirm(`PROD: ${d.title} с «${target.label}»?`)) {
                  return
                }
                const res = await rpc('sql.dump', { dumpId: d.id, presetId: target.presetId })
                if (res.ok) setActive(res.session.id)
                else if (res.reason !== 'canceled') setError(res.error)
              })
            }
          >
            {d.title}…
          </button>
        ))}
      </div>

      {myDumps.map((task) => (
        <DumpRow key={task.sessionId} task={task} onOpen={() => setActive(task.sessionId)} />
      ))}

      <textarea
        className={`sql-editor ${target.dangerous ? 'sql-editor-prod' : ''}`}
        placeholder="SELECT … (⌘Enter — выполнить)"
        spellCheck={false}
        value={sqlQuery}
        onChange={(e) => setSqlQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void run(false)
          }
        }}
      />

      <div className="sql-actions">
        <button className="primary" disabled={running || !ready} onClick={() => void run(false)}>
          {running ? 'Выполняю…' : 'Выполнить ⌘⏎'}
        </button>
        <button disabled={running || sqlQuery === ''} onClick={() => setSqlQuery('')}>
          Очистить
        </button>
        <button onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Скрыть историю' : `История (${history.length})`}
        </button>
        <span className="settings-note">
          statement_timeout {Math.round(sql.statementTimeoutMs / 1000)} с · максимум{' '}
          {sql.maxRows} строк
          {target.dangerous && ' · боевая база: чтение идёт в read-only транзакции'}
        </span>
        {looksUnbounded(sqlQuery) && (
          <span className="chip chip-yellow" title="Иначе вернётся столько, сколько есть">
            добавь LIMIT
          </span>
        )}
      </div>

      {error && <div className="banner banner-red sql-error">{error}</div>}

      {showHistory ?
        <HistoryList
          history={history}
          onPick={(entry) => {
            setSqlQuery(entry.query)
            setSqlPreset(entry.presetId)
            setShowHistory(false)
          }}
          onClear={() => void rpc('sql.clearHistory').then(refreshHistory)}
        />
      : result ?
        <>
          <div className="sql-summary">
            <span className="chip chip-green">{result.command ?? 'OK'}</span>
            <span className="settings-note">
              {/* у INSERT/UPDATE/DELETE строк в ответе нет — rowCount это «затронуто» */}
              {result.columns.length === 0 ?
                `затронуто строк: ${result.rowCount}`
              : result.truncated ?
                `${result.rows.length} из ${result.rowCount} ${rowsWord(result.rowCount)}`
              : `${result.rowCount} ${rowsWord(result.rowCount)}`}{' '}
              · {fmtMs(result.ms)}
            </span>
            {result.readOnly && (
              <span className="chip chip-muted" title="Боевая база: транзакция read only">
                read-only
              </span>
            )}
            {result.truncated && (
              <span className="chip chip-yellow">
                показаны первые {result.rows.length} — добавь LIMIT
              </span>
            )}
          </div>
          {result.columns.length === 0 ?
            <div className="settings-note">Запрос ничего не вернул (это нормально для DDL/DML).</div>
          : <ResultTable columns={result.columns} rows={result.rows} />}
        </>
      : !error && <div className="settings-note">Результата ещё нет — выполни запрос.</div>}
    </div>
  )
}

function TunnelChip({
  target,
  state
}: {
  target: SqlTarget
  state: string
}): React.JSX.Element {
  const cls =
    state === 'healthy' ? 'chip-green'
    : state === 'off' ? 'chip-muted'
    : state === 'error' || state === 'degraded' ? 'chip-red'
    : 'chip-yellow'
  return (
    <span className={`chip ${cls}`} title={`${target.dbUser}@127.0.0.1:${target.port}/${target.dbName}`}>
      туннель: {state === 'healthy' ? `порт ${target.port}` : state}
    </span>
  )
}

/** Прогресс дампа: у pg_dump нет процентов, честный индикатор — размер файла. */
function DumpRow({ task, onOpen }: { task: DumpTaskView; onOpen: () => void }): React.JSX.Element {
  const label =
    task.state === 'running' ? `идёт… ${formatBytes(task.bytes)}`
    : task.state === 'done' ? `готово · ${formatBytes(task.bytes)} · ${fmtMs(task.ms ?? 0)}`
    : (task.error ?? 'не удалось')
  const cls =
    task.state === 'running' ? 'chip-yellow'
    : task.state === 'done' ? 'chip-green'
    : 'chip-red'
  return (
    <div className="sql-dump">
      <span className={`chip ${cls}`}>{task.title}</span>
      <span className="sql-dump-file" title={task.file}>
        {task.file}
      </span>
      <span className="settings-note">{label}</span>
      <button onClick={onOpen}>Открыть таб</button>
    </div>
  )
}

function HistoryList({
  history,
  onPick,
  onClear
}: {
  history: SqlHistoryEntry[]
  onPick: (entry: SqlHistoryEntry) => void
  onClear: () => void
}): React.JSX.Element {
  if (history.length === 0) {
    return <div className="settings-note">История пуста — выполненные запросы появятся здесь.</div>
  }
  return (
    <div className="sql-history">
      <div className="sql-history-head">
        <b>История запросов</b>
        <button onClick={onClear}>Очистить историю</button>
      </div>
      {history.map((h) => (
        <div key={h.id} className="sql-history-row" onClick={() => onPick(h)}>
          <span className="chip chip-muted">{h.presetId}</span>
          <span className="settings-note">{new Date(h.at).toLocaleString()}</span>
          <code className="sql-history-query">{h.query.replace(/\s+/g, ' ').slice(0, 160)}</code>
          <span
            className={`chip ${h.error ? 'chip-red' : 'chip-green'}`}
            title={h.error ?? undefined}
          >
            {h.error ?
              'ошибка'
            : `${h.rowCount ?? 0} ${rowsWord(h.rowCount ?? 0)} · ${fmtMs(h.ms ?? 0)}`}
          </span>
        </div>
      ))}
    </div>
  )
}
