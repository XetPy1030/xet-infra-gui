/**
 * Доменная модель сессии (FSM — docs/03 §4.2). healthy/degraded выставляет
 * супервизор/health-monitor поверх running (только для supervised-сессий);
 * «restarting» — состояние ПРОКСИ, не сессии: каждый рестарт = новый PTY
 * (см. core/domain/proxy.ts).
 */
export type SessionState =
  | 'spawning'
  | 'awaiting_password'
  | 'awaiting_otp'
  | 'running'
  | 'healthy'
  | 'degraded'
  | 'exited'
  | 'failed'

export interface SessionSpec {
  title: string
  cmd: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  /**
   * Вырезать терминальные report-ответы (CPR/DA/DSR/OSC) из ввода в PTY.
   * true для неинтерактивных auth-сессий (login, proxy), где авто-ответы xterm
   * портят чтение пароля. Для интерактивных (exec bash) — false: там они нужны
   * программам (vim и т.п.). См. core/util/terminalInput.ts.
   */
  sanitizeTerminalReports?: boolean
}

export interface SessionInfo {
  id: string
  title: string
  state: SessionState
  exitCode: number | null
  startedAt: number
  /** Пауза потока по кнопке пользователя (логи `--follow`, FR-K6). */
  paused: boolean
}

export const isAliveState = (s: SessionState): boolean => s !== 'exited' && s !== 'failed'
