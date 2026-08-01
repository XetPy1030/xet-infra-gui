import { z } from 'zod'
import {
  dbSectionSchema,
  kubeSectionSchema,
  teleportSectionSchema
} from '../modules/teleport/config'

/**
 * Конфиг приложения — сумма секций, которые вносят модули (ADR-0006). Сейчас
 * модуль один (teleport), поэтому все три секции приходят из него; появится
 * второй — добавит свою секцию сюда, схема остаётся единственной точкой правды.
 */
export const appConfigSchema = z.object({
  teleport: teleportSectionSchema.prefault({}),
  db: dbSectionSchema.prefault({}),
  kube: kubeSectionSchema.prefault({})
})

export type AppConfig = z.infer<typeof appConfigSchema>

/** Пустой конфиг: приложение стартует, но ничего не умеет до настройки. */
export const EMPTY_CONFIG: AppConfig = appConfigSchema.parse({})

export type ConfigParse = { ok: true; config: AppConfig } | { ok: false; error: string }

export function parseConfig(raw: unknown): ConfigParse {
  const parsed = appConfigSchema.safeParse(raw)
  if (parsed.success) return { ok: true, config: parsed.data }
  const error = parsed.error.issues
    .map((i) => `${i.path.join('.') || '<корень>'}: ${i.message}`)
    .join('\n')
  return { ok: false, error }
}

export function parseConfigText(text: string): ConfigParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `не разбирается как JSON: ${(e as Error).message}` }
  }
  return parseConfig(raw)
}

/** Канонический вид файла: то, что пишется на диск и отдаётся в экспорт. */
export function formatConfig(config: AppConfig): string {
  return JSON.stringify(config, null, 2) + '\n'
}

/**
 * Минимум, без которого не работает ни один сценарий: куда логиниться и кем.
 * false — UI показывает онбординг вместо пустых панелей.
 */
export function isConfigured(config: AppConfig): boolean {
  return config.teleport.proxy.trim() !== '' && config.teleport.user.trim() !== ''
}
