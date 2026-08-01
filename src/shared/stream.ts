/**
 * Дедупликация потока PTY при восстановлении xterm (docs/03 §6).
 *
 * Проблема: renderer сначала подписывается на `session/data` (копит живые чанки),
 * потом просит snapshot ring buffer — иначе между ними дыра. Но тогда «хвост»
 * снапшота и уже пойманные живые чанки пересекаются → двойной вывод.
 *
 * Решение — абсолютный watermark потока. Снапшот покрывает поток до offset
 * `cursor`; каждый живой чанк несёт `end` (offset своего конца). Функция режет
 * из чанка только то, что ещё правее watermark. Гарантия: без дыр и без дублей
 * независимо от гонки «подписка ↔ снапшот».
 */
export function replaySlice(
  written: number,
  chunk: { data: string; end: number }
): { text: string; written: number } | null {
  const { data, end } = chunk
  if (end <= written) return null // чанк целиком левее watermark — уже показан
  const start = end - data.length
  const text = start >= written ? data : data.slice(written - start)
  return { text, written: end }
}
