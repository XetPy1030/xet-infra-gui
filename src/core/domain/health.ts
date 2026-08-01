/** Здоровье сертификата (docs/04 §5): локальный отсчёт от valid_until. */
export interface CertHealth {
  /** ISO-строка истечения; null — не залогинен/tsh недоступен. */
  validUntil: string | null
  /** Осталось миллисекунд; null — не залогинен. Отрицательных не бывает (clamp 0). */
  remainingMs: number | null
  /** Меньше порога предупреждения (30 мин) — жёлтая иконка. */
  warn: boolean
  /** Истёк или сессии нет — требуется перелогин (auth/required). */
  expired: boolean
}

export const CERT_WARN_MS = 30 * 60 * 1000
