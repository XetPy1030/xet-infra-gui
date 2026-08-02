const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

/**
 * Размер человеку (docs/06 §10): `2,4 МБ`, а не 2516582. Живёт в shared —
 * нужен и main'у (уведомление о дампе), и renderer'у (прогресс в панели).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace('.', ',')} ${UNITS[unit]}`
}
