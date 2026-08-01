import { z } from 'zod'
import type { Logger } from '../../ports/Logger'
import type { ProcessRunner, RunResult } from '../../ports/ProcessRunner'
import type { DbProxyPreset, TeleportConfig, TshStatus } from './types'

// `tsh status --format=json` — берём только нужное, остальное пропускаем (loose).
const activeSchema = z.looseObject({
  username: z.string(),
  cluster: z.string(),
  kubernetes_cluster: z.string().nullish(),
  valid_until: z.string().nullish()
})
const statusSchema = z.looseObject({
  active: activeSchema.nullish()
})

/** Общие параметры адресации контейнера для kubectl-команд. */
export interface KubeTarget {
  namespace: string
  pod: string
  container: string
}

/** Спека интерактивной tsh-команды для PTY (login, proxy db, mfa add). */
export interface TshPtyCommand {
  title: string
  cmd: string
  args: string[]
  sanitizeTerminalReports: boolean
}

/**
 * Facade над CLI tsh (ADR-0004): типизированные структурированные запросы через
 * ProcessRunner + JSON + zod. Интерактивные команды (login) отдаёт как спеки для PTY.
 */
export class TshClient {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly cfg: () => TeleportConfig,
    private readonly logger: Logger
  ) {}

  /**
   * null — tsh недоступен (не найден/таймаут); loggedIn:false — доступен, но сессии нет.
   */
  async status(): Promise<TshStatus | null> {
    const { tshPath } = this.cfg()
    const res = await this.runner.run(tshPath, ['status', '--format=json'], { timeoutMs: 10_000 })
    if (res.code === null) {
      this.logger.warn('tsh status: процесс не отработал', res.stderr)
      return null
    }
    const parsed = this.parseStatus(res.stdout)
    if (parsed) return parsed
    // ненулевой exit без валидного JSON — считаем «не залогинен» (Not logged in)
    return { loggedIn: false, username: null, cluster: null, kubeCluster: null, validUntil: null }
  }

  loginCommand(): TshPtyCommand {
    const c = this.cfg()
    return {
      title: 'tsh login',
      cmd: c.tshPath,
      args: [
        'login',
        `--proxy=${c.proxy}`,
        `--user=${c.user}`,
        `--mfa-mode=${c.mfaMode}`,
        c.cluster
      ],
      // login неинтерактивен → режем терминальные авто-ответы из ввода
      sanitizeTerminalReports: true
    }
  }

  /**
   * DB-прокси (docs/04 §3.2): `--tunnel` — клиенты без своей аутентификации,
   * `--mfa-mode=otp` — per-session MFA спросит OTP на старте (webauthn не
   * автоматизируется). Readiness по stdout не парсим — только TCP-probe порта.
   */
  proxyDbCommand(p: DbProxyPreset): TshPtyCommand {
    const c = this.cfg()
    return {
      title: `proxy: ${p.dbName}`,
      cmd: c.tshPath,
      args: [
        'proxy',
        'db',
        `--port=${p.port}`,
        `--db-user=${p.dbUser}`,
        `--db-name=${p.dbName}`,
        '--tunnel',
        `--mfa-mode=${c.mfaMode}`,
        p.tunnel
      ],
      // долгоживущий неинтерактивный процесс → тоже режем авто-ответы xterm
      sanitizeTerminalReports: true
    }
  }

  /**
   * Переключение kube-контекста (FR-K1): пишет kubeconfig, быстрый.
   * `--mfa-mode` поддерживают не все сборки tsh — на «unknown flag» повторяем без него.
   */
  async kubeLogin(cluster: string): Promise<RunResult> {
    const c = this.cfg()
    const res = await this.runner.run(
      c.tshPath,
      ['kube', 'login', `--mfa-mode=${c.mfaMode}`, cluster],
      { timeoutMs: 60_000 }
    )
    if (res.code !== 0 && /unknown (long )?flag|unexpected flag/i.test(res.stderr)) {
      this.logger.warn('tsh kube login: --mfa-mode не поддержан, повтор без флага')
      return this.runner.run(c.tshPath, ['kube', 'login', cluster], { timeoutMs: 60_000 })
    }
    return res
  }

  /** Сырой `kubectl get pods -o json`: разбор — в pods.ts (нужны маски workload'ов). */
  async getPodsRaw(namespace: string): Promise<RunResult> {
    const { tshPath } = this.cfg()
    return this.runner.run(
      tshPath,
      ['kubectl', 'get', 'pods', '-n', namespace, '-o', 'json'],
      { timeoutMs: 30_000 }
    )
  }

  /** One-shot команда в контейнере (FR-K5): без `-it`, через `sh -lc`. */
  async kubeExecOnce(t: KubeTarget, command: string, timeoutMs: number): Promise<RunResult> {
    const { tshPath } = this.cfg()
    return this.runner.run(tshPath, [...this.execArgs(t, false), 'sh', '-lc', command], {
      timeoutMs
    })
  }

  /**
   * Bash в контейнере (FR-K4): интерактивный PTY. Терминальные report-ответы
   * НЕ режем — внутри сессии они нужны программам (vim и т.п.), docs/03 §4.2.
   */
  kubeBashCommand(t: KubeTarget, title: string): TshPtyCommand {
    return {
      title,
      cmd: this.cfg().tshPath,
      args: [...this.execArgs(t, true), 'bash'],
      sanitizeTerminalReports: false
    }
  }

  /** One-shot команда, но в PTY: фолбэк, когда exec-канал упёрся в MFA (docs/04 §3.3). */
  kubeExecPtyCommand(t: KubeTarget, command: string, title: string): TshPtyCommand {
    return {
      title,
      cmd: this.cfg().tshPath,
      args: [...this.execArgs(t, false), 'sh', '-lc', command],
      // как и у логов: ответы терминала должны дойти до tsh
      sanitizeTerminalReports: false
    }
  }

  /**
   * Логи (FR-K6). Идут через PTY, а не через spawn: так бесплатно достаются
   * батчинг/backpressure/ring buffer SessionManager'а и автоответ на MFA-промпт,
   * который `kubectl logs` может выдать по политике кластера (docs/04 §3.3).
   *
   * `sanitizeTerminalReports: false` — жизненно важно: под PTY tsh сам опрашивает
   * терминал (`ESC]11;?`, `ESC[6n`) и ЖДЁТ ответа. Фильтр, который спасает stdin
   * auth-сессий от эха, здесь запирал поток намертво (поймано на живом кластере:
   * таб «работает», в буфере только два запроса и ни строчки логов).
   */
  kubeLogsCommand(
    t: KubeTarget,
    opts: { tail: number; follow: boolean },
    title: string
  ): TshPtyCommand {
    const args = ['kubectl', 'logs', t.pod, '-n', t.namespace, '-c', t.container]
    args.push(`--tail=${opts.tail}`)
    if (opts.follow) args.push('--follow')
    return { title, cmd: this.cfg().tshPath, args, sanitizeTerminalReports: false }
  }

  private execArgs(t: KubeTarget, interactive: boolean): string[] {
    const args = ['kubectl', 'exec']
    if (interactive) args.push('-it')
    args.push(t.pod, '-n', t.namespace, '-c', t.container, '--')
    return args
  }

  /**
   * Мастер TOTP-девайса приложения (docs/04 §4.2). Интерактив: код существующего
   * девайса пользователь вводит руками, дальше секрет парсится из вывода.
   */
  mfaAddCommand(deviceName: string): TshPtyCommand {
    const c = this.cfg()
    return {
      title: 'tsh mfa add',
      cmd: c.tshPath,
      args: ['mfa', 'add', '--type', 'TOTP', '--name', deviceName],
      sanitizeTerminalReports: true
    }
  }

  private parseStatus(stdout: string): TshStatus | null {
    try {
      const json: unknown = JSON.parse(stdout)
      const data = statusSchema.parse(json)
      const a = data.active
      if (!a) {
        return { loggedIn: false, username: null, cluster: null, kubeCluster: null, validUntil: null }
      }
      return {
        loggedIn: true,
        username: a.username,
        cluster: a.cluster,
        kubeCluster: a.kubernetes_cluster ?? null,
        validUntil: a.valid_until ?? null
      }
    } catch {
      return null
    }
  }
}
