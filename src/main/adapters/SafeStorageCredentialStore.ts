import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { WritableCredentialStore } from '@core/ports/CredentialStore'
import type { Logger } from '@core/ports/Logger'

interface SecretsFile {
  /** base64(safeStorage.encryptString(...)) по ключу креды. */
  password?: string
  totpSecret?: string
}

/**
 * Keychain-хранилище кредов (ADR-0003): Electron safeStorage — ключ шифрования
 * в macOS Keychain, зашифрованные blob'ы в userData/secrets.bin. Не keytar
 * (мёртв/не поддерживается). Файл читается лениво на каждый get — внешнее
 * удаление/подмена не требует рестарта.
 */
export class SafeStorageCredentialStore implements WritableCredentialStore {
  private readonly file: string

  constructor(
    userDataDir: string,
    private readonly logger: Logger
  ) {
    this.file = join(userDataDir, 'secrets.bin')
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async getPassword(): Promise<string | null> {
    return this.get('password')
  }

  async getTotpSecret(): Promise<string | null> {
    return this.get('totpSecret')
  }

  async setPassword(value: string | null): Promise<void> {
    this.set('password', value)
  }

  async setTotpSecret(value: string | null): Promise<void> {
    this.set('totpSecret', value)
  }

  private get(key: keyof SecretsFile): string | null {
    if (!this.available()) return null
    const raw = this.load()[key]
    if (!raw) return null
    try {
      return safeStorage.decryptString(Buffer.from(raw, 'base64'))
    } catch (e) {
      // ключ Keychain сменился/blob побился — кред считаем отсутствующим
      this.logger.warn(`secrets.bin: не расшифровалась креда «${key}»`, e)
      return null
    }
  }

  private set(key: keyof SecretsFile, value: string | null): void {
    if (value !== null && !this.available()) {
      throw new Error('safeStorage недоступен — Keychain не отдал ключ шифрования')
    }
    const data = this.load()
    if (value === null) {
      delete data[key]
    } else {
      data[key] = safeStorage.encryptString(value).toString('base64')
    }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    chmodSync(this.file, 0o600) // writeFileSync не меняет mode существующего файла
  }

  private load(): SecretsFile {
    try {
      if (!existsSync(this.file)) return {}
      return JSON.parse(readFileSync(this.file, 'utf8')) as SecretsFile
    } catch (e) {
      this.logger.warn('secrets.bin не прочитался — начинаю с пустого', e)
      return {}
    }
  }
}
