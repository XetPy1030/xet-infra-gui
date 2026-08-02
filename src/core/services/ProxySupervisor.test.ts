import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OTP_PROMPT } from '../modules/teleport/__fixtures__/tsh'
import { TELEPORT_PROMPT_PATTERNS } from '../modules/teleport/prompts'
import type { DbProxyPreset } from '../modules/teleport/types'
import { noopLogger } from '../ports/Logger'
import type { ProcessRunner } from '../ports/ProcessRunner'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import type { TcpProbe } from '../ports/TcpProbe'
import { PromptPipeline } from './PromptPipeline'
import { ProxySupervisor } from './ProxySupervisor'
import { SessionManager } from './SessionManager'

/** PTY, который на kill сам «умирает» (как настоящий tsh на SIGTERM). */
class FakePty implements PtyHandle {
  written: string[] = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number | null }) => void) | null = null
  private dead = false

  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {
    this.emitExit(143)
  }
  onData(cb: (d: string) => void): void {
    this.dataCb = cb
  }
  onExit(cb: (e: { exitCode: number | null }) => void): void {
    this.exitCb = cb
  }
  emitData(d: string): void {
    this.dataCb?.(d)
  }
  emitExit(code: number): void {
    if (this.dead) return
    this.dead = true
    this.exitCb?.({ exitCode: code })
  }
}

const preset = (id: string, dbName: string, port = 6432): DbProxyPreset => ({
  id,
  env: 'dev',
  tunnel: `${dbName}-postgres`,
  dbUser: 'app',
  dbName,
  port,
  dangerous: false
})

function setup(opts: { lsof?: string; sql?: boolean } = {}) {
  const ptys: FakePty[] = []
  const factory: PtyFactory = {
    spawn: () => {
      const p = new FakePty()
      ptys.push(p)
      return p
    }
  }
  const sessions = new SessionManager(factory, noopLogger)
  let portOpen = false
  const probe: TcpProbe = { check: async () => portOpen }
  const runner: ProcessRunner | null = opts.lsof
    ? { run: async () => ({ stdout: opts.lsof ?? '', stderr: '', code: 0 }) }
    : null
  const sup = new ProxySupervisor(
    [preset('db-dev', 'dev'), preset('db-stage', 'stage')],
    sessions,
    {
      proxyDbCommand: (p) => ({
        title: `proxy: ${p.dbName}`,
        cmd: 'tsh',
        args: ['proxy', 'db', p.tunnel],
        sanitizeTerminalReports: true
      })
    },
    probe,
    (io) =>
      new PromptPipeline(TELEPORT_PROMPT_PATTERNS, { resolve: async () => '123456' }, io),
    runner,
    noopLogger
  )
  const states: string[] = []
  sup.events.on('state', ({ view }) => states.push(`${view.presetId}:${view.state}`))

  // расширенный health-check (M3): «база отвечает» отдельно от «порт открыт»
  let dbOk = true
  const sqlProbes: string[] = []
  if (opts.sql) {
    sup.setSqlProbe(async (presetId) => {
      sqlProbes.push(presetId)
      return dbOk ? { ok: true } : { ok: false, error: 'terminating connection' }
    })
  }
  return {
    sup,
    sessions,
    ptys,
    states,
    sqlProbes,
    setPortOpen: (v: boolean) => (portOpen = v),
    setDbOk: (v: boolean) => (dbOk = v)
  }
}

const adv = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ProxySupervisor', () => {
  it('happy path: start → OTP авто-ответ → probing → healthy (docs/02 §6.1)', async () => {
    const { sup, sessions, ptys, setPortOpen } = setup()
    expect(await sup.start('db-dev')).toEqual({ ok: true })
    expect(ptys).toHaveLength(1)

    ptys[0]?.emitData(OTP_PROMPT)
    await adv(50)
    expect(ptys[0]?.written).toEqual(['123456\r'])

    setPortOpen(true)
    await adv(600) // fast-probe 500 мс
    const view = sup.list().find((v) => v.presetId === 'db-dev')
    expect(view?.state).toBe('healthy')
    expect(sessions.list().find((s) => s.id === view?.sessionId)?.state).toBe('healthy')
  })

  it('упавший прокси рестартует с backoff; старая сессия убрана из реестра', async () => {
    const { sup, sessions, ptys, setPortOpen } = setup()
    await sup.start('db-dev')
    setPortOpen(true)
    await adv(600)
    expect(sup.list()[0]?.state).toBe('healthy')

    setPortOpen(false)
    ptys[0]?.emitExit(1) // умер сам
    await adv(50)
    expect(sup.list()[0]?.state).toBe('restarting')

    await adv(1100) // backoff первой попытки 1 с
    expect(ptys).toHaveLength(2)
    expect(sup.list()[0]?.attempts).toBe(1)
    expect(sessions.list()).toHaveLength(1) // мёртвой сессии в реестре нет

    setPortOpen(true)
    await adv(600)
    expect(sup.list()[0]?.state).toBe('healthy')
  })

  it('исчерпан лимит попыток → error, тумблер выключен, последняя сессия остаётся', async () => {
    const { sup, sessions, ptys } = setup()
    await sup.start('db-dev')
    for (let i = 0; i < 6; i++) {
      ptys.at(-1)?.emitExit(1)
      await adv(35_000) // больше максимального backoff
    }
    const view = sup.list()[0]
    expect(view?.state).toBe('error')
    expect(view?.error).toContain('падает')
    expect(ptys.length).toBe(6) // 1 старт + 5 рестартов
    expect(sessions.list()).toHaveLength(1) // последняя оставлена для диагностики
  })

  it('shared-порт: второй пресет → conflict; с force — переключение (docs/04 §3.2)', async () => {
    const { sup, ptys } = setup()
    await sup.start('db-dev')
    const res = await sup.start('db-stage')
    expect(res).toEqual({
      ok: false,
      reason: 'conflict',
      conflictPresetId: 'db-dev',
      conflictLabel: 'dev'
    })

    const forced = await sup.start('db-stage', { force: true })
    expect(forced).toEqual({ ok: true })
    const dev = sup.list().find((v) => v.presetId === 'db-dev')
    const stage = sup.list().find((v) => v.presetId === 'db-stage')
    expect(dev?.state).toBe('off')
    expect(stage?.state).toBe('probing')
    expect(ptys).toHaveLength(2)
  })

  it('порт занят чужим процессом → busy-port с подсказкой lsof, спавна нет', async () => {
    const { sup, ptys, setPortOpen } = setup({ lsof: 'postgres 123 user ... TCP :6432 (LISTEN)' })
    setPortOpen(true) // кто-то уже слушает
    const res = await sup.start('db-dev')
    expect(res.ok).toBe(false)
    if (!res.ok && res.reason === 'busy-port') {
      expect(res.hint).toContain('postgres 123')
    } else {
      expect.unreachable('ожидали busy-port')
    }
    expect(ptys).toHaveLength(0)
    expect(sup.list()[0]?.state).toBe('error')
  })

  it('stop: SIGTERM, состояние off, сессия убрана из реестра', async () => {
    const { sup, sessions, setPortOpen } = setup()
    await sup.start('db-dev')
    setPortOpen(true)
    await adv(600)

    const stopped = sup.stop('db-dev')
    await adv(100)
    await stopped
    expect(sup.list()[0]?.state).toBe('off')
    expect(sessions.list()).toHaveLength(0)
  })

  it('restartMarked (перелогин): включённые рестартуют, счётчик попыток сброшен', async () => {
    const { sup, ptys, setPortOpen } = setup()
    await sup.start('db-dev')
    setPortOpen(true)
    await adv(600)
    expect(sup.list()[0]?.state).toBe('healthy')

    const restarted = sup.restartMarked()
    await adv(100)
    await restarted
    expect(ptys).toHaveLength(2) // новая сессия
    expect(sup.list()[0]?.attempts).toBe(0)

    await adv(600)
    expect(sup.list()[0]?.state).toBe('healthy')
  })
})

describe('ProxySupervisor: SELECT 1 как health-check (FR-D3, M3)', () => {
  it('порт открыт, но база молчит → не healthy, а деградация с причиной', async () => {
    const { sup, setPortOpen, setDbOk } = setup({ sql: true })
    await sup.start('db-dev')
    setPortOpen(true)
    setDbOk(false)
    await adv(600)
    expect(sup.list()[0]?.state).toBe('probing') // готовности нет — ждём дальше

    await adv(31_000) // READY_TIMEOUT: дальше врать про «проверяю» нечестно
    const view = sup.list()[0]
    expect(view?.state).toBe('degraded')
    expect(view?.error).toContain('база не отвечает')
  })

  it('база отвечает → healthy, причина ошибки снята', async () => {
    const { sup, setPortOpen, setDbOk } = setup({ sql: true })
    await sup.start('db-dev')
    setPortOpen(true)
    setDbOk(false)
    await adv(31_000)
    expect(sup.list()[0]?.state).toBe('degraded')

    setDbOk(true)
    await adv(11_000)
    expect(sup.list()[0]).toMatchObject({ state: 'healthy', error: null })
  })

  it('здоровый туннель не дёргает базу на каждом TCP-probe (это соединение через Teleport)', async () => {
    const { sup, sqlProbes, setPortOpen } = setup({ sql: true })
    await sup.start('db-dev')
    setPortOpen(true)
    await adv(600)
    expect(sqlProbes).toHaveLength(1) // проверка готовности

    await adv(30_000) // три медленных probe'а по 10 с
    expect(sqlProbes).toHaveLength(1)

    await adv(31_000) // прошла минута
    expect(sqlProbes).toHaveLength(2)
  })

  it('здоровая база падает между probe’ами → degraded', async () => {
    const { sup, setPortOpen, setDbOk } = setup({ sql: true })
    await sup.start('db-dev')
    setPortOpen(true)
    await adv(600)
    expect(sup.list()[0]?.state).toBe('healthy')

    setDbOk(false)
    await adv(61_000)
    expect(sup.list()[0]?.state).toBe('degraded')
  })
})
