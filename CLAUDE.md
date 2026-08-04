# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Язык проекта — русский: документация, комментарии в коде, тексты UI и сообщения об ошибках
пишутся по-русски. Имена в коде — английские.

## Команды

```bash
npm install            # postinstall чинит exec-бит node-pty spawn-helper (обязателен)
npm run dev            # electron-vite dev с HMR
npm run build          # сборка в out/ — драйвер живого прогона грузит именно её
npm test               # vitest run (все тесты core/shared)
npm run test:e2e       # Playwright: собранное приложение + фейковый tsh (нужен свежий out/)
npm run typecheck      # tsc для node- и web-частей раздельно
npm run lint           # eslint, включая правила границ слоёв
```

Один файл / один тест:

```bash
npx vitest run src/core/services/SqlService.test.ts
npx vitest run src/core/services/SqlService.test.ts -t 'read only'
npm run test:watch
```

Живой прогон собранного приложения (Playwright `_electron`) — через скилл
`.claude/skills/run-xet-infra-gui/`, там же селекторы и ловушки. `e2e/smoke.mjs` — то же
самое, но детерминированно: фейковый `tsh`, свой конфиг и свой `--user-data-dir`.

```bash
npm run build && node .claude/skills/run-xet-infra-gui/driver.mjs smoke
printf 'launch\nwait 2000\ntexts .header-left .chip\nss shot\nquit\nexit\n' \
  | node .claude/skills/run-xet-infra-gui/driver.mjs repl
```

Запуск на своём конфиге, не трогая userData: `XET_CONFIG_PATH=$PWD/local-artifacts/config.json npm run dev`.

## Архитектура

Menu-bar-приложение поверх CLI `tsh`: DB-прокси тумблерами, Kubernetes (поды/bash/логи),
SQL-консоль, автологин с подстановкой пароля и TOTP.

### Слои и правило зависимостей

`renderer → shared ← main → core`; `core` не знает ни про кого. Нарушения ловит eslint
(`no-restricted-imports` в `eslint.config.mjs`): `core`/`shared` без `electron`, `renderer` без
`electron`, `node:*` и `@core/*`.

| Каталог | Что там | Чего там нет |
|---|---|---|
| `src/core` | чистый TS: `domain/` (модели, чистые функции), `ports/` (интерфейсы наружу), `services/` (прикладная логика), `modules/teleport/` (TshClient, промпты, фикстуры, схемы конфига) | Electron, `process.platform`-ветвлений |
| `src/main` | composition root `index.ts`, `adapters/` (реализации портов), `ipc/`, трей, окна | бизнес-логики (она в core) |
| `src/preload` | generic-мост `invoke`/`on` с allowlist каналов, единый CJS-файл | всего остального (sandbox) |
| `src/renderer` | React + zustand + xterm; данные — только из IPC | Node API, вызовов tsh, секретов |
| `src/shared` | IPC-контракт: `types.ts` (RpcMap/EventMap), `channels.ts` (allowlist), `schemas.ts` (zod) | зависимостей от main/renderer |

Порт добавляется в `core/ports`, реализуется в `main/adapters`, **связывается только в
`src/main/index.ts`** — ядро собирается там из адаптеров и нигде больше.

### IPC

`src/shared/types.ts` — единственная точка правды: `RpcMap` (канал → `{req, res}`) и `EventMap`
(канал → payload). Новый канал требует правок в четырёх местах: `types.ts` → `schemas.ts`
(zod-схема запроса, ей валидирует `registerIpc`) → `channels.ts` (allowlist preload) →
`main/ipc/router.ts` (обработчик). Renderer вызывает через типизированные `rpc()`/`onEvent()`
из `renderer/src/api.ts`.

Поток данных однонаправленный: main — источник правды, renderer — проекция. На старте
`app.bootstrap` отдаёт снапшот, дальше — только события в zustand-стор (`renderer/src/store.ts`).
Доменные вычисления делаются в ядре и едут в DTO; повторять алгоритм в UI нельзя (это ловится
не линтером, а ревью — см. `docs/06-final-check.md` §4).

### Действия

`ActionRegistry` (`core/services/ActionRegistry.ts`) — каталог всех пользовательских действий;
провайдер модуля teleport собирает их из конфига и состояния (`core/modules/teleport/actions.ts`).
Палитра ⌘K, меню трея, тумблеры прокси и кнопки SQL-раздела ничего не решают сами — они зовут
`actions.run`. Вопросы пользователю действие возвращает данными (`needs-confirm` + ключ), а
спрашивает вызывающий: окно — `window.confirm`, трей — нативным диалогом (ADR-0010). Добавляя
действие, добавляй его в провайдер, а не в UI.

### Сессии и PTY

`SessionManager` — реестр PTY-сессий с FSM, ring buffer'ами, батчингом вывода (8–16 мс) и
backpressure по ack-watermark. Через него идёт **всё** долгоживущее: `tsh login`, `tsh proxy db`,
kube exec/логи (ADR-0007), `psql`, `pg_dump` (`sh -lc`, ADR-0009). One-shot — `ProcessRunner.run`.

`PromptPipeline` (Chain of Responsibility) сканирует поток auth-сессий и отвечает на промпты
пароля/OTP; секреты пишутся прямо в PTY и не попадают ни в ring buffer, ни в renderer.

Владельцы состояния: `ProxySupervisor` — состояние прокси, рестарты, probe'ы; `HealthMonitor` —
только сертификат; `KubeService` — kube-окружение и кэш подов; `AuthService` — логин и статус.

### Конфигурация

В репозитории нет зашитых настроек чьей-либо инфраструктуры: прокси, пользователь, кластеры,
namespace, маски подов и db-пресеты приходят из конфига (ADR-0008). Схема — `core/config/schema.ts`
плюс секции модуля в `core/modules/teleport/config.ts`; дефолты пустые, приложение стартует
ненастроенным и показывает онбординг. Форма файла — `config.example.json`.

## Правила проекта

- **Этап не готов без живого прогона.** `docs/06-final-check.md` — обязательный чек-лист:
  зелёные тесты в этом проекте не ловят ровно то, что ломается (ответы терминала под PTY, ANSI в
  stderr, цена вызовов, табы в вечном «запускается»). Итог записывается в `docs/05-roadmap.md`
  секциями «проверено (чем)» и «осталось сверить».
- **Решение против архитектуры — новый ADR** в `docs/adr/` (Статус / Контекст / Решение /
  Последствия), задним числом ADR не редактируются.
- **Чужой инфраструктуры в репозитории нет** — ни имён (кластеры, поды, namespace, роли,
  пользователи), ни устройства (схема именования релизов, состав sidecar'ов, замеры). Фикстуры
  синтетические: от живого вывода в них форма, а не содержимое. Личное — в `local-artifacts/`
  (в `.gitignore`), там же заметки о реальном окружении.
- **Каждое новое публичное имя должно иметь вызывающего** — grep по репозиторию, иначе удалить
  (тест — не вызывающий: если наружу торчит только ради теста, тестируй через публичный вход).
- **Автоматизация не логинится сама**: драйвер вырезает `XET_TELEPORT_*` из окружения; реальные
  пароль и OTP вводит человек руками.
- Новый баг, пойманный вживую, → регрессионный тест; новая грабля → строка в
  `docs/04-tsh-integration.md` §7; новый селектор/приём прогона → SKILL.md.

## Грабли, которые уже стоили времени

- Драйвер живого прогона грузит `out/` — правки `src/` без `npm run build` не видны.
- Живой `npm run dev` держит single-instance lock: `launch` выйдет мгновенно. Осиротевший
  Electron — `pkill -f 'xet-infra-gui/node_modules/electron'`.
- В адресах туннелей только `127.0.0.1`: `localhost` может уехать в `::1`, где tsh не слушает.
- `stripTerminalReports` (`core/util/terminalInput.ts`) режет ответы xterm на запросы tsh во
  вводе auth-сессий — без него они попадали в stdin поверх пароля. Для интерактивных сессий
  (`psql`, `kubectl exec`) фильтр наоборот выключен (`sanitizeTerminalReports: false`).
- Скрытая панель терминала имеет нулевую высоту, и `FitAddon` считает размер 1×1: `TerminalView`
  шлёт `session.resize` только при `cols/rows ≥ 2` (иначе PTY переформатирует вывод под одну
  строку, а схема main отбивает запрос `ZodError`'ом).
- Восстановление xterm дедуплицируется watermark'ом потока (`shared/stream.ts`, `replaySlice`) —
  подписка на `session/data` идёт до снапшота, пересечение режется.
- `npm` теряет exec-бит у `node-pty/prebuilds/*/spawn-helper` → `posix_spawnp failed`; лечит
  `npm run postinstall`.
