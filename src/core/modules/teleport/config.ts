import { z } from 'zod'

/**
 * Секции конфига, которые вносит модуль Teleport (ADR-0006). Схема — источник
 * правды и для валидации, и для типов (types.ts выводит их через z.infer).
 *
 * Дефолтов «как у автора» здесь нет: приложение из коробки не знает ни одного
 * прокси, namespace'а и пресета — всё приходит из конфига пользователя.
 */

/** Окружение: у каждого свой kube-кластер и свои db-пресеты. */
export const envSchema = z.enum(['dev', 'stage', 'prod'])

export const teleportSectionSchema = z.object({
  /** `host:port` для `tsh login --proxy=`. */
  proxy: z.string().default(''),
  user: z.string().default(''),
  /** Имя root-кластера; пусто — берётся хост из proxy (resolveCluster). */
  cluster: z.string().default(''),
  /** null — автоопределение через login-shell. */
  tshPath: z.string().nullable().default(null),
  /** Кластер может предпочитать webauthn — для PTY-автоматизации нужен otp. */
  mfaMode: z.literal('otp').default('otp')
})

/** Пресет DB-туннеля: долгоживущий `tsh proxy db --tunnel`. */
export const dbPresetSchema = z.object({
  id: z.string().min(1),
  env: envSchema,
  /** Имя database service в Teleport (`tsh db ls`). */
  tunnel: z.string().min(1),
  dbUser: z.string().min(1),
  dbName: z.string().min(1),
  /** Локальный порт туннеля. */
  port: z.number().int().min(1).max(65535),
  /** Требует подтверждения включения в UI. */
  dangerous: z.boolean().default(false)
})

export const dbSectionSchema = z.object({
  /** shared — один локальный порт на все пресеты, включение = переключение. */
  portStrategy: z.enum(['shared', 'perEnv']).default('shared'),
  presets: z.array(dbPresetSchema).default([])
})

/**
 * Workload — логическая «служба» в namespace. Имена подов меняются от релиза
 * к релизу, поэтому сопоставление по ПРЕФИКСУ + исключениям (FR-K7).
 */
export const workloadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  podPrefix: z.string().min(1),
  /** Маркеры в имени, по которым под НЕ считается этим workload'ом. */
  podExclude: z.array(z.string().min(1)).default([]),
  container: z.string().min(1),
  /** Сверять container со spec.containers[] пода и подбирать похожий. */
  containerAutoDiscover: z.boolean().default(false)
})

export const kubeSectionSchema = z.object({
  namespace: z.string().default(''),
  /** Имена kube-кластеров Teleport по окружениям (`tsh kube ls`). */
  clusters: z
    .object({
      dev: z.string().default(''),
      stage: z.string().default(''),
      prod: z.string().default('')
    })
    .prefault({}),
  workloads: z.array(workloadSchema).default([]),
  /** Хвост по умолчанию для `kubectl logs --tail`. */
  logsTail: z.number().int().min(0).max(100_000).default(500)
})

/** Имя кластера в конфиге необязательно: по умолчанию — хост proxy без порта. */
export function resolveCluster(proxy: string, cluster: string): string {
  const explicit = cluster.trim()
  if (explicit !== '') return explicit
  return proxy.trim().split(':')[0] ?? ''
}
