import { z } from 'zod'
import {
  dbSectionSchema,
  kubeSectionSchema,
  sqlSectionSchema,
  teleportSectionSchema
} from '../modules/teleport/config'
import { uiSectionSchema } from './ui'

/**
 * Конфиг приложения — сумма секций: собственных (`ui`) и тех, что вносят модули
 * (ADR-0006). Модуль пока один (teleport); появится второй — добавит свою секцию
 * сюда, схема остаётся единственной точкой правды.
 */
export const appConfigSchema = z.object({
  teleport: teleportSectionSchema.prefault({}),
  db: dbSectionSchema.prefault({}),
  kube: kubeSectionSchema.prefault({}),
  sql: sqlSectionSchema.prefault({}),
  ui: uiSectionSchema.prefault({})
})

export type AppConfig = z.infer<typeof appConfigSchema>

/** Пустой конфиг: приложение стартует, но ничего не умеет до настройки. */
export const EMPTY_CONFIG: AppConfig = appConfigSchema.parse({})

/** Проблема схемы, привязанная к пути в JSON: редактор подсвечивает по нему строку. */
export interface ConfigIssue {
  /** `db.presets.0.port`; пусто — проблема самого файла (не разобрался JSON). */
  path: string
  message: string
}

export type ConfigParse =
  | { ok: true; config: AppConfig }
  | { ok: false; error: string; issues: ConfigIssue[] }

const describeIssues = (issues: ConfigIssue[]): string =>
  issues.map((i) => `${i.path || '<корень>'}: ${i.message}`).join('\n')

export function parseConfig(raw: unknown): ConfigParse {
  const parsed = appConfigSchema.safeParse(raw)
  if (parsed.success) return { ok: true, config: parsed.data }
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message
  }))
  return { ok: false, error: describeIssues(issues), issues }
}

export function parseConfigText(text: string): ConfigParse {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const message = `не разбирается как JSON: ${(e as Error).message}`
    return { ok: false, error: message, issues: [{ path: '', message }] }
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
