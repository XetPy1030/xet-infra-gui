import { useState } from 'react'
import type { CredSource } from '@shared/types'
import { rpc } from '../api'
import { useApp } from '../store'

const SOURCE_LABELS: Record<CredSource, string> = {
  keychain: 'Keychain',
  env: 'env (dev-фолбэк)',
  none: 'нет'
}

const sourceClass = (s: CredSource): string =>
  s === 'keychain' ? 'chip-green' : s === 'env' ? 'chip-yellow' : 'chip-red'

/**
 * Пароль и TOTP-секрет (ADR-0003): значения write-only — renderer никогда не
 * читает секреты, видит только их источник. Один и тот же блок нужен настройкам
 * и мастеру первого запуска, поэтому живёт отдельным компонентом.
 */
export function CredsForm(): React.JSX.Element {
  const { creds, mfaEnroll, setCreds, setActive, upsertSession } = useApp()
  const [password, setPassword] = useState('')
  const [totpSecret, setTotpSecret] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (req: {
    password?: string | null
    totpSecret?: string | null
  }): Promise<void> => {
    setSaving(true)
    try {
      const status = await rpc('creds.save', req)
      setCreds(status)
      setPassword('')
      setTotpSecret('')
    } finally {
      setSaving(false)
    }
  }

  const startEnroll = async (): Promise<void> => {
    const { session } = await rpc('mfa.enroll')
    upsertSession(session)
    setActive(session.id)
  }

  return (
    <>
      {creds && !creds.encryptionAvailable && (
        <div className="banner">
          safeStorage/Keychain недоступен — сохранение кредов не сработает, остаётся env-фолбэк.
        </div>
      )}

      <div className="settings-row">
        <span className="settings-label">Пароль Teleport</span>
        <span className={`chip ${sourceClass(creds?.password ?? 'none')}`}>
          {SOURCE_LABELS[creds?.password ?? 'none']}
        </span>
        <input
          type="password"
          placeholder="новый пароль"
          value={password}
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button disabled={saving || password.length === 0} onClick={() => void save({ password })}>
          В Keychain
        </button>
        <button
          disabled={saving || creds?.password !== 'keychain'}
          onClick={() => void save({ password: null })}
        >
          Удалить
        </button>
      </div>

      <div className="settings-row">
        <span className="settings-label">TOTP-секрет</span>
        <span className={`chip ${sourceClass(creds?.totpSecret ?? 'none')}`}>
          {SOURCE_LABELS[creds?.totpSecret ?? 'none']}
        </span>
        <input
          type="password"
          placeholder="base32-секрет (или мастер →)"
          value={totpSecret}
          autoComplete="off"
          onChange={(e) => setTotpSecret(e.target.value)}
        />
        <button
          disabled={saving || totpSecret.length === 0}
          onClick={() => void save({ totpSecret })}
        >
          В Keychain
        </button>
        <button
          disabled={saving || creds?.totpSecret !== 'keychain'}
          onClick={() => void save({ totpSecret: null })}
        >
          Удалить
        </button>
        <button className="primary" disabled={saving} onClick={() => void startEnroll()}>
          Создать TOTP-девайс
        </button>
      </div>

      {mfaEnroll && (
        <div className="settings-row settings-note">
          {mfaEnroll.phase === 'awaiting-existing' &&
            'Мастер: введи код СУЩЕСТВУЮЩЕГО девайса (G2FA) в терминале.'}
          {mfaEnroll.phase === 'secret-captured' && 'Мастер: секрет перехвачен…'}
          {mfaEnroll.phase === 'confirm-sent' && 'Мастер: подтверждающий код отправлен…'}
          {mfaEnroll.phase === 'done' && '✅ TOTP-девайс создан, секрет в Keychain.'}
          {mfaEnroll.phase === 'failed' && `❌ Мастер не справился: ${mfaEnroll.error ?? ''}`}
        </div>
      )}
    </>
  )
}
