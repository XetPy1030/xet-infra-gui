import type { SessionInfo } from '../domain/session'
import type { TshClient } from '../modules/teleport/TshClient'
import type { TshStatus } from '../modules/teleport/types'
import { Emitter } from '../util/Emitter'
import type { PipelineFactory, SessionManager } from './SessionManager'

export interface AuthEvents extends Record<string, unknown> {
  status: { status: TshStatus | null }
  /** Успешный (пере)логин: login-сессия вышла с 0 и статус подтвердил сессию. */
  loggedIn: { status: TshStatus }
}

/**
 * Логин/перелогин и состояние сертификата (FR-A5/A6). После завершения
 * login-сессии статус обновляется сам; на подтверждённый логин шлёт loggedIn —
 * composition root дёргает каскад ProxySupervisor.restartMarked() (docs/04 §6).
 */
export class AuthService {
  readonly events = new Emitter<AuthEvents>()
  private cached: TshStatus | null = null
  private loginSessionId: string | null = null

  constructor(
    private readonly sessions: SessionManager,
    private readonly tsh: TshClient,
    private readonly pipelineFactory: PipelineFactory
  ) {
    this.sessions.events.on('state', ({ info }) => {
      if (info.id !== this.loginSessionId) return
      if (info.state === 'exited' || info.state === 'failed') {
        void this.refreshStatus().then((status) => {
          if (info.exitCode === 0 && status?.loggedIn) {
            this.events.emit('loggedIn', { status })
          }
        })
      }
    })
  }

  getCached(): TshStatus | null {
    return this.cached
  }

  async refreshStatus(): Promise<TshStatus | null> {
    this.cached = await this.tsh.status()
    this.events.emit('status', { status: this.cached })
    return this.cached
  }

  /** Запускает PTY `tsh login` c автоответом на промпты; идемпотентен для живой сессии. */
  login(): SessionInfo {
    if (this.loginSessionId) {
      if (this.sessions.isAlive(this.loginSessionId)) {
        const existing = this.sessions.snapshot(this.loginSessionId)
        if (existing) return existing.info
      } else {
        // прошлый логин завершён — убираем из реестра, не копим табы/Map
        this.sessions.remove(this.loginSessionId)
      }
    }
    const { title, cmd, args, sanitizeTerminalReports } = this.tsh.loginCommand()
    const info = this.sessions.start(
      { title, cmd, args, sanitizeTerminalReports },
      this.pipelineFactory
    )
    this.loginSessionId = info.id
    return info
  }
}
