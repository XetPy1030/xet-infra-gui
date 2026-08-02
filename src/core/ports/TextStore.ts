/**
 * Файл с текстом за портом (ADR-0004): отдаёт и принимает сырой текст, про его
 * формат не знает — разбор живёт в сервисе-владельце. Потребители: конфиг
 * (ConfigService) и история SQL-запросов (SqlService).
 */
export interface TextStore {
  /** Путь к файлу — показывается в UI, чтобы файл можно было найти руками. */
  readonly path: string
  /** null — файла ещё нет. */
  read(): string | null
  write(text: string): void
}
