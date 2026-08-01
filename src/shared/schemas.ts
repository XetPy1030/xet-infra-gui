import { z } from 'zod'
import type { RpcMap } from './types'

const id = z.string().uuid()
const env = z.enum(['dev', 'stage', 'prod'])
/** Общая часть kube-действия: окружение + цель (workload и/или конкретный под). */
const kubeAction = z.object({
  env,
  workloadId: z.string().min(1).max(64).nullable(),
  pod: z.string().min(1).max(253).optional()
})

/** Валидация запросов на границе main (ADR-0005): мусор с renderer отбрасывается. */
export const rpcReqSchemas: { [K in keyof RpcMap]: z.ZodType } = {
  'app.bootstrap': z.undefined(),
  'auth.login': z.undefined(),
  'config.get': z.undefined(),
  'config.save': z.object({ text: z.string().max(1024 * 1024) }),
  'config.importFile': z.undefined(),
  'config.exportFile': z.undefined(),
  'config.relaunch': z.undefined(),
  'tsh.status': z.undefined(),
  'session.write': z.object({ id, data: z.string().max(64 * 1024) }),
  'session.resize': z.object({
    id,
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(1000)
  }),
  'session.stop': z.object({ id }),
  'session.snapshot': z.object({ id }),
  'session.ack': z.object({ id, upTo: z.number().int().min(0) }),
  'session.dispose': z.object({ id }),
  'session.setPaused': z.object({ id, paused: z.boolean() }),
  'proxy.list': z.undefined(),
  'proxy.start': z.object({ presetId: z.string().min(1).max(64), force: z.boolean().optional() }),
  'proxy.stop': z.object({ presetId: z.string().min(1).max(64) }),
  'creds.status': z.undefined(),
  'creds.save': z.object({
    password: z.string().max(1024).nullish(),
    totpSecret: z.string().max(1024).nullish()
  }),
  'mfa.enroll': z.undefined(),
  'kube.setEnv': z.object({ env }),
  'kube.pods': z.object({ env, force: z.boolean().optional() }),
  'kube.bash': kubeAction,
  'kube.logs': kubeAction.extend({
    tail: z.number().int().min(0).max(100_000).optional(),
    follow: z.boolean().optional()
  }),
  'kube.exec': kubeAction.extend({ command: z.string().min(1).max(8192) }),
  'kube.execPty': kubeAction.extend({ command: z.string().min(1).max(8192) })
}
