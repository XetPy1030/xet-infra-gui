import { useState } from 'react'
import { runAction } from '../actions'
import { rpc } from '../api'
import { useApp } from '../store'
import { CredsForm } from './CredsForm'

/** Записать значение по пути `teleport.proxy` в разобранный конфиг. */
function setPath(cfg: Record<string, unknown>, path: string, value: string): void {
  const keys = path.split('.')
  let node = cfg
  for (const key of keys.slice(0, -1)) {
    const next = node[key]
    if (typeof next !== 'object' || next === null) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[keys.at(-1) as string] = value
}

interface StepProps {
  n: number
  title: string
  done: boolean
  children: React.ReactNode
}

const Step = ({ n, title, done, children }: StepProps): React.JSX.Element => (
  <section className={`wiz-step ${done ? 'wiz-done' : ''}`}>
    <h4 className="wiz-head">
      <span className="wiz-num">{done ? '✓' : n}</span>
      {title}
    </h4>
    <div className="wiz-body">{children}</div>
  </section>
)

/**
 * Мастер первого запуска (FR-C2, docs/02 §6.4): tsh → конфиг → креды → тестовый
 * логин. Открывается сам, когда конфиг пуст, и доступен потом из настроек.
 *
 * Пишет он в тот же файл конфига, что и редактор (через `config.save`), поэтому
 * второй схемы настроек в приложении не появляется — только удобный ввод
 * нескольких полей.
 */
export function WizardPanel(): React.JSX.Element {
  const { ui, config, status, creds, setUi, setWizardOpen, setConfig } = useApp()
  const [proxy, setProxy] = useState('')
  const [user, setUser] = useState('')
  const [tshPath, setTshPath] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const credsReady = creds?.password !== 'none' && creds?.totpSecret !== 'none'

  const patch = async (values: Record<string, string>): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const state = await rpc('config.get')
      let cfg: Record<string, unknown>
      try {
        cfg = JSON.parse(state.text) as Record<string, unknown>
      } catch {
        setNotice('Конфиг не разбирается как JSON — поправь его в редакторе ниже.')
        return
      }
      for (const [path, value] of Object.entries(values)) setPath(cfg, path, value)
      const res = await rpc('config.save', { text: JSON.stringify(cfg, null, 2) })
      if (!res.ok) {
        setNotice(res.error)
        return
      }
      setConfig(await rpc('config.get'))
      setNotice('Сохранено. Настройки применятся после перезапуска приложения.')
    } finally {
      setBusy(false)
    }
  }

  const setAutostart = async (enabled: boolean): Promise<void> => {
    const res = await rpc('app.setAutostart', { enabled })
    if (ui) setUi({ ...ui, autostart: res.enabled })
  }

  return (
    <div className="wizard">
      <div className="wiz-title">
        <b>Мастер настройки</b>
        <span className="settings-note">Пять минут — и приложение рабочее.</span>
        <span className="sql-spacer" />
        <button onClick={() => setWizardOpen(false)}>Закрыть</button>
      </div>

      <Step n={1} title="tsh" done={ui?.tsh.found === true}>
        {ui?.tsh.found ?
          <span>
            Найден: <code>{ui.tsh.path}</code>
          </span>
        : <>
            <span className="chip chip-red">не найден</span>
            <span>
              Приложение искало <code>{ui?.tsh.path ?? 'tsh'}</code> в PATH из login-shell. Укажи
              полный путь:
            </span>
            <div className="settings-row">
              <input
                placeholder="/usr/local/bin/tsh"
                value={tshPath}
                onChange={(e) => setTshPath(e.target.value)}
              />
              <button
                disabled={busy || tshPath.trim() === ''}
                onClick={() => void patch({ 'teleport.tshPath': tshPath.trim() })}
              >
                Сохранить
              </button>
            </div>
          </>
        }
      </Step>

      <Step n={2} title="Кластер и пользователь" done={config?.configured === true}>
        <div className="settings-row">
          <span className="settings-label">Прокси Teleport</span>
          <input
            placeholder="teleport.example.com:443"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
          />
          <span className="settings-label">Пользователь</span>
          <input
            placeholder="user@example.com"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
          <button
            className="primary"
            disabled={busy || proxy.trim() === '' || user.trim() === ''}
            onClick={() =>
              void patch({ 'teleport.proxy': proxy.trim(), 'teleport.user': user.trim() })
            }
          >
            Сохранить
          </button>
        </div>
        <span className="settings-note">
          Остальное (kube-кластеры, workload'ы, db-пресеты) — в редакторе конфига ниже или
          импортом готового файла.
        </span>
      </Step>

      <Step n={3} title="Пароль и TOTP-девайс" done={credsReady === true}>
        <CredsForm />
        <span className="settings-note">
          Пароль и секрет уходят в Keychain (safeStorage) и в renderer никогда не возвращаются.
          «Создать TOTP-девайс» проведёт через <code>tsh mfa add</code> — код существующего
          девайса нужно будет ввести руками один раз.
        </span>
      </Step>

      <Step n={4} title="Тестовый логин" done={status?.loggedIn === true}>
        <div className="settings-row">
          <button
            className="primary"
            disabled={busy || config?.configured !== true}
            onClick={() => void runAction('auth.login')}
          >
            Войти в Teleport
          </button>
          <span className="settings-note">
            {status?.loggedIn ?
              `Залогинен: ${status.username ?? ''} · ${status.cluster ?? ''}`
            : 'Откроется таб терминала; пароль и OTP подставятся сами.'}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Автозапуск при входе</span>
          <button
            className={`toggle ${ui?.autostart ? 'toggle-on' : ''}`}
            onClick={() => void setAutostart(!ui?.autostart)}
          >
            <span className="knob" />
          </button>
        </div>
      </Step>

      <div className="settings-row">
        {notice && <span className="chip chip-yellow">{notice}</span>}
        <button disabled={busy} onClick={() => void rpc('config.relaunch')}>
          Перезапустить приложение
        </button>
      </div>
    </div>
  )
}
