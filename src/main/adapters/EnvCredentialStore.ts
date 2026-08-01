import type { CredentialStore } from '@core/ports/CredentialStore'

/**
 * Dev-фолбэк (M1: основной источник — Keychain/safeStorage): креды из переменных
 * окружения запускающего терминала.
 *   XET_TELEPORT_PASSWORD    — пароль Teleport
 *   XET_TELEPORT_TOTP_SECRET — base32-секрет TOTP-девайса приложения
 * В env дочерних процессов эти переменные НЕ передаются (stripCredEnv).
 */
export class EnvCredentialStore implements CredentialStore {
  async getPassword(): Promise<string | null> {
    return process.env.XET_TELEPORT_PASSWORD || null
  }

  async getTotpSecret(): Promise<string | null> {
    return process.env.XET_TELEPORT_TOTP_SECRET || null
  }
}
