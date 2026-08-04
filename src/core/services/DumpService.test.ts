import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProxyRunState, ProxyView } from '../domain/proxy'
import type { DbProxyPreset, DumpPreset } from '../modules/teleport/types'
import type { FileStat } from '../ports/FileStat'
import { noopLogger } from '../ports/Logger'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import { DumpService, type DumpTaskView } from './DumpService'
import { SessionManager } from './SessionManager'

const PRESETS: DbProxyPreset[] = [
  { id: 'db-dev', env: 'dev', tunnel: 'dev-postgres', dbUser: 'app', dbName: 'dev', port: 6432, dangerous: false }
]

const DUMPS: DumpPreset[] = [
  {
    id: 'dump-dev',
    title: 'pg_dump',
    command: 'pg_dump -U {dbUser} -h localhost -p {port} {dbName} > {file}',
    defaultFile: '{dbName}-{date}.sql'
  }
]

class FakePty implements PtyHandle {
  exitCb: ((e: { exitCode: number | null }) => void) | null = null
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
  onData(): void {}
  onExit(cb: (e: { exitCode: number | null }) => void): void {
    this.exitCb = cb
  }
}

/** 2026-08-01T12:00:00 по местному времени — опорное «сейчас» для {date}. */
const NOW = new Date(2026, 7, 1, 12).getTime()

function setup(state: ProxyRunState = 'healthy') {
  const spawns: { cmd: string; args: string[]; title: string }[] = []
  const ptys: FakePty[] = []
  const ptyFactory: PtyFactory = {
    spawn: (spec) => {
      spawns.push({ cmd: spec.cmd, args: spec.args, title: spec.title })
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    }
  }
  const sizes = new Map<string, number>()
  const files: FileStat = { size: async (path) => sizes.get(path) ?? null }
  const proxy: ProxyView = {
    presetId: 'db-dev',
    label: 'dev',
    env: 'dev',
    port: 6432,
    dangerous: false,
    on: state !== 'off',
    state,
    sessionId: null,
    attempts: 0,
    error: null
  }
  const sessions = new SessionManager(ptyFactory, noopLogger)
  const dumps = new DumpService(PRESETS, DUMPS, () => [proxy], sessions, files, noopLogger, {
    now: () => NOW
  })
  const progress: DumpTaskView[] = []
  const finished: DumpTaskView[] = []
  dumps.events.on('progress', ({ task }) => progress.push(task))
  dumps.events.on('finished', ({ task }) => finished.push(task))
  return { dumps, sessions, spawns, ptys, sizes, progress, finished }
}

describe('DumpService (FR-Q5)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
  })

  it('шаблон разворачивается и уходит через sh -lc (редирект в файл — работа шелла)', () => {
    const { dumps, spawns } = setup()
    const res = dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    expect(res.ok).toBe(true)
    expect(spawns[0]).toEqual({
      cmd: 'sh',
      args: ['-lc', 'pg_dump -U app -h localhost -p 6432 dev > /tmp/dev.sql'],
      title: 'pg_dump: dev'
    })
  })

  it('имя файла по умолчанию — из шаблона пресета', () => {
    const { dumps } = setup()
    expect(dumps.defaultFile('dump-dev', 'db-dev')).toBe('dev-2026-08-01.sql')
    expect(dumps.defaultFile('нет', 'db-dev')).toBeNull()
  })

  it('без поднятого туннеля не запускаемся', () => {
    const { dumps, spawns } = setup('off')
    expect(dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/d.sql' })).toMatchObject({
      ok: false,
      reason: 'no-tunnel'
    })
    expect(spawns).toEqual([])
  })

  it('прогресс — рост файла; событие только на изменение размера', async () => {
    const { dumps, sizes, progress } = setup()
    dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    sizes.set('/tmp/dev.sql', 1024)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    sizes.set('/tmp/dev.sql', 4096)
    await vi.advanceTimersByTimeAsync(1000)
    expect(progress.map((t) => t.bytes)).toEqual([0, 1024, 4096])
  })

  it('exit 0 → done с итоговым размером и уведомлением', async () => {
    const { dumps, ptys, sizes, finished } = setup()
    dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    sizes.set('/tmp/dev.sql', 2048)
    ptys[0]?.exitCb?.({ exitCode: 0 })
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(finished[0]).toMatchObject({ state: 'done', bytes: 2048, ms: 0, error: null })
  })

  it('ненулевой exit → failed с указанием, где смотреть вывод', async () => {
    const { dumps, ptys, finished } = setup()
    dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    ptys[0]?.exitCb?.({ exitCode: 1 })
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(finished[0]?.state).toBe('failed')
    expect(finished[0]?.error).toMatch(/кодом 1/)
  })

  it('таймер прогресса гаснет, когда бегущих задач не осталось', async () => {
    const { dumps, ptys, sizes, progress, finished } = setup()
    dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    ptys[0]?.exitCb?.({ exitCode: 0 })
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    const seen = progress.length
    sizes.set('/tmp/dev.sql', 9999)
    await vi.advanceTimersByTimeAsync(5000)
    expect(progress).toHaveLength(seen)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('закрыли таб — задача ушла вместе с сессией', async () => {
    const { dumps, sessions, ptys, finished } = setup()
    const res = dumps.start({ dumpId: 'dump-dev', presetId: 'db-dev', file: '/tmp/dev.sql' })
    if (!res.ok) throw new Error('не стартовала')
    ptys[0]?.exitCb?.({ exitCode: 0 })
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    sessions.remove(res.session.id)
    expect(dumps.list()).toEqual([])
  })
})
