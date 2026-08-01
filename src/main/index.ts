import { app, BrowserWindow, powerMonitor } from 'electron'
import { AuthService } from '@core/services/AuthService'
import { ConfigService } from '@core/services/ConfigService'
import { HealthMonitor } from '@core/services/HealthMonitor'
import { KubeService } from '@core/services/KubeService'
import { PromptPipeline } from '@core/services/PromptPipeline'
import { ProxySupervisor } from '@core/services/ProxySupervisor'
import { SessionManager } from '@core/services/SessionManager'
import { TotpService } from '@core/services/TotpService'
import { MfaEnrollService } from '@core/modules/teleport/MfaEnrollService'
import { TELEPORT_PROMPT_PATTERNS } from '@core/modules/teleport/prompts'
import { resolveCluster } from '@core/modules/teleport/config'
import { TshClient } from '@core/modules/teleport/TshClient'
import type { TeleportConfig } from '@core/modules/teleport/types'
import type { CredSource, CredsStatus } from '@shared/types'
import { CompositeCredentialStore } from './adapters/CompositeCredentialStore'
import { ConsoleLogger } from './adapters/ConsoleLogger'
import { EnvCredentialStore } from './adapters/EnvCredentialStore'
import { ExecFileRunner } from './adapters/ExecFileRunner'
import { FileConfigStore, resolveConfigPath } from './adapters/FileConfigStore'
import { NetTcpProbe } from './adapters/NetTcpProbe'
import { NodePtyFactory } from './adapters/NodePtyFactory'
import { SafeStorageCredentialStore } from './adapters/SafeStorageCredentialStore'
import { resolveShellEnv, resolveTshPath, stripCredEnv } from './adapters/shellEnv'
import { createConfigBridge } from './ipc/configBridge'
import { registerIpc, wireEvents } from './ipc/router'
import { createTray } from './tray'
import { createMainWindow } from './windows'

// Один экземпляр: повторный запуск фокусирует существующее окно.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  const logger = new ConsoleLogger()
  await app.whenReady()

  // Composition root (ADR-0004): core собирается из адаптеров, ядро Electron не видит.
  const env = await resolveShellEnv(logger)
  const configStore = new FileConfigStore(resolveConfigPath(app.getPath('userData'), process.env))
  const configService = new ConfigService(configStore, logger)
  const config = configService.get()
  const tshPath = await resolveTshPath(env, config.teleport.tshPath, logger)
  const teleport: TeleportConfig = {
    ...config.teleport,
    cluster: resolveCluster(config.teleport.proxy, config.teleport.cluster),
    tshPath
  }
  logger.info(`конфиг: ${configStore.path}`)
  logger.info(`tsh: ${tshPath}`)

  // Дочерние процессы не наследуют XET_TELEPORT_* (секреты — не для чужих env)
  const childEnv = stripCredEnv(env)
  const runner = new ExecFileRunner(childEnv)
  const ptyFactory = new NodePtyFactory(childEnv)

  // Креды: Keychain (safeStorage) — основной, env — dev-фолбэк (ADR-0003)
  const keychain = new SafeStorageCredentialStore(app.getPath('userData'), logger)
  const envCreds = new EnvCredentialStore()
  const creds = new CompositeCredentialStore(keychain, envCreds)
  const totp = new TotpService(creds, undefined, logger)

  const sessions = new SessionManager(ptyFactory, logger)
  const tsh = new TshClient(runner, () => teleport, logger)
  const pipelineFactory = (io: ConstructorParameters<typeof PromptPipeline>[2]): PromptPipeline =>
    new PromptPipeline(
      TELEPORT_PROMPT_PATTERNS,
      { resolve: (kind) => (kind === 'password' ? creds.getPassword() : totp.generate()) },
      io
    )
  const auth = new AuthService(sessions, tsh, pipelineFactory)
  const supervisor = new ProxySupervisor(
    config.db.presets,
    sessions,
    tsh,
    new NetTcpProbe(),
    pipelineFactory,
    runner,
    logger
  )
  const monitor = new HealthMonitor(auth)
  const mfa = new MfaEnrollService(sessions, tsh, creds, totp, logger)
  const kube = new KubeService(() => config.kube, tsh, sessions, pipelineFactory, auth, logger)

  // Каскад после перелогина (docs/04 §6): прокси на свежий серт + внеочередной health
  auth.events.on('loggedIn', () => {
    void supervisor.restartMarked()
    monitor.checkNow()
  })

  const credSource = async (
    primary: () => Promise<string | null>,
    fallback: () => Promise<string | null>
  ): Promise<CredSource> =>
    (await primary()) !== null ? 'keychain' : (await fallback()) !== null ? 'env' : 'none'
  const credsStatus = async (): Promise<CredsStatus> => ({
    encryptionAvailable: keychain.available(),
    password: await credSource(
      () => keychain.getPassword(),
      () => envCreds.getPassword()
    ),
    totpSecret: await credSource(
      () => keychain.getTotpSecret(),
      () => envCreds.getTotpSecret()
    )
  })

  const deps = {
    sessions,
    auth,
    supervisor,
    monitor,
    mfa,
    kube,
    config: createConfigBridge(configService),
    creds: {
      status: credsStatus,
      save: async (req: { password?: string | null; totpSecret?: string | null }) => {
        if (req.password !== undefined) await creds.setPassword(req.password)
        if (req.totpSecret !== undefined) await creds.setTotpSecret(req.totpSecret)
        return credsStatus()
      }
    }
  }
  registerIpc(deps)
  wireEvents(deps)

  const openWindow = (): void => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    } else {
      createMainWindow()
    }
  }

  // Backpressure имеет смысл только при живом окне (иначе ack'ов не будет)
  const syncFlow = (): void => sessions.setFlowEnabled(BrowserWindow.getAllWindows().length > 0)
  app.on('browser-window-created', (_e, win) => {
    syncFlow()
    win.on('closed', syncFlow)
  })

  createTray({ auth, supervisor, monitor, kube, openWindow })
  createMainWindow()
  monitor.start()

  // Сон/пробуждение: серт мог протухнуть, туннели — умереть (docs/04 §5)
  powerMonitor.on('resume', () => {
    monitor.checkNow()
    supervisor.probeNow()
  })

  app.on('second-instance', openWindow)
  app.on('activate', openWindow)

  // Menu-bar-first (docs/02): закрытие окна не завершает приложение — живём в трее
  app.on('window-all-closed', () => {
    /* not quitting */
  })

  app.on('before-quit', () => {
    monitor.stop()
    supervisor.dispose()
    sessions.disposeAll()
  })
}
