import { describe, expect, it } from 'vitest'
import { noopLogger } from '../../ports/Logger'
import type { ProcessRunner, RunResult } from '../../ports/ProcessRunner'
import {
  STATUS_JSON_LOGGED_IN,
  STATUS_NOT_LOGGED_IN_STDERR
} from './__fixtures__/tsh'
import { TshClient } from './TshClient'
import type { TeleportConfig } from './types'

const cfg: TeleportConfig = {
  proxy: 'teleport.example.com:443',
  user: 'user@example.com',
  cluster: 'teleport.example.com',
  tshPath: '/usr/local/bin/tsh',
  mfaMode: 'otp'
}

const runner = (result: RunResult): ProcessRunner => ({ run: async () => result })

describe('TshClient.status', () => {
  it('парсит реальный status JSON (фикстура 17.0.4)', async () => {
    const client = new TshClient(
      runner({ stdout: STATUS_JSON_LOGGED_IN, stderr: '', code: 0 }),
      () => cfg,
      noopLogger
    )
    const s = await client.status()
    expect(s).toEqual({
      loggedIn: true,
      username: 'user@example.com',
      cluster: 'teleport.example.com',
      kubeCluster: 'stage-k8s-cluster',
      validUntil: '2026-07-29T04:27:47+04:00'
    })
  })

  it('не залогинен (exit 1, мусор вместо JSON) → loggedIn: false', async () => {
    const client = new TshClient(
      runner({ stdout: '', stderr: STATUS_NOT_LOGGED_IN_STDERR, code: 1 }),
      () => cfg,
      noopLogger
    )
    const s = await client.status()
    expect(s?.loggedIn).toBe(false)
  })

  it('tsh не запустился (code null) → null', async () => {
    const client = new TshClient(
      runner({ stdout: '', stderr: 'ENOENT', code: null }),
      () => cfg,
      noopLogger
    )
    expect(await client.status()).toBeNull()
  })
})

describe('TshClient.loginCommand', () => {
  it('собирает команду с --mfa-mode=otp (webauthn не автоматизируется)', () => {
    const client = new TshClient(runner({ stdout: '', stderr: '', code: 0 }), () => cfg, noopLogger)
    expect(client.loginCommand()).toEqual({
      title: 'tsh login',
      cmd: '/usr/local/bin/tsh',
      args: [
        'login',
        '--proxy=teleport.example.com:443',
        '--user=user@example.com',
        '--mfa-mode=otp',
        'teleport.example.com'
      ],
      sanitizeTerminalReports: true
    })
  })
})

describe('TshClient.proxyDbCommand', () => {
  it('дословно команда из docs/04 §3.2: --tunnel + --mfa-mode=otp + имя сервиса позиционным', () => {
    const client = new TshClient(runner({ stdout: '', stderr: '', code: 0 }), () => cfg, noopLogger)
    expect(
      client.proxyDbCommand({
        id: 'db-dev',
        env: 'dev',
        tunnel: 'dev-postgres',
        dbUser: 'app',
        dbName: 'dev',
        port: 6432,
        dangerous: false
      })
    ).toEqual({
      title: 'proxy: dev',
      cmd: '/usr/local/bin/tsh',
      args: [
        'proxy',
        'db',
        '--port=6432',
        '--db-user=app',
        '--db-name=dev',
        '--tunnel',
        '--mfa-mode=otp',
        'dev-postgres'
      ],
      sanitizeTerminalReports: true
    })
  })
})

describe('TshClient.mfaAddCommand', () => {
  it('регистрация TOTP-девайса приложения (docs/04 §4.2)', () => {
    const client = new TshClient(runner({ stdout: '', stderr: '', code: 0 }), () => cfg, noopLogger)
    const c = client.mfaAddCommand('xet-infra-gui')
    expect(c.args).toEqual(['mfa', 'add', '--type', 'TOTP', '--name', 'xet-infra-gui'])
    expect(c.sanitizeTerminalReports).toBe(true)
  })
})

describe('TshClient: kube-команды в PTY', () => {
  const target = { namespace: 'apps', pod: 'api-x', container: 'api' }
  const client = (): TshClient =>
    new TshClient(runner({ stdout: '', stderr: '', code: 0 }), () => cfg, noopLogger)

  it('логи: --tail и --follow дословно', () => {
    const c = client().kubeLogsCommand(target, { tail: 500, follow: true }, 'логи')
    expect(c.args).toEqual([
      'kubectl',
      'logs',
      'api-x',
      '-n',
      'apps',
      '-c',
      'api',
      '--tail=500',
      '--follow'
    ])
  })

  it('фильтр ответов терминала выключен: tsh под PTY ждёт ответа на ESC]11;? / ESC[6n', () => {
    // с фильтром поток запирался намертво — таб «работает», логов нет (живой прогон)
    expect(client().kubeLogsCommand(target, { tail: 10, follow: true }, 'логи')
      .sanitizeTerminalReports).toBe(false)
    expect(client().kubeBashCommand(target, 'bash').sanitizeTerminalReports).toBe(false)
    expect(client().kubeExecPtyCommand(target, 'ls', 'cmd').sanitizeTerminalReports).toBe(false)
  })
})
