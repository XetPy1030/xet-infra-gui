import { stat } from 'node:fs/promises'
import type { FileStat } from '@core/ports/FileStat'

/** Размер файла для прогресса дампа: файла ещё нет — это не ошибка (FR-Q5). */
export class FsFileStat implements FileStat {
  async size(path: string): Promise<number | null> {
    try {
      return (await stat(path)).size
    } catch {
      return null
    }
  }
}
