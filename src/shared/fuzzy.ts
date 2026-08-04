/**
 * Fuzzy-поиск палитры команд (docs/02 §4). Живёт в `shared`, а не в `core`:
 * фильтрация идёт на каждое нажатие клавиши в renderer, гонять её через IPC
 * незачем, а импортировать `@core/*` renderer не имеет права (ADR-0005).
 */

/** ё/е — одна буква для поиска: «перелогин» находится и с ё, и без. */
const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е')

/** Начало слова: сюда пользователь целится, когда набирает сокращение. */
const isBoundary = (text: string, i: number): boolean =>
  i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1] ?? '')

const START_BONUS = 8
const RUN_BONUS = 6
const CHAR_SCORE = 1
/**
 * Штраф за разрыв между совпавшими буквами. Без него «prod» одинаково хорошо
 * находится и в самом слове, и по кусочкам из ключевых слов (`proxy … dev`), и
 * «включить dev» встаёт выше «включить prod» — поймано на живом прогоне.
 */
const GAP_PENALTY = 0.5
const MAX_GAP = 20

/**
 * Один термин как подпоследовательность: жадно слева направо, с бонусами за
 * начало слова и за подряд идущие буквы. Жадность — осознанное упрощение:
 * оптимальный поиск здесь не окупается, каталог действий короткий.
 */
function matchTerm(term: string, text: string): number | null {
  let score = 0
  let i = 0
  let prevHit = -2
  for (const ch of term) {
    const found = text.indexOf(ch, i)
    if (found === -1) return null
    score += CHAR_SCORE
    if (isBoundary(text, found)) score += START_BONUS
    if (found === prevHit + 1) score += RUN_BONUS
    else if (prevHit >= 0) score -= Math.min(found - prevHit - 1, MAX_GAP) * GAP_PENALTY
    prevHit = found
    i = found + 1
  }
  return score
}

/**
 * Релевантность строки запросу; `null` — не подошла. Термины ищутся независимо
 * и в любом порядке («bash api» и «api bash» находят одно и то же), каждый
 * должен совпасть.
 */
function fuzzyScore(query: string, text: string): number | null {
  const terms = normalize(query).split(/\s+/).filter((t) => t.length > 0)
  const target = normalize(text)
  if (terms.length === 0) return 0

  let score = 0
  for (const term of terms) {
    const termScore = matchTerm(term, target)
    if (termScore === null) return null
    score += termScore
  }
  // при равном совпадении короткая подпись точнее: «SQL: dev» выше «SQL: prod-replica»
  return score - target.length * 0.01
}

/** Отфильтровать и отсортировать по релевантности; пустой запрос — всё как есть. */
export function fuzzyFilter<T>(query: string, items: T[], text: (item: T) => string): T[] {
  if (query.trim() === '') return items
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(query, text(item))
    if (score !== null) scored.push({ item, score })
  }
  // сортировка стабильная (ECMAScript): равные по score сохраняют порядок реестра
  return scored.sort((a, b) => b.score - a.score).map((x) => x.item)
}
