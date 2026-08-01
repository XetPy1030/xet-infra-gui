import { app, dialog, Menu, nativeImage, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import type { CertHealth } from '@core/domain/health'
import type { ProxyView } from '@core/domain/proxy'
import { ENV_IDS, type EnvId } from '@core/modules/teleport/types'
import type { AuthService } from '@core/services/AuthService'
import type { HealthMonitor } from '@core/services/HealthMonitor'
import type { KubeSessionResult, KubeService } from '@core/services/KubeService'
import type { ProxySupervisor } from '@core/services/ProxySupervisor'
import { isProxyOn } from '@shared/proxy'

interface TrayDeps {
  auth: AuthService
  supervisor: ProxySupervisor
  monitor: HealthMonitor
  kube: KubeService
  openWindow: () => void
}

/** Агрегированный статус → цвет иконки (docs/02 §2). */
function aggregate(deps: TrayDeps, cert: CertHealth | null): '🟢' | '🟡' | '🔴' | '⚪' {
  const status = deps.auth.getCached()
  const proxies = deps.supervisor.list()
  const anyOn = proxies.some((p) => isProxyOn(p.state))
  if (proxies.some((p) => p.state === 'error' || p.state === 'degraded')) return '🔴'
  if (status?.loggedIn && cert?.expired) return '🔴'
  if (!status?.loggedIn) return anyOn ? '🔴' : '⚪'
  if (cert?.warn) return '🟡'
  if (
    proxies.some((p) => ['starting', 'probing', 'awaiting_otp', 'restarting'].includes(p.state))
  )
    return '🟡'
  return '🟢'
}

const PROXY_LABELS: Record<ProxyView['state'], string> = {
  off: 'выкл',
  starting: 'запускается…',
  awaiting_otp: 'ждёт код',
  probing: 'проверка порта…',
  healthy: '● работает',
  degraded: 'деградация',
  restarting: 'рестарт…',
  error: 'ошибка'
}

const fmtRemaining = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return h > 0 ? `${h}ч ${m}м` : `${m}м`
}

/**
 * Menu bar (docs/02 §2, M1-вариант): цвет статуса — emoji-заголовок трея
 * (template-иконки — полировка M4), «popover» — нативное контекстное меню
 * с тумблерами прокси. Живёт без окна: сессии в main (FR-S2).
 */
export function createTray(deps: TrayDeps): Tray {
  const tray = new Tray(nativeImage.createEmpty())
  let cert: CertHealth | null = null

  const toggleProxy = async (view: ProxyView, wantOn: boolean): Promise<void> => {
    if (!wantOn) {
      await deps.supervisor.stop(view.presetId)
      return
    }
    if (view.dangerous) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: `Включить прокси «${view.label}» (PROD)?`,
        detail: 'Это боевая база. Тумблер станет красным.',
        buttons: ['Включить', 'Отмена'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return
    }
    const res = await deps.supervisor.start(view.presetId)
    if (res.ok) return
    if (res.reason === 'conflict') {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `Порт ${view.port} общий: выключить «${res.conflictLabel}» и включить «${view.label}»?`,
        buttons: ['Переключить', 'Отмена'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) await deps.supervisor.start(view.presetId, { force: true })
    } else if (res.reason === 'busy-port') {
      dialog.showErrorBox(`Порт ${view.port} занят`, res.hint)
    }
  }

  /**
   * Быстрое действие из popover (docs/02 §2): окно вперёд, ошибку — диалогом.
   * `confirmProd` — US-14: shell на боевом кластере только с подтверждением.
   */
  const runKubeAction = async (
    run: () => Promise<KubeSessionResult>,
    confirmProd?: string
  ): Promise<void> => {
    if (confirmProd !== undefined && deps.kube.state().env === 'prod') {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: `PROD: ${confirmProd}. Продолжить?`,
        detail: 'Это боевой кластер.',
        buttons: ['Продолжить', 'Отмена'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return
    }
    deps.openWindow()
    const res = await run()
    if (!res.ok) dialog.showErrorBox('Kubernetes', res.error)
  }

  const buildMenu = (): Menu => {
    const status = deps.auth.getCached()
    const items: MenuItemConstructorOptions[] = []

    items.push({
      label: status?.loggedIn
        ? `${status.username ?? ''} · серт: ${
            cert?.expired || cert?.remainingMs == null ? 'истёк' : fmtRemaining(cert.remainingMs)
          }`
        : 'Не залогинен',
      enabled: false
    })
    items.push({
      label: 'Перелогин',
      click: () => {
        deps.auth.login()
        deps.openWindow()
      }
    })
    items.push({ type: 'separator' })

    const proxies = deps.supervisor.list()
    const firstProxy = proxies[0]
    if (firstProxy) {
      items.push({ label: `DB PROXY (порт ${firstProxy.port})`, enabled: false })
      for (const view of proxies) {
        items.push({
          label: `${view.env === 'prod' ? '🔴 ' : ''}${view.label} — ${PROXY_LABELS[view.state]}`,
          type: 'checkbox',
          checked: isProxyOn(view.state),
          click: (item) => void toggleProxy(view, item.checked)
        })
      }
      items.push({ type: 'separator' })
    }

    // KUBE (docs/02 §2): окружение + быстрые действия по свежайшему поду (US-04)
    const kube = deps.kube.state()
    const mismatch = kube.currentCluster !== kube.cluster
    items.push({
      label: `KUBE: ${kube.cluster}${kube.switching ? ' — переключаю…' : mismatch ? ' (не активен)' : ''}`,
      enabled: false
    })
    items.push({
      label: 'Окружение',
      submenu: ENV_IDS.map((env) => ({
        label: env === 'prod' ? '🔴 prod' : env,
        type: 'radio' as const,
        checked: kube.env === env,
        click: () => void deps.kube.setEnv(env as EnvId)
      }))
    })
    for (const w of kube.workloads) {
      items.push({
        label: `Bash → ${w.title} (${kube.env})`,
        click: () =>
          void runKubeAction(
            () => deps.kube.bash({ env: kube.env, workloadId: w.id }),
            `bash в свежайший под «${w.title}»`
          )
      })
    }
    for (const w of kube.workloads) {
      items.push({
        label: `Логи → ${w.title} (${kube.env})`,
        click: () =>
          void runKubeAction(() => deps.kube.logs({ env: kube.env, workloadId: w.id }))
      })
    }
    items.push({ type: 'separator' })

    items.push({ label: 'Открыть окно', click: deps.openWindow })
    items.push({ label: 'Выход', click: () => app.quit() })
    return Menu.buildFromTemplate(items)
  }

  const refresh = (): void => {
    tray.setTitle(aggregate(deps, cert))
    tray.setToolTip('xet-infra-gui')
    tray.setContextMenu(buildMenu())
  }

  deps.supervisor.events.on('state', refresh)
  deps.auth.events.on('status', refresh)
  deps.kube.events.on('state', refresh)
  deps.monitor.events.on('update', (p) => {
    const changed =
      cert?.expired !== p.cert.expired ||
      cert?.warn !== p.cert.warn ||
      cert?.validUntil !== p.cert.validUntil
    cert = p.cert
    // отсчёт в подписи меню обновится при открытии; перерисовка — по фронтам
    if (changed) refresh()
  })

  refresh()
  return tray
}
