/** Размер файла на диске: прогресс дампа считается по его росту (FR-Q5). */
export interface FileStat {
  /** null — файла ещё нет или он недоступен. */
  size(path: string): Promise<number | null>
}
