import { stripAnsi } from '../util/ansi'

export type PromptKind = 'password' | 'otp'
export type PromptPhase = 'detected' | 'answered' | 'manual'

export interface PromptEvent {
  kind: PromptKind
  phase: PromptPhase
}

/** Источник ответов: password → CredentialStore, otp → TotpService. null = нет креда. */
export interface PromptResolver {
  resolve(kind: PromptKind): Promise<string | null>
}

export interface PromptPatterns {
  password: RegExp
  otp: RegExp
}

/** Каналы взаимодействия пайплайна с сессией (передаёт SessionManager). */
export interface PipelineIO {
  write(data: string): void
  onEvent(e: PromptEvent): void
}

const TAIL_MAX = 2048

/**
 * Chain of Responsibility над потоком PTY (ADR-0004): распознаёт промпты
 * аутентификации и отвечает автоматически; повторный промпт того же вида
 * (= кред отвергнут) уходит в ручной фолбэк.
 *
 * TODO(M1): повторная попытка OTP на границе следующего 30-сек окна до фолбэка.
 */
export class PromptPipeline {
  private tail = ''
  private autoAnswered = new Set<PromptKind>()
  private busy = false

  constructor(
    private readonly patterns: PromptPatterns,
    private readonly resolver: PromptResolver,
    private readonly io: PipelineIO
  ) {}

  feed(chunk: string): void {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-TAIL_MAX)
    this.scan()
  }

  private scan(): void {
    if (this.busy) return
    const kind = this.match()
    if (!kind) return
    this.tail = ''
    void this.handle(kind)
  }

  private match(): PromptKind | null {
    const t = this.tail.trimEnd()
    if (t.length === 0) return null
    if (this.patterns.password.test(t)) return 'password'
    if (this.patterns.otp.test(t)) return 'otp'
    return null
  }

  private async handle(kind: PromptKind): Promise<void> {
    this.busy = true
    try {
      this.io.onEvent({ kind, phase: 'detected' })
      if (this.autoAnswered.has(kind)) {
        // уже отвечали — второй промпт значит «не принято», не зацикливаемся
        this.io.onEvent({ kind, phase: 'manual' })
        return
      }
      // Источник креда может упасть (в M1 Keychain/safeStorage при закрытом
      // хранилище) — это не крэш пайплайна, а ручной фолбэк.
      let value: string | null
      try {
        value = await this.resolver.resolve(kind)
      } catch {
        value = null
      }
      if (value === null || value === '') {
        this.io.onEvent({ kind, phase: 'manual' })
        return
      }
      this.autoAnswered.add(kind)
      this.io.write(value + '\r')
      this.io.onEvent({ kind, phase: 'answered' })
    } finally {
      this.busy = false
      this.scan()
    }
  }
}
