import type { SessionInfo } from '../../domain/session'
import { isAliveState } from '../../domain/session'
import type { WritableCredentialStore } from '../../ports/CredentialStore'
import type { Logger } from '../../ports/Logger'
import type { PipelineIO } from '../../services/PromptPipeline'
import type { SessionManager } from '../../services/SessionManager'
import type { TotpService } from '../../services/TotpService'
import { Emitter } from '../../util/Emitter'
import { stripAnsi } from '../../util/ansi'
import { MFA_ADD_PATTERNS, TOTP_SECRET_PATTERNS } from './prompts'
import type { TshClient } from './TshClient'

export type MfaEnrollPhase =
  /** tsh ждёт код СУЩЕСТВУЮЩЕГО девайса — пользователь вводит в терминале (G2FA). */
  | 'awaiting-existing'
  /** Секрет нового девайса перехвачен из вывода. */
  | 'secret-captured'
  /** Подтверждающий код нового девайса сгенерирован и отправлен. */
  | 'confirm-sent'
  /** Девайс зарегистрирован, секрет сохранён в Keychain. */
  | 'done'
  | 'failed'

export interface MfaEnrollEvents extends Record<string, unknown> {
  progress: { sessionId: string; phase: MfaEnrollPhase; error: string | null }
}

interface EnrollRun {
  tail: string
  scanned: string
  secret: string | null
  existingPrompted: boolean
  confirmSent: boolean
}

const TAIL_MAX = 512
const SCAN_MAX = 16 * 1024

/**
 * Мастер собственного TOTP-девайса приложения (docs/04 §4.2): PTY-сессия
 * `tsh mfa add --type TOTP` видна пользователю как обычный таб; сервис-watcher
 * парсит секрет из вывода, сам подтверждает код нового девайса и кладёт секрет
 * в Keychain. Единственный ручной шаг — код существующего девайса (G2FA).
 *
 * Секрет никогда не уходит в события/логи — только в CredentialStore.
 */
export class MfaEnrollService {
  readonly events = new Emitter<MfaEnrollEvents>()
  private sessionId: string | null = null
  private run: EnrollRun | null = null

  constructor(
    private readonly sessions: SessionManager,
    private readonly tsh: Pick<TshClient, 'mfaAddCommand'>,
    private readonly creds: WritableCredentialStore,
    private readonly totp: Pick<TotpService, 'generateFrom'>,
    private readonly logger: Logger,
    private readonly deviceName = 'xet-infra-gui'
  ) {
    this.sessions.events.on('state', ({ info }) => {
      if (info.id === this.sessionId && !isAliveState(info.state)) {
        this.onExit(info)
      }
    })
  }

  /** Запуск мастера; идемпотентен для живой сессии. */
  enroll(): SessionInfo {
    if (this.sessionId && this.sessions.isAlive(this.sessionId)) {
      const existing = this.sessions.snapshot(this.sessionId)
      if (existing) return existing.info
    }
    if (this.sessionId) this.sessions.remove(this.sessionId)

    const run: EnrollRun = {
      tail: '',
      scanned: '',
      secret: null,
      existingPrompted: false,
      confirmSent: false
    }
    const { title, cmd, args, sanitizeTerminalReports } = this.tsh.mfaAddCommand(this.deviceName)
    const info = this.sessions.start({ title, cmd, args, sanitizeTerminalReports }, (io) => ({
      feed: (chunk: string) => this.onChunk(run, io, chunk)
    }))
    this.sessionId = info.id
    this.run = run
    if (!isAliveState(info.state)) {
      // spawn упал синхронно — событие state прошло до присвоения sessionId
      this.onExit(info)
    }
    return info
  }

  private onChunk(run: EnrollRun, io: PipelineIO, chunk: string): void {
    const clean = stripAnsi(chunk)
    run.tail = (run.tail + clean).slice(-TAIL_MAX)
    run.scanned = (run.scanned + clean).slice(-SCAN_MAX)
    const tail = run.tail.trimEnd()

    // 1) секрет нового девайса из otpauth-URL / «Secret …»
    if (!run.secret) {
      for (const re of TOTP_SECRET_PATTERNS) {
        const m = re.exec(run.scanned)
        if (m?.[1]) {
          run.secret = m[1]
          this.emit('secret-captured')
          break
        }
      }
    }

    // 2) код существующего девайса — только руки пользователя
    if (!run.existingPrompted && MFA_ADD_PATTERNS.existing.test(tail)) {
      run.existingPrompted = true
      run.tail = ''
      io.onEvent({ kind: 'otp', phase: 'detected' })
      io.onEvent({ kind: 'otp', phase: 'manual' }) // сессия в awaiting_otp + баннер
      this.emit('awaiting-existing')
      return
    }

    // 3) подтверждающий код нового девайса — генерируем из перехваченного секрета
    if (!run.confirmSent && run.secret && MFA_ADD_PATTERNS.newDevice.test(tail)) {
      const code = this.totp.generateFrom(run.secret)
      if (!code) {
        this.logger.warn('mfa add: секрет перехвачен, но код не сгенерировался')
        io.onEvent({ kind: 'otp', phase: 'detected' })
        io.onEvent({ kind: 'otp', phase: 'manual' })
        return
      }
      run.confirmSent = true
      run.tail = ''
      io.onEvent({ kind: 'otp', phase: 'detected' })
      io.write(code + '\r')
      io.onEvent({ kind: 'otp', phase: 'answered' })
      this.emit('confirm-sent')
    }
  }

  private onExit(info: SessionInfo): void {
    const run = this.run
    if (!run) return
    this.run = null
    if (info.exitCode === 0 && run.secret) {
      void this.creds
        .setTotpSecret(run.secret)
        .then(() => {
          this.logger.info('mfa add: TOTP-девайс зарегистрирован, секрет в Keychain')
          this.emit('done')
        })
        .catch((e: unknown) => {
          this.logger.error('mfa add: секрет не сохранился в Keychain', e)
          this.emit('failed', 'Девайс создан, но секрет не сохранился — Keychain недоступен')
        })
    } else {
      this.emit(
        'failed',
        info.exitCode === 0
          ? 'tsh завершился, но секрет в выводе не найден — фикстуры промптов устарели?'
          : `tsh mfa add завершился с кодом ${String(info.exitCode)}`
      )
    }
  }

  private emit(phase: MfaEnrollPhase, error: string | null = null): void {
    if (!this.sessionId) return
    this.events.emit('progress', { sessionId: this.sessionId, phase, error })
  }
}
