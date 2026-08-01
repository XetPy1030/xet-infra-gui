import { describe, expect, it } from 'vitest'
import { noopLogger } from '../../ports/Logger'
import type { PtyFactory, PtyHandle } from '../../ports/PtyFactory'
import { SessionManager } from '../../services/SessionManager'
import {
  MFA_ADD_EXISTING_PROMPT,
  MFA_ADD_NEW_PROMPT,
  MFA_ADD_SECRET_BLOCK,
  MFA_ADD_TEST_SECRET
} from './__fixtures__/tsh'
import type { MfaEnrollPhase } from './MfaEnrollService'
import { MfaEnrollService } from './MfaEnrollService'

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

class FakePty implements PtyHandle {
  written: string[] = []
  private dataCb: ((d: string) => void) | null = null
  private exitCb: ((e: { exitCode: number | null }) => void) | null = null
  write(d: string): void {
    this.written.push(d)
  }
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
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

function setup() {
  const pty = new FakePty()
  const factory: PtyFactory = { spawn: () => pty }
  const sessions = new SessionManager(factory, noopLogger)
  const saved: (string | null)[] = []
  const phases: MfaEnrollPhase[] = []
  const service = new MfaEnrollService(
    sessions,
    {
      mfaAddCommand: (name) => ({
        title: 'tsh mfa add',
        cmd: 'tsh',
        args: ['mfa', 'add', '--type', 'TOTP', '--name', name],
        sanitizeTerminalReports: true
      })
    },
    {
      getPassword: async () => null,
      getTotpSecret: async () => null,
      setPassword: async () => {},
      setTotpSecret: async (v) => {
        saved.push(v)
      }
    },
    { generateFrom: (s) => (s === MFA_ADD_TEST_SECRET ? '654321' : null) },
    noopLogger
  )
  service.events.on('progress', ({ phase }) => phases.push(phase))
  return { pty, sessions, service, saved, phases }
}

describe('MfaEnrollService × фикстуры tsh mfa add (не сверены вживую — NFR-7)', () => {
  it('полный флоу: ручной код G2FA → перехват секрета → авто-подтверждение → Keychain', async () => {
    const { pty, sessions, service, saved, phases } = setup()
    const info = service.enroll()

    // код существующего девайса — вручную; сессия в awaiting_otp
    pty.emitData(MFA_ADD_EXISTING_PROMPT)
    await tick()
    expect(phases).toEqual(['awaiting-existing'])
    expect(sessions.snapshot(info.id)?.info.state).toBe('awaiting_otp')
    expect(pty.written).toEqual([]) // сами НЕ отвечаем
    sessions.write(info.id, '111111\r') // пользователь ввёл код G2FA

    // tsh печатает QR-блок с секретом
    pty.emitData(MFA_ADD_SECRET_BLOCK)
    await tick()
    expect(phases).toContain('secret-captured')

    // подтверждающий код нового девайса — генерируем сами
    pty.emitData(MFA_ADD_NEW_PROMPT)
    await tick()
    expect(pty.written).toContain('654321\r')
    expect(phases).toContain('confirm-sent')

    pty.emitData('MFA device "xet-infra-gui" added.\r\n')
    pty.emitExit(0)
    await tick()
    expect(saved).toEqual([MFA_ADD_TEST_SECRET])
    expect(phases.at(-1)).toBe('done')
  })

  it('exit ≠ 0 → failed, секрет не сохраняется', async () => {
    const { pty, service, saved, phases } = setup()
    service.enroll()
    pty.emitData(MFA_ADD_EXISTING_PROMPT)
    await tick()
    pty.emitExit(1)
    await tick()
    expect(saved).toEqual([])
    expect(phases.at(-1)).toBe('failed')
  })

  it('секрет матчится и из «Secret key:»-строки (запасной паттерн)', async () => {
    const { pty, service, phases } = setup()
    service.enroll()
    pty.emitData(`  Secret key: ${MFA_ADD_TEST_SECRET}\r\n`)
    await tick()
    expect(phases).toContain('secret-captured')
  })
})
