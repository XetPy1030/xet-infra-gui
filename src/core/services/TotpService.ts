import { generateSync } from 'otplib'
import type { Clock } from '../ports/Clock'
import { systemClock } from '../ports/Clock'
import type { CredentialStore } from '../ports/CredentialStore'
import type { Logger } from '../ports/Logger'
import { noopLogger } from '../ports/Logger'

/**
 * Генерация TOTP-кодов из секрета собственного девайса приложения (ADR-0003).
 * otplib v13: epoch в секундах, base32-секрет, дефолты RFC 6238 (SHA1/30s/6 цифр).
 */
export class TotpService {
  constructor(
    private readonly creds: CredentialStore,
    private readonly clock: Clock = systemClock,
    private readonly logger: Logger = noopLogger
  ) {}

  async generate(): Promise<string | null> {
    const secret = await this.creds.getTotpSecret()
    if (!secret) return null
    return this.generateFrom(secret)
  }

  /** Код из произвольного секрета (мастер `tsh mfa add`: секрет ещё не в хранилище). */
  generateFrom(secret: string): string | null {
    try {
      return generateSync({
        strategy: 'totp',
        secret: secret.replace(/\s+/g, '').toUpperCase(),
        epoch: Math.floor(this.clock.now() / 1000)
      })
    } catch (e) {
      this.logger.warn('TOTP: не удалось сгенерировать код (кривой секрет?)', e)
      return null
    }
  }
}
