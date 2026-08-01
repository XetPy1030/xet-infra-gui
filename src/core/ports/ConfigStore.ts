/**
 * Хранилище конфига (ADR-0004): отдаёт и принимает сырой текст, про схему не
 * знает — разбор и валидация живут в ConfigService.
 */
export interface ConfigStore {
  /** Путь к файлу — показывается в UI, чтобы конфиг можно было править руками. */
  readonly path: string
  /** null — файла ещё нет. */
  read(): string | null
  write(text: string): void
}
