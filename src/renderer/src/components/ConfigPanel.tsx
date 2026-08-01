import { useEffect, useState } from 'react'
import type { ConfigFileResult } from '@shared/types'
import { rpc } from '../api'
import { useApp } from '../store'

type Notice = { kind: 'ok' | 'error'; text: string } | null

const fileNotice = (res: ConfigFileResult, okText: string): Notice => {
  if (res.status === 'canceled') return null
  if (res.status === 'error') return { kind: 'error', text: res.error ?? 'не получилось' }
  return { kind: 'ok', text: `${okText}${res.path ? `: ${res.path}` : ''}` }
}

/**
 * Конфиг как текст: правка, импорт и экспорт шаблона. Схема валидирует в main,
 * поэтому здесь нет второй копии правил — только показ ошибки.
 *
 * Изменения применяются перезапуском: сервисы получают секции конфига при
 * сборке, и подмена на лету дала бы половину приложения на старых настройках.
 */
export function ConfigPanel(): React.JSX.Element {
  const { config, setConfig } = useApp()
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (config && !dirty) setText(config.text)
  }, [config, dirty])

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
        return
      }
      setNotice({ kind: 'ok', text: 'Сохранено — примени перезапуском.' })
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
        className="config-editor"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
          setNotice(null)
        }}
      />

      <div className="settings-row">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Сохранить
        </button>
        <button disabled={busy} onClick={() => void rpc('config.relaunch')}>
          Перезапустить приложение
        </button>
        {notice && (
          <span className={notice.kind === 'ok' ? 'chip chip-green' : 'chip chip-red'}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}
