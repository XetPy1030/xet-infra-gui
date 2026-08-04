import { BrowserWindow, ipcMain } from 'electron'
import type { MfaEnrollService } from '@core/modules/teleport/MfaEnrollService'
import type { ActionRegistry } from '@core/services/ActionRegistry'
import type { AuthService } from '@core/services/AuthService'
import type { DumpService } from '@core/services/DumpService'
import type { HealthMonitor } from '@core/services/HealthMonitor'
import type { KubeService } from '@core/services/KubeService'
import type { ProxySupervisor } from '@core/services/ProxySupervisor'
import type { SessionManager } from '@core/services/SessionManager'
import type { SqlService } from '@core/services/SqlService'
import { rpcReqSchemas } from '@shared/schemas'
import type { CredsStatus, EventMap, RpcMap, UiStateView } from '@shared/types'
import type { ConfigBridge } from './configBridge'

export function broadcast<K extends keyof EventMap>(channel: K, payload: EventMap[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

interface Deps {
  sessions: SessionManager
  auth: AuthService
  supervisor: ProxySupervisor
  monitor: HealthMonitor
  mfa: MfaEnrollService
  kube: KubeService
  sql: SqlService
  dumps: DumpService
  actions: ActionRegistry
  config: ConfigBridge
  /** Оболочка приложения: хоткеи, автозапуск, tsh (собирается в composition root). */
  ui: {
    state(): UiStateView
    setAutostart(enabled: boolean): { enabled: boolean }
  }
  /** Статус/запись кредов — собирается в composition root (значения не ходят). */
  creds: {
    status(): Promise<CredsStatus>
    save(req: { password?: string | null; totpSecret?: string | null }): Promise<CredsStatus>
  }
}

export function registerIpc({
  sessions,
  auth,
  supervisor,
  mfa,
  kube,
  sql,
  dumps,
  actions,
  creds,
  config,
  ui
}: Deps): void {
  const handle = <K extends keyof RpcMap>(
    channel: K,
    fn: (req: RpcMap[K]['req']) => Promise<RpcMap[K]['res']> | RpcMap[K]['res']
  ): void => {
    ipcMain.handle(channel, (_event, payload: unknown) => {
      const req = rpcReqSchemas[channel].parse(payload) as RpcMap[K]['req']
      return fn(req)
    })
  }

  handle('app.bootstrap', () => {
    // отдаём кэш мгновенно, свежий статус прилетит событием status/update
    void auth.refreshStatus()
    return {
      config: config.state(),
      status: auth.getCached(),
      sessions: sessions.list(),
      proxies: supervisor.list(),
      kube: kube.state(),
      kubeSessions: kube.sessionMetas(),
      sql: sql.state(),
      dumps: dumps.list(),
      ui: ui.state()
    }
  })
  handle('auth.login', () => ({ session: auth.login() }))
  handle('actions.list', () => actions.list())
  handle('actions.run', (req) => actions.run(req))
  handle('app.setAutostart', ({ enabled }) => ui.setAutostart(enabled))
  handle('config.get', () => config.state())
  handle('config.check', ({ text }) => config.check(text))
  handle('config.save', ({ text }) => config.save(text))
  handle('config.importFile', () => config.importFile())
  handle('config.exportFile', () => config.exportFile())
  handle('config.relaunch', () => config.relaunch())
  handle('tsh.status', () => auth.refreshStatus())
  handle('session.write', ({ id, data }) => sessions.write(id, data))
  handle('session.resize', ({ id, cols, rows }) => sessions.resize(id, cols, rows))
  handle('session.stop', ({ id }) => sessions.stop(id))
  handle('session.snapshot', ({ id }) => sessions.snapshot(id))
  handle('session.ack', ({ id, upTo }) => sessions.ack(id, upTo))
  handle('session.dispose', ({ id }) => {
    sessions.remove(id)
  })
  handle('session.setPaused', ({ id, paused }) => sessions.setPaused(id, paused))
  handle('creds.status', () => creds.status())
  handle('creds.save', (req) => creds.save(req))
  handle('mfa.enroll', () => ({ session: mfa.enroll() }))
  handle('kube.setEnv', ({ env }) => kube.setEnv(env))
  handle('kube.pods', ({ env, force }) => kube.listPods(env, { force }))
  handle('kube.bash', (req) => kube.bash(req))
  handle('kube.logs', (req) => kube.logs(req))
  handle('kube.exec', (req) => kube.exec(req))
  handle('kube.execPty', (req) => kube.execPty(req))
  handle('sql.exec', (req) => sql.exec(req))
  handle('sql.history', () => sql.historyList())
  handle('sql.clearHistory', () => sql.clearHistory())
}

/** События core → push в renderer (ADR-0005: main — источник правды). */
export function wireEvents({ sessions, auth, supervisor, monitor, mfa, kube, dumps }: Deps): void {
  sessions.events.on('data', (p) => broadcast('session/data', p))
  sessions.events.on('state', (p) => broadcast('session/state', p))
  sessions.events.on('prompt', (p) => broadcast('session/prompt', p))
  sessions.events.on('removed', (p) => broadcast('session/removed', p))
  auth.events.on('status', (p) => {
    broadcast('status/update', p)
    // активный kube-контекст живёт в tsh status → его смена меняет и kube-состояние
    broadcast('kube/state', { view: kube.state() })
  })
  kube.events.on('state', (p) => broadcast('kube/state', p))
  kube.events.on('session', (p) => broadcast('kube/session', p))
  dumps.events.on('progress', (p) => broadcast('sql/dump', p))
  supervisor.events.on('state', (p) => broadcast('proxy/state', p))
  monitor.events.on('update', (p) => broadcast('health/update', p))
  mfa.events.on('progress', (p) => broadcast('mfa/enroll', p))
}
