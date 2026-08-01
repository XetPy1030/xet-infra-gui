import { describe, expect, it } from 'vitest'
import type { CertHealth } from '../domain/health'
import type { TshStatus } from '../modules/teleport/types'
import { computeCertHealth, HealthMonitor } from './HealthMonitor'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const NOW = Date.parse('2026-07-29T12:00:00+04:00')

const loggedIn = (validUntil: string): TshStatus => ({
  loggedIn: true,
  username: 'user@example.com',
  cluster: 'teleport.example.com',
  kubeCluster: null,
  validUntil
})

describe('computeCertHealth', () => {
  it('свежий серт: остаток без warn', () => {
    const h = computeCertHealth('2026-07-29T20:00:00+04:00', NOW)
    expect(h.expired).toBe(false)
    expect(h.warn).toBe(false)
    expect(h.remainingMs).toBe(8 * 3600 * 1000)
  })

  it('меньше 30 минут → warn', () => {
    const h = computeCertHealth('2026-07-29T12:20:00+04:00', NOW)
    expect(h.warn).toBe(true)
    expect(h.expired).toBe(false)
  })

  it('в прошлом → expired, остаток clamp 0', () => {
    const h = computeCertHealth('2026-07-29T11:00:00+04:00', NOW)
    expect(h.expired).toBe(true)
    expect(h.remainingMs).toBe(0)
  })

  it('нет valid_until (не залогинен) / кривая дата → expired', () => {
    expect(computeCertHealth(null, NOW).expired).toBe(true)
    expect(computeCertHealth('мусор', NOW).expired).toBe(true)
  })
})

describe('HealthMonitor', () => {
  it('checkNow: рефрешит статус, эмитит update; authRequired только на фронте истечения', async () => {
    let status: TshStatus | null = loggedIn('2026-07-29T20:00:00+04:00')
    let refreshes = 0
    const auth = {
      refreshStatus: async () => {
        refreshes++
        return status
      },
      getCached: () => status
    }
    const updates: CertHealth[] = []
    const authRequired: string[] = []
    let now = NOW
    const monitor = new HealthMonitor(auth, { now: () => now })
    monitor.events.on('update', ({ cert }) => updates.push(cert))
    monitor.events.on('authRequired', ({ reason }) => authRequired.push(reason))

    monitor.checkNow() // залогинен, серт свежий
    await flush()
    expect(refreshes).toBe(1)
    expect(updates.at(-1)?.expired).toBe(false)
    expect(authRequired).toEqual([])

    now = Date.parse('2026-07-29T21:00:00+04:00') // серт истёк по локальным часам
    monitor.checkNow()
    await flush()
    expect(updates.at(-1)?.expired).toBe(true)
    expect(authRequired).toEqual(['cert-expired']) // фронт false→true

    monitor.checkNow() // всё ещё истёк — событие не дублируется
    await flush()
    expect(authRequired).toEqual(['cert-expired'])

    status = { loggedIn: false, username: null, cluster: null, kubeCluster: null, validUntil: null }
    monitor.checkNow()
    await flush()
    expect(updates.at(-1)?.validUntil).toBeNull() // разлогин отражён, но фронта нет
  })
})
