import { describe, expect, it } from 'vitest'
import type { SessionSpec } from '../domain/session'
import { noopLogger } from '../ports/Logger'
import type { PtyFactory, PtyHandle } from '../ports/PtyFactory'
import {
  OTP_PROMPT,
  PASSWORD_PROMPT
} from '../modules/teleport/__fixtures__/tsh'
import { TELEPORT_PROMPT_PATTERNS } from '../modules/teleport/prompts'
import { PromptPipeline } from './PromptPipeline'
import { SessionManager } from './SessionManager'

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakePty implements PtyHandle {
  written: string[] = []
  killed: string | undefined
  pausedNow = false
  pauseCalls = 0
  resumeCalls = 0
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number | null }) => void) | null = null

  write(data: string): void {
    this.written.push(data)
  }
  resize(): void {}
  pause(): void {
    this.pausedNow = true
    this.pauseCalls++
  }
  resume(): void {
    this.pausedNow = false
    this.resumeCalls++
  }
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void {
    this.killed = signal ?? 'SIGTERM'
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
    this.exitCb?.({ exitCode: code })
  }
}

function setup(
  creds: { password: string | null; otp: string | null },
  specOverrides: Partial<SessionSpec> = {}
) {
  const pty = new FakePty()
  const factory: PtyFactory = { spawn: () => pty }
  const manager = new SessionManager(factory, noopLogger)
  const states: string[] = []
  const dataEvents: string[] = []
  manager.events.on('state', ({ info }) => states.push(info.state))
  manager.events.on('data', ({ data }) => dataEvents.push(data))
  const spec: SessionSpec = { title: 'tsh login', cmd: 'tsh', args: ['login'], ...specOverrides }
  const info = manager.start(spec, (io) =>
    new PromptPipeline(
      TELEPORT_PROMPT_PATTERNS,
      { resolve: async (k) => (k === 'password' ? creds.password : creds.otp) },
      io
    )
  )
  return { pty, manager, states, dataEvents, info }
}

describe('SessionManager', () => {
  it('полный login-флоу: промпты → авто-ответы → exit 0 → exited', async () => {
    const { pty, states } = setup({ password: 'p@ss', otp: '123456' })

    pty.emitData(PASSWORD_PROMPT)
    await tick()
    expect(pty.written).toEqual(['p@ss\r'])

    pty.emitData('\r\n' + OTP_PROMPT)
    await tick()
    expect(pty.written).toEqual(['p@ss\r', '123456\r'])

    pty.emitData('\r\n> Profile URL: https://teleport.example.com:443\r\n')
    pty.emitExit(0)
    await tick()

    expect(states).toEqual([
      'spawning',
      'awaiting_password',
      'running',
      'awaiting_otp',
      'running',
      'exited'
    ])
  })

  it('сессия без промптов: первый вывод → running (kube exec/логи, docs/03 §4.2)', async () => {
    const { pty, states } = setup({ password: null, otp: null })
    pty.emitData('строка лога\r\n')
    await tick()
    expect(states).toEqual(['spawning', 'running'])
  })

  it('нумерация потока: data.end растёт, snapshot.cursor = произведено', async () => {
    const { pty, manager, info } = setup({ password: null, otp: null })
    const ends: number[] = []
    manager.events.on('data', ({ end }) => ends.push(end))

    pty.emitData('abc')
    await tick(30)
    pty.emitData('de')
    await tick(30)

    expect(ends).toEqual([3, 5]) // offset конца каждого батча
    const snap = manager.snapshot(info.id)
    expect(snap?.cursor).toBe(5)
    expect(snap?.buffer).toBe('abcde')
  })

  it('батчинг: несколько чанков в окне → одно data-событие', async () => {
    const { pty, dataEvents } = setup({ password: null, otp: null })
    pty.emitData('a')
    pty.emitData('b')
    pty.emitData('c')
    expect(dataEvents).toEqual([])
    await tick(30)
    expect(dataEvents).toEqual(['abc'])
  })

  it('ручной фолбэк: ввод с Enter выводит из awaiting_*', async () => {
    const { pty, manager, states, info } = setup({ password: null, otp: null })
    pty.emitData(PASSWORD_PROMPT)
    await tick()
    expect(states.at(-1)).toBe('awaiting_password')

    manager.write(info.id, 'вручную\r')
    expect(states.at(-1)).toBe('running')
    expect(pty.written).toEqual(['вручную\r'])
  })

  it('ненулевой exit → failed; снапшот отдаёт накопленный буфер', async () => {
    const { pty, manager, states, info } = setup({ password: null, otp: null })
    pty.emitData('boom\r\n')
    pty.emitExit(1)
    await tick()
    expect(states.at(-1)).toBe('failed')
    expect(manager.isAlive(info.id)).toBe(false)
    expect(manager.snapshot(info.id)?.buffer).toBe('boom\r\n')
  })

  it('spawn-ошибка (tsh не найден) → failed сразу, без исключения', () => {
    const factory: PtyFactory = {
      spawn: () => {
        throw new Error('ENOENT: tsh not found')
      }
    }
    const manager = new SessionManager(factory, noopLogger)
    const info = manager.start({ title: 'x', cmd: 'tsh', args: [] })
    expect(info.state).toBe('failed')
    expect(manager.snapshot(info.id)?.buffer).toContain('ENOENT')
  })

  it('sanitizeTerminalReports: вырезает авто-ответы xterm, пропускает пароль', () => {
    const { pty, manager, info } = setup(
      { password: null, otp: null },
      { sanitizeTerminalReports: true }
    )
    // xterm авто-ответил на запросы tsh — это НЕ должно уйти в PTY
    manager.write(info.id, '\x1b]11;rgb:1212/1616/1c1c\x1b\\\x1b[1;1R')
    expect(pty.written).toEqual([])
    // реальный пароль пользователя проходит как есть
    manager.write(info.id, 'AkrOiD\r')
    expect(pty.written).toEqual(['AkrOiD\r'])
  })

  it('без флага sanitize ввод не трогается (интерактивный bash: стрелки нужны программе)', () => {
    const { pty, manager, info } = setup({ password: null, otp: null })
    manager.write(info.id, '\x1b[1;1R')
    expect(pty.written).toEqual(['\x1b[1;1R'])
  })

  it('stop шлёт SIGTERM', () => {
    const { pty, manager, info } = setup({ password: null, otp: null })
    manager.stop(info.id)
    expect(pty.killed).toBe('SIGTERM')
    pty.emitExit(143)
  })

  it('backpressure: хвост > HIGH без ack → pause; ack по watermark → resume', async () => {
    const { pty, manager, info } = setup({ password: null, otp: null })
    manager.setFlowEnabled(true)

    const big = 'x'.repeat(600 * 1024) // > FLOW_HIGH_WATER (512K)
    pty.emitData(big)
    await tick(30)
    expect(pty.pauseCalls).toBe(1)

    // ack абсолютным offset'ом (идемпотентен: повтор не ломает счёт)
    manager.ack(info.id, big.length)
    manager.ack(info.id, big.length)
    expect(pty.resumeCalls).toBe(1)
    expect(pty.pausedNow).toBe(false)
  })

  it('flow выключен (окна нет) → никаких pause; выключение будит пауженных', async () => {
    const { pty, manager } = setup({ password: null, otp: null })
    pty.emitData('y'.repeat(600 * 1024))
    await tick(30)
    expect(pty.pauseCalls).toBe(0) // по умолчанию flow выключен

    manager.setFlowEnabled(true)
    // включение стартует с чистого листа: старый хвост не считается долгом
    pty.emitData('z')
    await tick(30)
    expect(pty.pauseCalls).toBe(0)

    pty.emitData('w'.repeat(600 * 1024))
    await tick(30)
    expect(pty.pauseCalls).toBe(1)
    manager.setFlowEnabled(false) // окно закрылось — будим
    expect(pty.resumeCalls).toBe(1)
  })

  it('markHealth: running → healthy ⇄ degraded; в awaiting_* не лезет', async () => {
    const { pty, manager, states, info } = setup({ password: 'p', otp: null })
    manager.markHealth(info.id, 'healthy') // spawning — рано, игнор
    expect(states.at(-1)).toBe('spawning')

    pty.emitData('$ ') // первый вывод без промпта → running
    manager.write(info.id, 'run\r') // не awaiting → состояние не меняется
    await tick()
    expect(states.at(-1)).toBe('running')

    pty.emitData(PASSWORD_PROMPT)
    await tick()
    expect(states.at(-1)).toBe('running') // авто-ответ → снова running
    manager.markHealth(info.id, 'healthy')
    manager.markHealth(info.id, 'degraded')
    manager.markHealth(info.id, 'healthy')
    expect(states.slice(-3)).toEqual(['healthy', 'degraded', 'healthy'])
  })

  it('markHealth в awaiting_* игнорируется — health не сбивает auth-фазу', async () => {
    const { pty, manager, states, info } = setup({ password: null, otp: null })
    pty.emitData(PASSWORD_PROMPT) // кредов нет → ручной фолбэк, ждём ввода
    await tick()
    expect(states.at(-1)).toBe('awaiting_password')
    manager.markHealth(info.id, 'healthy')
    expect(states.at(-1)).toBe('awaiting_password')
  })

  it('remove: живую нельзя, завершённую можно; событие removed, реестр чистится', async () => {
    const { pty, manager, info } = setup({ password: null, otp: null })
    const removed: string[] = []
    manager.events.on('removed', ({ id }) => removed.push(id))

    expect(manager.remove(info.id)).toBe(false) // живая
    pty.emitExit(0)
    await tick()
    expect(manager.remove(info.id)).toBe(true)
    expect(removed).toEqual([info.id])
    expect(manager.list()).toEqual([])
    expect(manager.snapshot(info.id)).toBeNull()
  })
})
