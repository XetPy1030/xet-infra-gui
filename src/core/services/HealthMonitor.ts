import { CERT_WARN_MS, type CertHealth } from '../domain/health'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { AuthService } from './AuthService'
import { Emitter } from '../util/Emitter'

export interface HealthEvents extends Record<string, unknown> {
  update: { cert: CertHealth }
  /** Фронт «стало требоваться» (не каждый тик): баннер/уведомление перелогина. */
  authRequired: { reason: 'not-logged-in' | 'cert-expired' }
}

const TICK_MS = 20_000
/** Сам tsh status зовём редко (docs/04 §5): между — локальный отсчёт. */
const STATUS_REFRESH_MS = 5 * 60_000

/** Чистая функция здоровья серта — локальный отсчёт от valid_until. */
export function computeCertHealth(validUntil: string | null, nowMs: number): CertHealth {
  if (!validUntil) return { validUntil: null, remainingMs: null, warn: false, expired: true }
  const t = Date.parse(validUntil)
  if (Number.isNaN(t)) return { validUntil, remainingMs: null, warn: false, expired: true }
  const remainingMs = Math.max(0, t - nowMs)
  return {
    validUntil,
    remainingMs,
    warn: remainingMs < CERT_WARN_MS,
    expired: remainingMs <= 0
  }
}

/**
 * Тикер здоровья сертификата (docs/04 §5): локальный отсчёт от valid_until,
 * редкий refresh `tsh status`, внеочередной прогон по powerMonitor.resume и
 * после перелогина. Здоровье прокси-туннелей — у ProxySupervisor (он владеет
 * их probe-циклами), сюда не дублируется.
 */
export class HealthMonitor {
  readonly events = new Emitter<HealthEvents>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRefresh = 0
  private lastExpired: boolean | null = null

  constructor(
    private readonly auth: Pick<AuthService, 'refreshStatus' | 'getCached'>,
    private readonly clock: Clock = systemClock,
    private readonly tickMs = TICK_MS
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(false), this.tickMs)
    void this.tick(true)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Внеочередной прогон со свежим tsh status (resume/после операций). */
  checkNow(): void {
    void this.tick(true)
  }

  private async tick(forceRefresh: boolean): Promise<void> {
    const now = this.clock.now()
    if (forceRefresh || now - this.lastRefresh > STATUS_REFRESH_MS) {
      this.lastRefresh = now
      await this.auth.refreshStatus()
    }
    const status = this.auth.getCached()
    const cert = computeCertHealth(status?.loggedIn ? status.validUntil : null, this.clock.now())
    this.events.emit('update', { cert })
    if (cert.expired && this.lastExpired === false) {
      this.events.emit('authRequired', {
        reason: status?.loggedIn ? 'cert-expired' : 'not-logged-in'
      })
    }
    this.lastExpired = cert.expired
  }
}
