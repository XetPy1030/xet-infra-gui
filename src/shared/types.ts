/**
 * IPC-контракт (ADR-0005): единственная точка правды для main/preload/renderer.
 * Только типы — runtime-схемы валидации в schemas.ts (используются main'ом),
 * списки каналов в channels.ts (используются preload'ом).
 */
import type { PromptKind, PromptPhase } from '@core/services/PromptPipeline'

export type { SessionInfo, SessionState } from '@core/domain/session'
export type { ProxyRunState, ProxyView } from '@core/domain/proxy'
export type { CertHealth } from '@core/domain/health'
export type { ConfigSaveResult, ConfigState } from '@core/services/ConfigService'
export type { EnvId, KubeWorkload, PodInfo, TshStatus } from '@core/modules/teleport/types'
export type { MfaEnrollPhase } from '@core/modules/teleport/MfaEnrollService'
export type { ProxyStartResult } from '@core/services/ProxySupervisor'
export type {
  KubeExecResult,
  KubeFail,
  KubeSessionMeta,
  KubeSessionResult,
  KubeStateView,
  PodsResult,
  PodsView
} from '@core/services/KubeService'
export type { PromptKind, PromptPhase }

import type { SessionInfo } from '@core/domain/session'
import type { ProxyView } from '@core/domain/proxy'
import type { CertHealth } from '@core/domain/health'
import type { ConfigSaveResult, ConfigState } from '@core/services/ConfigService'
import type { EnvId, TshStatus } from '@core/modules/teleport/types'
import type { MfaEnrollPhase } from '@core/modules/teleport/MfaEnrollService'
import type { ProxyStartResult } from '@core/services/ProxySupervisor'
import type {
  KubeExecResult,
  KubeSessionMeta,
  KubeSessionResult,
  KubeStateView,
  PodsResult
} from '@core/services/KubeService'

export interface SessionSnapshotDto {
  info: SessionInfo
  buffer: string
  /** Абсолютный offset конца буфера в потоке — watermark для дедупа живых чанков. */
  cursor: number
}

/** Откуда сейчас взялась бы креда. Значения самих кредов в renderer не ходят. */
export type CredSource = 'keychain' | 'env' | 'none'

export interface CredsStatus {
  /** false — safeStorage/Keychain недоступен, работает только env-фолбэк. */
  encryptionAvailable: boolean
  password: CredSource
  totpSecret: CredSource
}

/** Результат файловой операции с конфигом (диалог открытия/сохранения в main). */
export interface ConfigFileResult {
  status: 'ok' | 'canceled' | 'error'
  path: string | null
  error: string | null
}

/** Общий запрос kube-действия: под явно либо «свежайший под workload'а». */
export interface KubeActionReq {
  env: EnvId
  /** null — под выбран вручную вне масок конфига (группа «прочее»). */
  workloadId: string | null
  /** Имя пода; без него берётся свежайший под workload'а (PodSelector). */
  pod?: string
}

/** RPC: renderer → main (ipcRenderer.invoke). */
export interface RpcMap {
  'app.bootstrap': {
    req: void
    res: {
      config: ConfigState
      status: TshStatus | null
      sessions: SessionInfo[]
      proxies: ProxyView[]
      kube: KubeStateView
      kubeSessions: KubeSessionMeta[]
    }
  }
  'auth.login': { req: void; res: { session: SessionInfo } }
  'config.get': { req: void; res: ConfigState }
  /** Сохранение валидирует схемой; применяется после перезапуска (config.relaunch). */
  'config.save': { req: { text: string }; res: ConfigSaveResult }
  'config.importFile': { req: void; res: ConfigFileResult }
  'config.exportFile': { req: void; res: ConfigFileResult }
  'config.relaunch': { req: void; res: void }
  'tsh.status': { req: void; res: TshStatus | null }
  'session.write': { req: { id: string; data: string }; res: void }
  'session.resize': { req: { id: string; cols: number; rows: number }; res: void }
  'session.stop': { req: { id: string }; res: void }
  'session.snapshot': { req: { id: string }; res: SessionSnapshotDto | null }
  /** Подтверждение переваренного вывода — абсолютный offset (backpressure). */
  'session.ack': { req: { id: string; upTo: number }; res: void }
  /** Убрать завершённую сессию из реестра (закрытие таба). */
  'session.dispose': { req: { id: string }; res: void }
  /** Пауза потока сессии по кнопке (follow-логи). */
  'session.setPaused': { req: { id: string; paused: boolean }; res: void }
  'proxy.list': { req: void; res: ProxyView[] }
  'proxy.start': { req: { presetId: string; force?: boolean }; res: ProxyStartResult }
  'proxy.stop': { req: { presetId: string }; res: void }
  'creds.status': { req: void; res: CredsStatus }
  /** null — удалить креду; undefined — не трогать. Write-only: значения назад не ходят. */
  'creds.save': {
    req: { password?: string | null; totpSecret?: string | null }
    res: CredsStatus
  }
  'mfa.enroll': { req: void; res: { session: SessionInfo } }
  'kube.setEnv': { req: { env: EnvId }; res: KubeStateView }
  /** `force` — «Обновить» руками: игнорирует кэш списка в KubeService. */
  'kube.pods': { req: { env: EnvId; force?: boolean }; res: PodsResult }
  'kube.bash': { req: KubeActionReq; res: KubeSessionResult }
  'kube.logs': { req: KubeActionReq & { tail?: number; follow?: boolean }; res: KubeSessionResult }
  'kube.exec': { req: KubeActionReq & { command: string }; res: KubeExecResult }
  /** Тот же one-shot, но PTY-табом — фолбэк при per-session MFA. */
  'kube.execPty': { req: KubeActionReq & { command: string }; res: KubeSessionResult }
}

/** События: main → renderer (webContents.send). */
export interface EventMap {
  'session/data': { id: string; data: string; end: number }
  'session/state': { info: SessionInfo }
  'session/prompt': { id: string; kind: PromptKind; phase: PromptPhase }
  'session/removed': { id: string }
  'status/update': { status: TshStatus | null }
  'proxy/state': { view: ProxyView }
  'health/update': { cert: CertHealth }
  'mfa/enroll': { sessionId: string; phase: MfaEnrollPhase; error: string | null }
  'kube/state': { view: KubeStateView }
  /** meta: null — kube-сессия ушла из реестра. */
  'kube/session': { sessionId: string; meta: KubeSessionMeta | null }
}
