# xet-infra-gui

Menu-bar «инфраструктурный хаб» для macOS поверх Teleport (`tsh`): DB-прокси тумблерами,
bash в поды, логи, SQL — с автологином (пароль + TOTP подставляются сами).

**Статус: M4.** Работает: menu bar с агрегированным статусом, `tsh login` с автоподстановкой
пароля/OTP из Keychain, тумблеры DB-прокси с супервизией и рестартом после перелогина,
Kubernetes — список подов с группировкой по workload'ам, «Bash → workload» в свежайший под,
логи `--follow` с паузой и поиском, one-shot команды, подтверждение действий на prod,
SQL-консоль в туннель — результат таблицей, история запросов, `psql` в терминале, пресеты
`pg_dump` с прогрессом, палитра команд ⌘K поверх реестра действий, переназначаемые хоткеи,
мастер первого запуска и системные уведомления о фоновых задачах.
Дальше по [roadmap](docs/05-roadmap.md): M5 — подпись, дистрибуция, автообновление.

Документация: [docs/](docs/README.md) — требования, UX, архитектура (паттерны в
[ADR](docs/adr)), интеграция tsh, roadmap.

## Запуск (dev)

```bash
npm install
npm run dev
```

Пароль и TOTP-секрет живут в Keychain (Настройки → Креды или мастер первого запуска).
Переменные окружения — dev-фолбэк, если класть в Keychain нечего:

```bash
XET_TELEPORT_PASSWORD='...' XET_TELEPORT_TOTP_SECRET='BASE32SECRET' npm run dev
```

- `XET_TELEPORT_TOTP_SECRET` — base32-секрет TOTP-девайса (см.
  [docs/04 §4.2](docs/04-tsh-integration.md#42-собственный-totp-девайс-приложения):
  `tsh mfa add --type TOTP --name xet-infra-gui` печатает секрет).
- Без переменных всё тоже работает: приложение покажет «ждёт пароль/OTP», ввод — прямо
  в терминале приложения.

## Конфиг

В приложении нет зашитых настроек чьей-либо инфраструктуры: всё специфичное — прокси,
пользователь, кластеры окружений, namespace, маски подов workload'ов и db-пресеты — приходит
из конфига. Пока он пуст, приложение стартует и показывает онбординг.

При первом запуске создаётся пустой `~/Library/Application Support/xet-infra-gui/config.json`.
Дальше — как удобнее:

- **Настройки → Конфиг** в приложении: правка текстом, «Импорт из файла» / «Экспорт в файл»
  для переноса между машинами. Применяется перезапуском (кнопка там же).
- **`XET_CONFIG_PATH`** — запуск на произвольном файле, не трогая userData:

  ```bash
  XET_CONFIG_PATH=$PWD/local-artifacts/config.json npm run dev
  ```

Форма файла — `config.example.json` в корне и
[docs/04 §2](docs/04-tsh-integration.md#2-модель-конфигурации). Секции, которых в файле нет,
добираются дефолтами схемы; невалидный файл не роняет старт — приложение поднимется на пустом
конфиге и покажет ошибку валидации.

`local-artifacts/` (в `.gitignore`) — место для личных значений и заметок про своё окружение:
в репозиторий имена реальных кластеров, подов и пользователей не попадают.

## Скрипты

| Команда | Что делает |
|---|---|
| `npm run dev` | electron-vite dev с HMR |
| `npm run build` | сборка в `out/` |
| `npm test` | vitest: core-тесты (промпты на фикстурах tsh, RFC-вектор TOTP, FSM сессий, PodSelector, age в формате kubectl, политика действий) |
| `npm run test:e2e` | Playwright: собранное приложение на фейковом `tsh` и временном userData (кластер и креды не нужны) |
| `npm run typecheck` | tsc для node- и web-частей |
| `npm run lint` | eslint, включая правила границ слоёв (core/shared без Electron и т.д.) |

## Структура

```
src/core      — ядро без Electron: домен, порты, схема конфига, SessionManager/PromptPipeline/Totp/Proxy/Kube/Sql/Dump/Config/Actions, модуль teleport
src/main      — composition root: адаптеры (node-pty, execFile, pg, PATH из login-shell), IPC, окна
src/preload   — узкий CJS-мост с allowlist каналов (sandbox)
src/renderer  — React + zustand + @xterm/xterm (WebGL)
src/shared    — IPC-контракт (типы, каналы, zod-схемы) + чистые помощники UI: fuzzy, акселераторы, пути в JSON
e2e           — фейковый tsh и сценарии смоука
```

Известная особенность: npm иногда теряет exec-бит у `node-pty` `spawn-helper` —
чинится автоматически в `postinstall` (иначе PTY падает с `posix_spawnp failed`).
