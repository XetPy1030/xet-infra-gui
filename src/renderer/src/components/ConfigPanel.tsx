import { useEffect, useRef, useState } from 'react'
import { locateJsonPath } from '@shared/jsonPath'
import type { ConfigFileResult, ConfigIssue } from '@shared/types'
import { rpc } from '../api'
import { useApp } from '../store'

type Notice = { kind: 'ok' | 'error'; text: string } | null

const fileNotice = (res: ConfigFileResult, okText: string): Notice => {
  if (res.status === 'canceled') return null
  if (res.status === 'error') return { kind: 'error', text: res.error ?? 'не получилось' }
  return { kind: 'ok', text: `${okText}${res.path ? `: ${res.path}` : ''}` }
}

/** Пауза перед проверкой: она ходит в main, дёргать её на каждую букву незачем. */
const CHECK_DELAY_MS = 400

/**
 * Конфиг как текст: правка, проверка схемой, импорт и экспорт шаблона. Схема
 * живёт в ядре, поэтому валидирует main — здесь только показ проблем и переход
 * к нужной строке (путь из zod → строка в тексте, `shared/jsonPath`).
 *
 * Изменения применяются перезапуском: сервисы получают секции конфига при
 * сборке, и подмена на лету дала бы половину приложения на старых настройках.
 */
export function ConfigPanel(): React.JSX.Element {
  const { config, setConfig } = useApp()
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [issues, setIssues] = useState<ConfigIssue[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const editor = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (config && !dirty) setText(config.text)
  }, [config, dirty])

  // проверка на лету: ошибка схемы видна до сохранения (FR-C1)
  useEffect(() => {
    if (text === '') return
    const timer = setTimeout(() => {
      void rpc('config.check', { text }).then((res) => setIssues(res.ok ? [] : res.issues))
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text])

  const refresh = async (): Promise<void> => {
    const state = await rpc('config.get')
    setConfig(state)
    setText(state.text)
    setDirty(false)
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      const res = await rpc('config.save', { text })
      if (!res.ok) {
        setNotice({ kind: 'error', text: res.error })
        setIssues(res.issues)
        return
      }
      setNotice({ kind: 'ok', text: 'Сохранено — примени перезапуском.' })
      setIssues([])
      await refresh()
    })

  const importFile = (): Promise<void> =>
    run(async () => {
      const res = await rpc('config.importFile')
      setNotice(fileNotice(res, 'Импортировано, примени перезапуском'))
      if (res.status === 'ok') await refresh()
    })

  const exportFile = (): Promise<void> =>
    run(async () => {
      setNotice(fileNotice(await rpc('config.exportFile'), 'Выгружено'))
    })

  /** Клик по проблеме — выделить проблемную строку в редакторе. */
  const jumpTo = (issue: ConfigIssue): void => {
    const area = editor.current
    const line = issue.path === '' ? 1 : locateJsonPath(text, issue.path)
    if (!area || line === null) return
    const lines = text.split('\n')
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0)
    area.focus()
    area.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0))
  }

  return (
    <div className="config">
      <div className="settings-row">
        <span className="settings-label">Файл конфига</span>
        <code className="config-path">{config?.path ?? '…'}</code>
        <button disabled={busy} onClick={() => void importFile()}>
          Импорт из файла
        </button>
        <button disabled={busy} onClick={() => void exportFile()}>
          Экспорт в файл
        </button>
        <button disabled={busy} onClick={() => void run(refresh)}>
          Перечитать
        </button>
      </div>

      {config?.error && (
        <div className="banner banner-red">
          Конфиг не прошёл валидацию, приложение работает на пустом:
          <pre className="config-error">{config.error}</pre>
        </div>
      )}

      <textarea
        className={`config-editor ${issues.length > 0 ? 'config-editor-bad' : ''}`}
        spellCheck={false}
        ref={editor}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
          setNotice(null)
        }}
      />

      {issues.length > 0 && (
        <div className="config-issues">
          {issues.map((issue, i) => (
            <button
              key={`${issue.path}-${i}`}
              className="config-issue"
              title="Показать в редакторе"
              onClick={() => jumpTo(issue)}
            >
              <code>{issue.path || 'файл'}</code>
              {issue.message}
            </button>
          ))}
        </div>
      )}

      <div className="settings-row">
        <button
          className="primary"
          disabled={busy || !dirty || issues.length > 0}
          title={issues.length > 0 ? 'Сначала поправь ошибки схемы' : 'Записать конфиг'}
          onClick={() => void save()}
        >
          Сохранить
        </button>
        <button disabled={busy} onClick={() => void rpc('config.relaunch')}>
          Перезапустить приложение
        </button>
        {issues.length === 0 && dirty && <span className="chip chip-green">схема ок</span>}
        {notice && (
          <span className={notice.kind === 'ok' ? 'chip chip-green' : 'chip chip-red'}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}
