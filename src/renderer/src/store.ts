import { create } from 'zustand'
import type {
  ActionReveal,
  CertHealth,
  ConfigState,
  CredsStatus,
  DumpTaskView,
  EventMap,
  EnvId,
  KubeSessionMeta,
  KubeStateView,
  PodsView,
  PromptKind,
  ProxyView,
  SessionInfo,
  SqlStateView,
  TshStatus,
  UiStateView
} from '@shared/types'
import { onEvent, rpc } from './api'

/** Что показывает главная область окна (docs/02 §3). */
export type MainView = 'pods' | 'sql' | 'session'

interface AppStore {
  bootstrapped: boolean
  /** Конфиг: null до bootstrap. `configured: false` → онбординг вместо панелей. */
  config: ConfigState | null
  status: TshStatus | null
  sessions: Record<string, SessionInfo>
  order: string[]
  activeId: string | null
  view: MainView
  kube: KubeStateView | null
  /**
   * Последний список подов: в сторе, а не в PodsPanel — уход на таб сессии не
   * должен стоить нового `get pods` (он ~2 с), панель дорисовывает по кэшу.
   */
  pods: ({ env: EnvId } & PodsView) | null
  /** kube-привязка сессии: под/контейнер + широкий workload для «переподключиться». */
  kubeSessions: Record<string, KubeSessionMeta>
  /** Последняя ошибка действия (kube, прокси, SQL) — баннером (docs/02 §7). */
  appError: { message: string; needsLogin: boolean } | null
  /** Оболочка: хоткеи, автозапуск, tsh; null до bootstrap. */
  ui: UiStateView | null
  /** Палитра команд ⌘K (docs/02 §4). */
  paletteOpen: boolean
  /** Панель настроек развёрнута (её же открывает действие «Настройки»). */
  settingsOpen: boolean
  /** Мастер первого запуска (FR-C2): открывается сам на пустом конфиге. */
  wizardOpen: boolean
  /** Активный ручной промпт (авто-ответ не сработал): подсказка в UI. */
  manualPrompt: { sessionId: string; kind: PromptKind } | null
  proxies: Record<string, ProxyView>
  proxyOrder: string[]
  health: CertHealth | null
  creds: CredsStatus | null
  mfaEnroll: EventMap['mfa/enroll'] | null
  /** Пресеты и лимиты SQL-консоли: статика конфига (null до bootstrap). */
  sql: SqlStateView | null
  /**
   * Выбранный туннель SQL-консоли и текст запроса живут в сторе, а не в панели:
   * уход на таб терминала и возврат не должны стирать набранное.
   */
  sqlPresetId: string | null
  sqlQuery: string
  /** Идущие и завершённые дампы по sessionId (FR-Q5). */
  dumps: Record<string, DumpTaskView>

  setConfig(config: ConfigState): void
  setStatus(status: TshStatus | null): void
  upsertSession(info: SessionInfo): void
  removeSession(id: string): void
  setActive(id: string | null): void
  setView(view: MainView): void
  setKube(kube: KubeStateView): void
  setPods(pods: AppStore['pods']): void
  setKubeSession(sessionId: string, meta: KubeSessionMeta | null): void
  setAppError(err: AppStore['appError']): void
  setUi(ui: UiStateView): void
  setPaletteOpen(open: boolean): void
  setSettingsOpen(open: boolean): void
  setWizardOpen(open: boolean): void
  /** Показать то, что сделало действие: раздел, таб сессии, пресет консоли. */
  applyReveal(reveal: ActionReveal): void
  setManualPrompt(p: AppStore['manualPrompt']): void
  upsertProxy(view: ProxyView): void
  setHealth(cert: CertHealth): void
  setCreds(creds: CredsStatus): void
  setMfaEnroll(p: AppStore['mfaEnroll']): void
  setSqlPreset(presetId: string): void
  setSqlQuery(query: string): void
  upsertDump(task: DumpTaskView): void
  applyBootstrap(data: {
    config: ConfigState
    status: TshStatus | null
    sessions: SessionInfo[]
    proxies: ProxyView[]
    kube: KubeStateView
    kubeSessions: KubeSessionMeta[]
    sql: SqlStateView
    dumps: DumpTaskView[]
    ui: UiStateView
  }): void
}

export const useApp = create<AppStore>((set) => ({
  bootstrapped: false,
  config: null,
  status: null,
  sessions: {},
  order: [],
  activeId: null,
  view: 'pods',
  kube: null,
  pods: null,
  kubeSessions: {},
  appError: null,
  ui: null,
  paletteOpen: false,
  settingsOpen: false,
  wizardOpen: false,
  manualPrompt: null,
  proxies: {},
  proxyOrder: [],
  health: null,
  creds: null,
  mfaEnroll: null,
  sql: null,
  sqlPresetId: null,
  sqlQuery: '',
  dumps: {},

  setConfig: (config) => set({ config }),
  setStatus: (status) => set({ status }),
  upsertSession: (info) =>
    set((s) => ({
      sessions: { ...s.sessions, [info.id]: info },
      order: s.order.includes(info.id) ? s.order : [...s.order, info.id],
      activeId: s.activeId ?? info.id,
      // промпт-подсказка гаснет, когда сессия ушла из awaiting
      manualPrompt:
        s.manualPrompt?.sessionId === info.id && !info.state.startsWith('awaiting')
          ? null
          : s.manualPrompt
    })),
  removeSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions }
      delete sessions[id]
      const order = s.order.filter((x) => x !== id)
      const kubeSessions = { ...s.kubeSessions }
      delete kubeSessions[id]
      const activeId = s.activeId === id ? (order.at(-1) ?? null) : s.activeId
      const dumps = { ...s.dumps }
      delete dumps[id] // задача дампа живёт ровно столько, сколько её таб
      return {
        sessions,
        order,
        activeId,
        kubeSessions,
        dumps,
        view: activeId === null && s.view === 'session' ? 'pods' : s.view,
        manualPrompt: s.manualPrompt?.sessionId === id ? null : s.manualPrompt
      }
    }),
  setActive: (activeId) => set(activeId ? { activeId, view: 'session' } : { activeId }),
  setView: (view) => set({ view }),
  setKube: (kube) => set({ kube }),
  setPods: (pods) => set({ pods }),
  setKubeSession: (sessionId, meta) =>
    set((s) => {
      const kubeSessions = { ...s.kubeSessions }
      if (meta) kubeSessions[sessionId] = meta
      else delete kubeSessions[sessionId]
      return { kubeSessions }
    }),
  setAppError: (appError) => set({ appError }),
  setUi: (ui) => set({ ui }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setWizardOpen: (wizardOpen) => set({ wizardOpen }),
  applyReveal: ({ view, sessionId, presetId }) =>
    set((s) => ({
      // сессия могла ещё не доехать событием — таб появится, когда придёт
      activeId: sessionId ?? s.activeId,
      sqlPresetId: presetId ?? s.sqlPresetId,
      view: view === 'settings' ? s.view : (view ?? s.view),
      settingsOpen: view === 'settings' ? true : s.settingsOpen,
      paletteOpen: false
    })),
  setManualPrompt: (manualPrompt) => set({ manualPrompt }),
  upsertProxy: (view) =>
    set((s) => ({
      proxies: { ...s.proxies, [view.presetId]: view },
      proxyOrder: s.proxyOrder.includes(view.presetId)
        ? s.proxyOrder
        : [...s.proxyOrder, view.presetId]
    })),
  setHealth: (health) => set({ health }),
  setCreds: (creds) => set({ creds }),
  setMfaEnroll: (mfaEnroll) => set({ mfaEnroll }),
  setSqlPreset: (sqlPresetId) => set({ sqlPresetId }),
  setSqlQuery: (sqlQuery) => set({ sqlQuery }),
  upsertDump: (task) => set((s) => ({ dumps: { ...s.dumps, [task.sessionId]: task } })),
  applyBootstrap: ({ config, status, sessions, proxies, kube, kubeSessions, sql, dumps, ui }) =>
    set(() => {
      const map: Record<string, SessionInfo> = {}
      for (const info of sessions) map[info.id] = info
      const order = sessions.map((x) => x.id)
      const proxyMap: Record<string, ProxyView> = {}
      for (const view of proxies) proxyMap[view.presetId] = view
      const kubeMap: Record<string, KubeSessionMeta> = {}
      for (const meta of kubeSessions) kubeMap[meta.sessionId] = meta
      const dumpMap: Record<string, DumpTaskView> = {}
      for (const task of dumps) dumpMap[task.sessionId] = task
      return {
        bootstrapped: true,
        config,
        status,
        sessions: map,
        order,
        activeId: order.at(-1) ?? null,
        proxies: proxyMap,
        proxyOrder: proxies.map((x) => x.presetId),
        kube,
        kubeSessions: kubeMap,
        sql,
        // первый пресет по умолчанию: раздел открывается сразу рабочим
        sqlPresetId: sql.targets[0]?.presetId ?? null,
        dumps: dumpMap,
        ui
      }
    })
}))

/** Подписки на события main — один раз при старте renderer'а. */
export function initApp(): void {
  onEvent('status/update', ({ status }) => useApp.getState().setStatus(status))
  onEvent('session/state', ({ info }) => useApp.getState().upsertSession(info))
  onEvent('session/removed', ({ id }) => useApp.getState().removeSession(id))
  onEvent('session/prompt', ({ id, kind, phase }) => {
    if (phase === 'manual') useApp.getState().setManualPrompt({ sessionId: id, kind })
  })
  onEvent('proxy/state', ({ view }) => useApp.getState().upsertProxy(view))
  onEvent('health/update', ({ cert }) => useApp.getState().setHealth(cert))
  onEvent('mfa/enroll', (p) => useApp.getState().setMfaEnroll(p))
  onEvent('kube/state', ({ view }) => useApp.getState().setKube(view))
  onEvent('kube/session', ({ sessionId, meta }) =>
    useApp.getState().setKubeSession(sessionId, meta)
  )
  onEvent('sql/dump', ({ task }) => useApp.getState().upsertDump(task))
  // действие запущено из трея или по глобальному хоткею — окно догоняет
  onEvent('ui/reveal', ({ reveal }) => useApp.getState().applyReveal(reveal))
  // Backpressure: чанки НЕактивных сессий renderer не рисует (они лягут в ring
  // buffer main'а) — подтверждаем сразу. Активную подтверждает TerminalView
  // после реального xterm.write; ack — абсолютный offset, дубли безвредны.
  onEvent('session/data', (p) => {
    if (useApp.getState().activeId !== p.id) {
      void rpc('session.ack', { id: p.id, upTo: p.end })
    }
  })
  void rpc('app.bootstrap').then((data) => useApp.getState().applyBootstrap(data))
  void rpc('creds.status').then((creds) => useApp.getState().setCreds(creds))
}
