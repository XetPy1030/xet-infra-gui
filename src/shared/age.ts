/**
 * Age в стиле kubectl (docs/04 §3.3): `45s`, `3m12s`, `3h29m`, `6d1h`, `412d`.
 * Портирован с `k8s.io/apimachinery/pkg/util/duration.HumanDuration`, чтобы
 * колонка AGE совпадала с той, что пользователь видит в терминале.
 */
export function humanAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 0) return '0s'
  if (seconds < 120) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 10) {
    const s = seconds % 60
    return s === 0 ? `${minutes}m` : `${minutes}m${s}s`
  }
  if (minutes < 180) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 8) {
    const m = minutes % 60
    return m === 0 ? `${hours}h` : `${hours}h${m}m`
  }
  if (hours < 48) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (hours < 24 * 8) {
    const h = hours % 24
    return h === 0 ? `${days}d` : `${days}d${h}h`
  }
  if (days < 365 * 2) return `${days}d`

  const years = Math.floor(days / 365)
  const restDays = days % 365
  return restDays === 0 ? `${years}y` : `${years}y${Math.floor(restDays / 30)}d`
}

/** Age пода от ISO-таймстампа; null/мусор → «—». */
export function ageOf(iso: string | null, now: number): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return '—'
  return humanAge(now - ts)
}
