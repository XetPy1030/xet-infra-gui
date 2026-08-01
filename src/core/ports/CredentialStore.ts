/**
 * Порт источника кредов (FR-A2): M1 — Keychain через safeStorage с env-фолбэком,
 * в будущем — удалённый API. null = креда нет → ручной фолбэк в PromptPipeline.
 */
export interface CredentialStore {
  getPassword(): Promise<string | null>
  getTotpSecret(): Promise<string | null>
}

/** Хранилище с записью (Keychain): null = удалить креду. */
export interface WritableCredentialStore extends CredentialStore {
  setPassword(value: string | null): Promise<void>
  setTotpSecret(value: string | null): Promise<void>
}
