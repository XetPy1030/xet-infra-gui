import { useEffect, useRef, useState } from 'react'
import { formatAccelerator } from '@shared/accelerator'
import type { SessionState } from '@shared/types'
import { rpc } from './api'
import { KubeBar } from './components/KubeBar'
import { Palette } from './components/Palette'
import { PodsPanel } from './components/PodsPanel'
import { ProxyPanel } from './components/ProxyPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { SqlPanel } from './components/SqlPanel'
import { StatusBar } from './components/StatusBar'
import { TerminalView } from './components/TerminalView'
import { WizardPanel } from './components/WizardPanel'
import { useHotkeys } from './hotkeys'
import { confirmProd, runKubeSession } from './kube'
import { useApp } from './store'

const STATE_LABELS: Record<SessionState, string> = {
  spawning: 'запускается',
  awaiting_password: 'ждёт пароль',
  awaiting_otp: 'ждёт OTP-код',
  running: 'работает',
  healthy: 'работает ●',
  degraded: 'деградация',
  exited: 'завершена',
  failed: 'ошибка'
}

const stateClass = (s: SessionState): string =>
  s === 'running' || s === 'healthy' ? 'chip-green'
  : s === 'exited' ? 'chip-muted'
  : s === 'failed' || s === 'degraded' ? 'chip-red'
  : 'chip-yellow'

export function App(): React.JSX.Element {
  const {
    bootstrapped,
    config,
    status,
    sessions,
    order,
    activeId,
    manualPrompt,
    health,
    view,
    setView,
    kubeSessions,
    appError,
    setAppError,
    setActive,
    ui,
    settingsOpen,
    setSettingsOpen,
    wizardOpen,
    setWizardOpen,
    setPaletteOpen
  } = useApp()
  const [loggingIn, setLoggingIn] = useState(false)
  useHotkeys()

  const needsConfig = bootstrapped && config !== null && !config.configured
  // первый запуск: мастер открывается сам — но ровно один раз, закрыл так закрыл
  const wizardShown = useRef(false)
  useEffect(() => {
    if (needsConfig && !wizardShown.current) {
      wizardShown.current = true
      setWizardOpen(true)
    }
  }, [needsConfig, setWizardOpen])
  const active = activeId ? sessions[activeId] : undefined
  const activeKube = activeId ? kubeSessions[activeId] : undefined
  // под мог уехать в rollout: мёртвая kube-сессия предлагает свежайший (docs/02 §6.3).
  // one-shot команду переподключать нечем — она отработала, её результат уже в табе
  const canReconnect =
    activeKube &&
    activeKube.kind !== 'exec' &&
    active &&
    (active.state === 'exited' || active.state === 'failed')

  const onLogin = async (): Promise<void> => {
    setLoggingIn(true)
    try {
      const { session } = await rpc('auth.login')
      useApp.getState().upsertSession(session)
      setActive(session.id)
    } finally {
      setLoggingIn(false)
    }
  }

  return (
    <div className="app">
      <Palette />
      <header className="header">
        <div className="header-left">
          <span className="logo">xet</span>
          <StatusBar status={status} loaded={bootstrapped} />
        </div>
        <div className="header-right">
          <button
            className="pal-open"
            title="Палитра команд: любое действие приложения"
            onClick={() => setPaletteOpen(true)}
          >
            {ui ? formatAccelerator(ui.hotkeys.palette) : '⌘K'} Действия
          </button>
          <button onClick={() => setSettingsOpen(!settingsOpen)}>
            {settingsOpen ? 'Скрыть настройки' : 'Настройки'}
          </button>
          <button onClick={() => void rpc('tsh.status')}>Обновить</button>
          <button
            className="primary"
            disabled={loggingIn || needsConfig}
            title={needsConfig ? 'Сначала заполни конфиг' : 'tsh login'}
            onClick={() => void onLogin()}
          >
            {loggingIn ? '…' : 'Login'}
          </button>
        </div>
      </header>

      {wizardOpen && <WizardPanel />}
      {settingsOpen && <SettingsPanel />}
      <ProxyPanel />
      <KubeBar />

      {needsConfig && !wizardOpen && !settingsOpen && (
        <div className="banner">
          Конфиг пуст: не заданы прокси и пользователь Teleport.{' '}
          <button className="primary" onClick={() => setWizardOpen(true)}>
            Мастер настройки
          </button>
          <button onClick={() => setSettingsOpen(true)}>Открыть конфиг</button>
        </div>
      )}

      {bootstrapped && health?.expired && (
        <div className="banner banner-red">
          {status?.loggedIn
            ? 'Сертификат Teleport истёк — нужен перелогин.'
            : 'Не залогинен в Teleport.'}{' '}
          <button className="primary" disabled={loggingIn} onClick={() => void onLogin()}>
            Перелогин
          </button>
        </div>
      )}

      {appError && (
        <div className="banner banner-red">
          {appError.message}
          {appError.needsLogin && (
            <button className="primary" disabled={loggingIn} onClick={() => void onLogin()}>
              Перелогин
            </button>
          )}
          <button onClick={() => setAppError(null)}>Скрыть</button>
        </div>
      )}

      <nav className="tabs">
        <button
          className={`tab ${view === 'pods' ? 'tab-active' : ''}`}
          onClick={() => setView('pods')}
        >
          Поды
        </button>
        <button
          className={`tab ${view === 'sql' ? 'tab-active' : ''}`}
          onClick={() => setView('sql')}
        >
          SQL
        </button>
        {order.map((id) => {
            const s = sessions[id]
            if (!s) return null
            const dead = s.state === 'exited' || s.state === 'failed'
            return (
              <button
                key={id}
                className={`tab ${id === activeId ? 'tab-active' : ''}`}
                onClick={() => setActive(id)}
              >
                {s.title}
                <span className={`chip ${stateClass(s.state)}`}>{STATE_LABELS[s.state]}</span>
                {dead && (
                  <span
                    className="tab-close"
                    title="Закрыть таб"
                    onClick={(e) => {
                      e.stopPropagation()
                      void rpc('session.dispose', { id })
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            )
          })}
        {view === 'session' && active && active.exitCode === null && (
          <button
            className="tab tab-stop"
            title="Завершить сессию"
            onClick={() => void rpc('session.stop', { id: active.id })}
          >
            ✕
          </button>
        )}
      </nav>

      {view === 'session' && manualPrompt && manualPrompt.sessionId === activeId && (
        <div className="banner">
          Авто-ответ не сработал — введи{' '}
          {manualPrompt.kind === 'password' ? 'пароль' : 'OTP-код'} прямо в терминале и нажми
          Enter.
        </div>
      )}

      {view === 'session' && canReconnect && activeKube && (
        <div className="banner">
          Сессия завершилась (под мог уехать в rollout).{' '}
          <button
            className="primary"
            onClick={() => {
              const isLogs = activeKube.kind === 'logs'
              if (!isLogs && !confirmProd(activeKube.env, `bash в под «${activeKube.workloadId ?? activeKube.pod}»`))
                return
              void runKubeSession(() =>
                rpc(isLogs ? 'kube.logs' : 'kube.bash', {
                  env: activeKube.env,
                  workloadId: activeKube.workloadId,
                  // без workload'а переподключаться некуда, кроме того же пода
                  pod: activeKube.workloadId ? undefined : activeKube.pod
                })
              )
            }}
          >
            {activeKube.workloadId ? 'Переподключиться к свежему поду' : 'Повторить'}
          </button>
        </div>
      )}

      <main className="content">
        {view === 'pods' ?
          <PodsPanel />
        : view === 'sql' ?
          <SqlPanel />
        : activeId ?
          <TerminalView
            key={activeId}
            sessionId={activeId}
            logTools={activeKube?.kind === 'logs'}
            paused={active?.paused === true}
          />
        : <div className="empty">
            <p>Сессий нет.</p>
            <p>
              <b>Login</b> — перелогин с автоподстановкой пароля и OTP из Keychain. Тумблеры
              выше — DB-прокси и быстрые kube-действия; список подов — вкладка «Поды».
            </p>
          </div>
        }
      </main>
    </div>
  )
}
