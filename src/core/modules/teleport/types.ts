import type { z } from 'zod'
import type {
  dbPresetSchema,
  dumpPresetSchema,
  envSchema,
  kubeSectionSchema,
  sqlSectionSchema,
  workloadSchema
} from './config'

/**
 * Типы модуля Teleport. Всё, что приходит из конфига, выводится из его схем
 * (config.ts) — второго описания той же формы в проекте нет.
 */

/** Teleport-настройки после резолва: путь к tsh найден, имя кластера вычислено. */
export interface TeleportConfig {
  proxy: string
  user: string
  cluster: string
  /** Абсолютный путь к tsh либо «tsh» как последний шанс. */
  tshPath: string
  /** Кластер может предпочитать webauthn → для автоматизации всегда otp (docs/04 §4.1). */
  mfaMode: 'otp'
}

export type DbProxyPreset = z.infer<typeof dbPresetSchema>

/** Окружение: адресует и kube-кластер, и db-пресеты — отсюда нейтральное имя. */
export type EnvId = z.infer<typeof envSchema>

export const ENV_IDS: EnvId[] = ['dev', 'stage', 'prod']

export type KubeWorkload = z.infer<typeof workloadSchema>

export type KubeConfig = z.infer<typeof kubeSectionSchema>

export type SqlConfig = z.infer<typeof sqlSectionSchema>

export type DumpPreset = z.infer<typeof dumpPresetSchema>

/** Под из `kubectl get pods -o json` — только то, что нужно UI (docs/04 §3.3). */
export interface PodInfo {
  name: string
  phase: string
  readyCount: number
  totalCount: number
  restarts: number
  /** ISO; null — под ещё не стартовал (Pending). */
  startedAt: string | null
  /** ISO `metadata.creationTimestamp` — источник age. */
  createdAt: string | null
  containers: string[]
  /** id workload'а из конфига; null — «прочее» (под не под нашей маской). */
  workloadId: string | null
}

/** DTO статуса для UI (выжимка из `tsh status --format=json`). */
export interface TshStatus {
  loggedIn: boolean
  username: string | null
  cluster: string | null
  kubeCluster: string | null
  /** ISO-строка истечения сертификата; null, если не залогинен. */
  validUntil: string | null
}
