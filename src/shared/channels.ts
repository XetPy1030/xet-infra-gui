import type { EventMap, RpcMap } from './types'

// Единственный файл, который бандлится в sandboxed preload: только константы,
// никаких runtime-зависимостей (import type — стирается).
export const RPC_CHANNELS = [
  'app.bootstrap',
  'auth.login',
  'config.get',
  'config.save',
  'config.importFile',
  'config.exportFile',
  'config.relaunch',
  'tsh.status',
  'session.write',
  'session.resize',
  'session.stop',
  'session.snapshot',
  'session.ack',
  'session.dispose',
  'session.setPaused',
  'proxy.list',
  'proxy.start',
  'proxy.stop',
  'creds.status',
  'creds.save',
  'mfa.enroll',
  'kube.setEnv',
  'kube.pods',
  'kube.bash',
  'kube.logs',
  'kube.exec',
  'kube.execPty'
] as const satisfies readonly (keyof RpcMap)[]

export const EVENT_CHANNELS = [
  'session/data',
  'session/state',
  'session/prompt',
  'session/removed',
  'status/update',
  'proxy/state',
  'health/update',
  'mfa/enroll',
  'kube/state',
  'kube/session'
] as const satisfies readonly (keyof EventMap)[]
