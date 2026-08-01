/**
 * Фикстуры kube-выводов tsh 17.0.4 (`kubectl get pods -n <namespace> -o json`).
 *
 * Синтетика: namespace выдуман, форма полей — как у kubectl, лишнее выброшено
 * (образы, аннотации, ownerReferences, resourceVersion, conditions). Набор собран
 * из кейсов, на которых ломается наивный код: sidecar в каждом поде, прокси-контейнер
 * ПЕРЕД приложением в spec, соседний релиз с похожим именем и более свежий, чем
 * рабочий под, `Succeeded`-поды прошлых деплоев, компоненты воркеров/крона под той же
 * маской. Тесты держатся именно на этих свойствах — правя фикстуру, сохраняй их.
 *
 * Опорное «сейчас» для age-тестов: 2026-08-01T09:00:00Z, позже всех таймстампов.
 */

export const KUBE_NOW = Date.parse('2026-08-01T09:00:00Z')

export const PODS_JSON = `{
  "apiVersion": "v1",
  "kind": "List",
  "items": [
    {
      "metadata": {
        "name": "api-web-6d5c9f7b8-xpgt9",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T15:44:39Z",
        "labels": {
          "app.kubernetes.io/name": "api",
          "app.kubernetes.io/instance": "api-web"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "edge-proxy"
          },
          {
            "name": "api"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T15:44:40Z",
        "containerStatuses": [
          {
            "name": "api",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "edge-proxy",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 2,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "api-web-6d5c9f7b8-zcjs2",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T15:44:23Z",
        "labels": {
          "app.kubernetes.io/name": "api",
          "app.kubernetes.io/instance": "api-web"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "edge-proxy"
          },
          {
            "name": "api"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T15:44:23Z",
        "containerStatuses": [
          {
            "name": "api",
            "ready": true,
            "restartCount": 8,
            "started": true
          },
          {
            "name": "edge-proxy",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 2,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "api-cron-7c9448b75-r9jfj",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T22:31:59Z",
        "labels": {
          "app.kubernetes.io/name": "api",
          "app.kubernetes.io/instance": "api-cron"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "api-cron"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T22:32:00Z",
        "containerStatuses": [
          {
            "name": "api-cron",
            "ready": true,
            "restartCount": 0,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 0,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "api-webhook-5f8b6c9d4-ffqn4",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T19:52:40Z",
        "labels": {
          "app.kubernetes.io/name": "api",
          "app.kubernetes.io/instance": "api-webhook"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "edge-proxy"
          },
          {
            "name": "api-webhook"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T19:52:41Z",
        "containerStatuses": [
          {
            "name": "api-webhook",
            "ready": true,
            "restartCount": 0,
            "started": true
          },
          {
            "name": "edge-proxy",
            "ready": true,
            "restartCount": 0,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 0,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "portal-7854d47c9-dwbkv",
        "namespace": "apps",
        "creationTimestamp": "2026-07-29T09:56:02Z",
        "labels": {
          "app.kubernetes.io/instance": "portal"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "portal"
          }
        ],
        "initContainers": []
      },
      "status": {
        "phase": "Succeeded",
        "startTime": "2026-07-29T09:56:02Z",
        "containerStatuses": [
          {
            "name": "portal",
            "ready": false,
            "restartCount": 0,
            "started": false
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "auth-web-5bd75f8d6-f6zw7",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T12:22:50Z",
        "labels": {
          "app.kubernetes.io/name": "auth",
          "app.kubernetes.io/instance": "auth-web"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "auth"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T12:22:50Z",
        "containerStatuses": [
          {
            "name": "auth",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 2,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "auth-web-cron-c478f8b56-49ggb",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T12:22:50Z",
        "labels": {
          "app.kubernetes.io/name": "auth",
          "app.kubernetes.io/instance": "auth-web-cron"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "auth-cron"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T12:22:50Z",
        "containerStatuses": [
          {
            "name": "auth-cron",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 2,
            "started": true
          }
        ]
      }
    },
    {
      "metadata": {
        "name": "auth-web-worker-86f5884bb9-cbmw2",
        "namespace": "apps",
        "creationTimestamp": "2026-07-31T12:22:50Z",
        "labels": {
          "app.kubernetes.io/name": "auth",
          "app.kubernetes.io/instance": "auth-web-worker"
        }
      },
      "spec": {
        "containers": [
          {
            "name": "auth-worker"
          },
          {
            "name": "istio-proxy"
          }
        ],
        "initContainers": [
          {
            "name": "istio-init"
          }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T12:22:50Z",
        "containerStatuses": [
          {
            "name": "auth-worker",
            "ready": true,
            "restartCount": 1,
            "started": true
          },
          {
            "name": "istio-proxy",
            "ready": true,
            "restartCount": 2,
            "started": true
          }
        ]
      }
    }
  ]
}`

/**
 * Середина rollout'а: новый под ещё Pending, старый Running, но контейнер уже не
 * ready. PodSelector не должен выбрать ни того, ни другого.
 */
export const PODS_JSON_ROLLOUT = `{
  "items": [
    {
      "metadata": {
        "name": "api-web-7d9f6c5b4-pend1",
        "creationTimestamp": "2026-08-01T08:59:00Z"
      },
      "spec": { "containers": [{ "name": "api" }] },
      "status": { "phase": "Pending", "containerStatuses": [] }
    },
    {
      "metadata": {
        "name": "api-web-6d5c9f7b8-old01",
        "creationTimestamp": "2026-07-31T15:44:39Z"
      },
      "spec": { "containers": [{ "name": "api" }, { "name": "istio-proxy" }] },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T15:44:40Z",
        "containerStatuses": [
          { "name": "api", "ready": false, "restartCount": 3 },
          { "name": "istio-proxy", "ready": true, "restartCount": 0 }
        ]
      }
    }
  ]
}`

/** Контейнер переименован релизом — кейс containerAutoDiscover (docs/04 §2). */
export const PODS_JSON_RENAMED_CONTAINER = `{
  "items": [
    {
      "metadata": {
        "name": "auth-web-8f9d7c6b5-rn003",
        "creationTimestamp": "2026-07-31T12:22:49Z"
      },
      "spec": {
        "containers": [
          { "name": "auth-proxy" },
          { "name": "migrations" },
          { "name": "auth-api" },
          { "name": "istio-proxy" }
        ]
      },
      "status": {
        "phase": "Running",
        "startTime": "2026-07-31T12:22:50Z",
        "containerStatuses": [
          { "name": "auth-proxy", "ready": true, "restartCount": 0 },
          { "name": "migrations", "ready": true, "restartCount": 0 },
          { "name": "auth-api", "ready": true, "restartCount": 0 },
          { "name": "istio-proxy", "ready": true, "restartCount": 0 }
        ]
      }
    }
  ]
}`

/** `tsh kubectl` без свежего серта — exec-канал ловит это в stderr (docs/04 §6). */
export const KUBE_EXPIRED_STDERR =
  'ERROR: access denied: your Teleport session has expired, please re-login using "tsh login"'

/** stderr `tsh kube login` при протухшем сертификате — с ANSI-раскраской, её снимаем. */
export const KUBE_LOGIN_EXPIRED_STDERR = '\x1b[31mERROR: \x1b[0mssh: cert has expired\n'
