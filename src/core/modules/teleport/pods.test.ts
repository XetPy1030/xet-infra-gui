import { describe, expect, it } from 'vitest'
import {
  KUBE_NOW,
  PODS_JSON,
  PODS_JSON_RENAMED_CONTAINER,
  PODS_JSON_ROLLOUT
} from './__fixtures__/kube'
import {
  defaultContainer,
  matchWorkload,
  parsePods,
  resolveContainer,
  selectFreshest
} from './pods'
import type { KubeWorkload, PodInfo } from './types'

const API: KubeWorkload = {
  id: 'api',
  title: 'api',
  podPrefix: 'api-web-',
  podExclude: [],
  container: 'api',
  containerAutoDiscover: false
}
const AUTH: KubeWorkload = {
  id: 'auth',
  title: 'auth',
  podPrefix: 'auth-web-',
  podExclude: ['-worker-', '-cron-'],
  container: 'auth',
  containerAutoDiscover: true
}
const WORKLOADS = [API, AUTH]

const pods = (): PodInfo[] => {
  const parsed = parsePods(PODS_JSON, WORKLOADS)
  if (!parsed) throw new Error('фикстура не разобралась')
  return parsed
}

const byName = (name: string): PodInfo => {
  const p = pods().find((x) => x.name === name)
  if (!p) throw new Error(`нет пода ${name}`)
  return p
}

describe('parsePods', () => {
  it('разбирает вывод kubectl get pods -o json', () => {
    expect(pods()).toHaveLength(8)
    expect(byName('api-web-6d5c9f7b8-xpgt9')).toMatchObject({
      phase: 'Running',
      readyCount: 3,
      totalCount: 3,
      // рестарты суммируются по всем контейнерам пода
      restarts: 4,
      startedAt: '2026-07-31T15:44:40Z',
      createdAt: '2026-07-31T15:44:39Z',
      // порядок — как в spec: прокси-контейнер стоит перед приложением
      containers: ['edge-proxy', 'api', 'istio-proxy'],
      workloadId: 'api'
    })
  })

  it('Succeeded-под прошлого деплоя: не ready, но в списке', () => {
    expect(byName('portal-7854d47c9-dwbkv')).toMatchObject({
      phase: 'Succeeded',
      readyCount: 0,
      totalCount: 1,
      workloadId: null
    })
  })

  it('Pending без containerStatuses: totalCount из spec, ready 0', () => {
    const rollout = parsePods(PODS_JSON_ROLLOUT, WORKLOADS)
    expect(rollout?.[0]).toMatchObject({
      phase: 'Pending',
      readyCount: 0,
      totalCount: 1,
      startedAt: null
    })
  })

  it('исключения маски и посторонние поды → группа «прочее» (workloadId null)', () => {
    expect(byName('auth-web-cron-c478f8b56-49ggb').workloadId).toBeNull()
    expect(byName('auth-web-worker-86f5884bb9-cbmw2').workloadId).toBeNull()
    expect(byName('portal-7854d47c9-dwbkv').workloadId).toBeNull()
  })

  it('соседние релизы с похожими именами не попадают в workload', () => {
    // api-webhook свежее api-web — потеряй маска хвостовой дефис, «свежайший» уедет туда
    expect(byName('api-webhook-5f8b6c9d4-ffqn4').workloadId).toBeNull()
    expect(byName('api-cron-7c9448b75-r9jfj').workloadId).toBeNull()
  })

  it('не-JSON (например stderr вместо вывода) → null, а не «подов нет»', () => {
    expect(parsePods('ERROR: access denied', WORKLOADS)).toBeNull()
    expect(parsePods('', WORKLOADS)).toBeNull()
  })
})

describe('matchWorkload', () => {
  it('сопоставление по префиксу, исключения сильнее', () => {
    expect(matchWorkload('api-web-x-1', WORKLOADS)?.id).toBe('api')
    expect(matchWorkload('auth-web-x-1', WORKLOADS)?.id).toBe('auth')
    expect(matchWorkload('auth-web-worker-x-1', WORKLOADS)).toBeNull()
    expect(matchWorkload('other-pod', WORKLOADS)).toBeNull()
  })
})

describe('selectFreshest (PodSelector, docs/04 §3.3)', () => {
  it('api: свежайшая реплика своего релиза, мимо api-webhook и api-cron', () => {
    const p = selectFreshest(pods(), 'api')
    expect(p?.name).toBe('api-web-6d5c9f7b8-xpgt9')
    expect(KUBE_NOW - Date.parse(p?.startedAt ?? '')).toBeGreaterThan(0)
  })

  it('auth: cron/worker с тем же startTime исключены маской', () => {
    expect(selectFreshest(pods(), 'auth')?.name).toBe('auth-web-5bd75f8d6-f6zw7')
  })

  it('середина rollout: Pending и не-ready не годятся → null (UI скажет честно)', () => {
    const rollout = parsePods(PODS_JSON_ROLLOUT, WORKLOADS) ?? []
    expect(selectFreshest(rollout, 'api')).toBeNull()
    expect(selectFreshest(pods(), 'нет-такого')).toBeNull()
  })
})

describe('resolveContainer (containerAutoDiscover, docs/04 §2)', () => {
  it('точное совпадение с конфигом — берём его, sidecar не мешает', () => {
    expect(resolveContainer(byName('auth-web-5bd75f8d6-f6zw7'), AUTH)).toBe('auth')
    expect(resolveContainer(byName('api-web-6d5c9f7b8-xpgt9'), API)).toBe('api')
  })

  it('контейнер переименован → наиболее похожий не-sidecar', () => {
    const parsed = parsePods(PODS_JSON_RENAMED_CONTAINER, [AUTH])
    const pod = parsed?.[0]
    expect(pod?.containers).toEqual(['auth-proxy', 'migrations', 'auth-api', 'istio-proxy'])
    expect(resolveContainer(pod as PodInfo, AUTH)).toBe('auth-api')
  })

  it('без autoDiscover — значение из конфига как есть (не угадываем)', () => {
    const parsed = parsePods(PODS_JSON_RENAMED_CONTAINER, [API])
    expect(resolveContainer(parsed?.[0] as PodInfo, API)).toBe('api')
  })
})

describe('defaultContainer (под вне масок)', () => {
  it('первый не-sidecar, а не первый из spec', () => {
    // в spec порядок [edge-proxy, api-webhook, istio-proxy] — нужен api-webhook
    expect(defaultContainer(byName('api-webhook-5f8b6c9d4-ffqn4'))).toBe('api-webhook')
    expect(defaultContainer(byName('auth-web-worker-86f5884bb9-cbmw2'))).toBe('auth-worker')
  })

  it('распознаёт известные sidecar-имена экосистемы', () => {
    const pod = (containers: string[]): PodInfo => ({ containers }) as PodInfo
    expect(defaultContainer(pod(['istio-init', 'linkerd-init', 'vault-agent', 'app']))).toBe('app')
    expect(defaultContainer(pod(['app-proxy', 'app']))).toBe('app')
    // все контейнеры «служебные» — лучше вернуть первый, чем пустоту
    expect(defaultContainer(pod(['vault-agent']))).toBe('vault-agent')
  })
})
