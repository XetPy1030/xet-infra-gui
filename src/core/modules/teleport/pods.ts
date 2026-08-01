import { z } from 'zod'
import type { KubeWorkload, PodInfo } from './types'

// `kubectl get pods -o json` — берём нужное, остальное пропускаем (loose):
// формат k8s стабилен, но лишние поля меняются от версии к версии (NFR-7).
const containerSchema = z.looseObject({ name: z.string() })
const containerStatusSchema = z.looseObject({
  name: z.string(),
  ready: z.boolean().nullish(),
  restartCount: z.number().nullish()
})
const podSchema = z.looseObject({
  metadata: z.looseObject({
    name: z.string(),
    creationTimestamp: z.string().nullish()
  }),
  spec: z.looseObject({ containers: z.array(containerSchema).nullish() }).nullish(),
  status: z
    .looseObject({
      phase: z.string().nullish(),
      startTime: z.string().nullish(),
      containerStatuses: z.array(containerStatusSchema).nullish()
    })
    .nullish()
})
const podListSchema = z.looseObject({ items: z.array(podSchema).nullish() })

/**
 * Инфраструктурные контейнеры рядом с приложением — не кандидаты в автоподборе
 * (docs/04 §2). `-proxy` ловит и mesh, и локальный прокси приложения, который
 * вполне может стоять в spec ПЕРЕД ним.
 */
const SIDECAR_MARKERS = ['-proxy', 'istio-init', 'linkerd-init', 'vault-agent']

const isSidecar = (name: string): boolean => SIDECAR_MARKERS.some((m) => name.includes(m))

/**
 * Разбор списка подов. Возвращает null, если это не валидный вывод kubectl
 * (тогда вызывающий покажет stderr как есть, а не «подов нет»).
 */
export function parsePods(stdout: string, workloads: KubeWorkload[]): PodInfo[] | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const parsed = podListSchema.safeParse(json)
  if (!parsed.success) return null
  return (parsed.data.items ?? []).map((item) => {
    const statuses = item.status?.containerStatuses ?? []
    const specContainers = (item.spec?.containers ?? []).map((c) => c.name)
    return {
      name: item.metadata.name,
      phase: item.status?.phase ?? 'Unknown',
      readyCount: statuses.filter((s) => s.ready === true).length,
      totalCount: statuses.length || specContainers.length,
      restarts: statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
      startedAt: item.status?.startTime ?? null,
      createdAt: item.metadata.creationTimestamp ?? null,
      containers: specContainers.length > 0 ? specContainers : statuses.map((s) => s.name),
      workloadId: matchWorkload(item.metadata.name, workloads)?.id ?? null
    }
  })
}

/** Какому workload'у принадлежит под: префикс + исключения (docs/04 §3.3). */
export function matchWorkload(podName: string, workloads: KubeWorkload[]): KubeWorkload | null {
  for (const w of workloads) {
    if (!podName.startsWith(w.podPrefix)) continue
    if (w.podExclude.some((marker) => podName.includes(marker))) continue
    return w
  }
  return null
}

const isServing = (p: PodInfo): boolean =>
  p.phase === 'Running' && p.totalCount > 0 && p.readyCount === p.totalCount

/**
 * PodSelector (docs/04 §3.3): среди подов workload'а — Running, все контейнеры
 * ready, максимальный startTime («желательно свежайший», FR-K3).
 */
export function selectFreshest(pods: PodInfo[], workloadId: string): PodInfo | null {
  const candidates = pods.filter((p) => p.workloadId === workloadId && isServing(p))
  let best: PodInfo | null = null
  let bestTs = -Infinity
  for (const p of candidates) {
    const ts = p.startedAt ? Date.parse(p.startedAt) : NaN
    // без startTime под всё равно кандидат, но проигрывает любому датированному
    const value = Number.isNaN(ts) ? -Infinity : ts
    if (best === null || value > bestTs) {
      best = p
      bestTs = value
    }
  }
  return best
}

/** Под вне масок конфига: контейнер по умолчанию — первый не-sidecar из spec. */
export function defaultContainer(pod: PodInfo): string {
  return pod.containers.find((c) => !isSidecar(c)) ?? pod.containers[0] ?? ''
}

/**
 * Контейнер для exec/логов: значение из конфига, при containerAutoDiscover —
 * сверка со spec.containers[] пода и подбор наиболее похожего не-sidecar'а
 * (имена контейнеров тоже переживают переименования релизов, docs/04 §2).
 */
export function resolveContainer(pod: PodInfo, workload: KubeWorkload): string {
  const wanted = workload.container
  if (pod.containers.length === 0) return wanted
  if (pod.containers.includes(wanted)) return wanted
  if (!workload.containerAutoDiscover) return wanted

  const candidates = pod.containers.filter((c) => !isSidecar(c))
  if (candidates.length === 0) return wanted
  let best = candidates[0] as string
  let bestScore = -1
  for (const c of candidates) {
    const score =
      c.includes(wanted) || wanted.includes(c) ? 1000 + commonPrefix(c, wanted) : commonPrefix(c, wanted)
    if (score > bestScore) {
      best = c
      bestScore = score
    }
  }
  return best
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i += 1
  return i
}
