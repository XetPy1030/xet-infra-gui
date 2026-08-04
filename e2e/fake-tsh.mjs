#!/usr/bin/env node
// Фейковый `tsh` для E2E-смоука: отвечает ровно на те команды, которые
// приложение действительно вызывает, и делает это мгновенно и детерминированно.
// Живого кластера, MFA и сети здесь нет — проверяется приложение, а не Teleport.
//
// Данные синтетические (namespace `apps`, workload `api`) и совпадают с
// e2e/config.json; форма JSON — как у `kubectl get pods -o json`.
import { argv, stdout } from 'node:process'

const args = argv.slice(2)
const has = (flag) => args.includes(flag)
const sub = args.filter((a) => !a.startsWith('-'))

const STARTED = new Date(Date.now() - 3600_000).toISOString()

const pods = {
  apiVersion: 'v1',
  kind: 'List',
  items: [
    {
      metadata: { name: 'api-web-7c9d5f-aaa11', namespace: 'apps', creationTimestamp: STARTED },
      spec: { containers: [{ name: 'edge-proxy' }, { name: 'api' }] },
      status: {
        phase: 'Running',
        startTime: STARTED,
        containerStatuses: [
          { name: 'api', ready: true, restartCount: 0, started: true },
          { name: 'edge-proxy', ready: true, restartCount: 0, started: true }
        ]
      }
    },
    {
      metadata: { name: 'api-cron-7c9d5f-bbb22', namespace: 'apps', creationTimestamp: STARTED },
      spec: { containers: [{ name: 'api' }] },
      status: {
        phase: 'Succeeded',
        startTime: STARTED,
        containerStatuses: [{ name: 'api', ready: false, restartCount: 0, started: false }]
      }
    }
  ]
}

const status = {
  active: {
    username: 'e2e@example.com',
    cluster: 'teleport.example.com',
    kubernetes_cluster: 'dev-k8s-cluster',
    valid_until: new Date(Date.now() + 8 * 3600_000).toISOString()
  }
}

if (sub[0] === 'status') {
  stdout.write(JSON.stringify(status))
  process.exit(0)
}

if (sub[0] === 'kube' && sub[1] === 'login') {
  stdout.write(`Logged into Kubernetes cluster "${sub[2] ?? ''}"\n`)
  process.exit(0)
}

if (sub[0] === 'kubectl') {
  const verb = sub[1]
  if (verb === 'get') {
    stdout.write(JSON.stringify(pods))
    process.exit(0)
  }
  if (verb === 'logs') {
    // хвост логов: несколько строк и, если просили follow, тишина до SIGTERM
    for (let i = 1; i <= 3; i += 1) stdout.write(`log line ${i}\n`)
    if (has('--follow')) setInterval(() => stdout.write('tick\n'), 1000)
    else process.exit(0)
  } else if (verb === 'exec') {
    // и `-- bash`, и `-- sh -lc <cmd>`: печатаем «промпт» и живём до SIGTERM
    stdout.write('e2e-container:/app$ \n')
    setInterval(() => {}, 1000)
  } else {
    process.exit(0)
  }
} else if (sub[0] === 'proxy') {
  // туннель не поднимаем: порт остаётся закрытым, и это честное состояние —
  // supervisor покажет «проверка порта…», а не «работает»
  stdout.write('Started tunnel (fake)\n')
  setInterval(() => {}, 1000)
} else if (sub[0] === 'login') {
  stdout.write('Logged in (fake)\n')
  process.exit(0)
} else {
  process.stderr.write(`fake tsh: не знаю команду ${JSON.stringify(args)}\n`)
  process.exit(1)
}
