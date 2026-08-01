import type { CredentialStore, WritableCredentialStore } from '@core/ports/CredentialStore'

/**
 * Keychain — основной источник, env (XET_TELEPORT_*) — dev-фолбэк, чтобы
 * `npm run dev` из терминала работал без записи в Keychain. Запись — только
 * в основной (env read-only по смыслу).
 */
export class CompositeCredentialStore implements WritableCredentialStore {
  constructor(
    private readonly primary: WritableCredentialStore,
    private readonly fallback: CredentialStore
  ) {}

  async getPassword(): Promise<string | null> {
    return (await this.primary.getPassword()) ?? (await this.fallback.getPassword())
  }

  async getTotpSecret(): Promise<string | null> {
    return (await this.primary.getTotpSecret()) ?? (await this.fallback.getTotpSecret())
  }

  setPassword(value: string | null): Promise<void> {
    return this.primary.setPassword(value)
  }

  setTotpSecret(value: string | null): Promise<void> {
    return this.primary.setTotpSecret(value)
  }
}
