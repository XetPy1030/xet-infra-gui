---
name: run-xet-infra-gui
description: Build, run, and drive the xet-infra-gui Electron app (Teleport/tsh menu-bar hub). Use when asked to run/start/launch the app, smoke-test it, take a screenshot of its UI, click through the window, or verify a change in the real app — запустить приложение, скриншот, прогнать smoke.
---

Electron-приложение (menu-bar хаб для `tsh`). Агентский путь — драйвер
`.claude/skills/run-xet-infra-gui/driver.mjs` (Playwright `_electron`): запускает
**собранное** приложение из `out/` и даёт скриншоты/клики/тексты/клавиатуру.
Проверено на macOS arm64 (реальное окно, xvfb не нужен); Linux/xvfb не проверялся.

Все пути — относительно корня репозитория.

## Prerequisites

macOS, Node ≥ 22 (проверено: Node 25). `tsh` в PATH желателен, но не обязателен:
без него приложение покажет «tsh недоступен», драйвер всё равно работает.

## Setup

```bash
npm install
```

`postinstall` обязателен (он в package.json, срабатывает сам): чинит exec-бит
`node_modules/node-pty/prebuilds/*/spawn-helper`, иначе PTY падает.

## Build

Драйвер запускает `out/` — после любых правок `src/` пересобери:

```bash
npm run build
```

## Run (agent path)

Сквозной smoke (запуск → статус-чипы → клик Login → PTY-сессия tsh → скриншоты → exit 0/1):

```bash
node .claude/skills/run-xet-infra-gui/driver.mjs smoke
```

Произвольное вождение — REPL; stdin обрабатывается строго последовательно, поэтому
батч через pipe безопасен (tmux на этой машине нет и не нужен):

```bash
printf 'launch\nwait 2000\ntexts .header-left .chip\nss my-shot\nquit\nexit\n' \
  | node .claude/skills/run-xet-infra-gui/driver.mjs repl
```

Скриншоты → `out/shots/*.png` (в gitignore через `out/`).

| Команда                  | Что делает                                   |
|--------------------------|----------------------------------------------|
| `launch [--with-creds]`  | собранное приложение → ждёт `.app` в DOM     |
| `ss <имя>`               | скриншот окна → `out/shots/<имя>.png`        |
| `click <селектор>`       | клик (например `button.primary` — это Login) |
| `texts <селектор>`       | все innerText по локатору, JSON              |
| `keys <текст>` / `enter` | клавиатура в сфокусированный элемент (xterm) |
| `eval <js>`              | выражение в контексте страницы               |
| `wait <мс>`              | пауза                                        |
| `logs [n]`               | хвост stdout/stderr main-процесса            |
| `quit` / `exit`          | закрыть приложение / выйти из REPL           |

Полезные селекторы: `.header-left .chip` (статус), `button.primary` (Login),
`.tab` (сессии), `.tab-stop` (завершить сессию), `.banner` (ручной фолбэк промпта),
`.proxy .toggle` (тумблеры DB-прокси, M1), `.proxybar .chip` (состояния прокси),
`text=Настройки` (панель кредов), `.settings-row .chip` (источники кредов).
M2: `.kubebar` (kube-бар), `.envs button >> nth=N` (окружение — **не** `text=stage`: он
поймает подпись DB-прокси), `text=Bash → api` / `text=Логи → api` (быстрые действия),
`.pods-group` (таблица подов по workload'ам), `.pod-actions button` (Bash/Логи/Команда…),
`text=Команда…` + `.exec-input` + `text=Выполнить` (one-shot), `.pods-search` (фильтр по имени),
`.logtools` (пауза/поиск в логах), `.tab-stop` (завершить сессию → баннер реконнекта).

Содержимое сессии удобно смотреть не только скриншотом:
`eval window.api.invoke("app.bootstrap").then(b=>Promise.all(b.sessions.map(s=>window.api.invoke("session.snapshot",{id:s.id}))))`
— так видно ring buffer целиком (этим был пойман запертый поток логов).

**Креды**: драйвер по умолчанию вырезает `XET_TELEPORT_PASSWORD`/`XET_TELEPORT_TOTP_SECRET`
из окружения — автоматизация не должна молча логиниться. `--with-creds` возвращает их
(только если пользователь сам их выставил). Никогда не вводи реальные пароль/OTP через
`keys` — это делает пользователь руками.

## Run (human path)

```bash
npm run dev   # HMR-окно electron-vite; Ctrl-C для остановки
```

Автоответ на промпты в dev: выставить `XET_TELEPORT_PASSWORD` / `XET_TELEPORT_TOTP_SECRET`
в запускающем терминале (см. README.md).

## Test

```bash
npm test          # vitest: 12 файлов, 103 теста — все зелёные
npm run typecheck # tsc node+web
npm run lint      # eslint, включая правила границ слоёв
```

Прогон сделан не ради скриншота: итог сверяется с чек-листом
[docs/06-final-check.md](../../../docs/06-final-check.md) (что проверить после «этап готов»).

## Gotchas

- **Правки `src/` не видны драйверу** — он грузит `out/`. Сначала `npm run build`.
- **Живой `npm run dev` держит single-instance lock** — smoke/launch тогда выходит мгновенно
  (exitCode 0, «окно не готово»). Проверить: `ps aux | grep 'electron-vite dev'`; остановить
  dev (это процесс пользователя — спросить/предупредить), потом запускать драйвер.
- **С M1 приложение живёт в menu bar (emoji 🟢🟡🔴⚪)**: закрытие окна НЕ завершает процесс —
  это дизайн (сессии переживают окно), выход — «Выход» в трее или app.quit. Драйверный `quit`
  убивает процесс целиком — сирот не оставляет.
- **Тумблер прокси реально спавнит `tsh proxy db`** на живой кластер: без кредов сессия
  повиснет в «ждёт код» (это валидный тест FSM), выключение тумблера шлёт SIGTERM. Прод-пресеты
  спрашивают confirm — в headless-прогоне их не трогать.
- **`tsh login` при живом сертификате завершается за ~2 с без промптов** (exit 0,
  таб «завершена»). Чтобы прогнать password/OTP-путь: `tsh logout` перед запуском —
  тогда без кредов сессия повиснет в «ждёт пароль» с баннером (и её надо добить
  `click .tab-stop`), с `--with-creds` — залогинится сама.
- **Kube на живом серте проверяется целиком** (сделано 2026-08-01 на dev): таблица подов,
  `Bash → api` до промпта в контейнере, `--follow`-логи, one-shot, реконнект. Учти: `get pods`
  на населённом namespace — мегабайты и секунды, поэтому список кэшируется (15 с) — «обновлено HH:MM:SS» в
  `.pods-head` не меняется при переключении вкладок, это норма, а не залипание.
- **Фейковый tsh нужен только для того, чего нет вживую** (протухший серт, stage/prod, MFA):
  сохрани `~/Library/Application Support/xet-infra-gui/config.json`, пропиши в нём
  `teleport.tshPath` на bash-скрипт, отвечающий на `status --format=json`, `kube login`,
  `kubectl get pods -o json` (фикстура `PODS_JSON` из `__fixtures__/kube.ts`), `kubectl exec`,
  `kubectl logs` — и **обязательно верни конфиг** после прогона.
- **Драйвер оставляет живое приложение, если сорвалась сессия Playwright** (оно menu-bar,
  окно закрывается — процесс живёт) → следующий `launch` мгновенно выходит по
  single-instance lock. Лечится `pkill -f 'xet-infra-gui/node_modules/electron'`.
- **Скрипты вне репо не найдут `playwright-core`** — резолвь зависимости как драйвер:
  `createRequire(join(ROOT, 'package.json'))`.
- **`^[]11;rgb:…` / `^[[1;1R` в выводе login-сессии** — были эхом ответов xterm на запросы
  tsh (фон/позиция курсора). `stripTerminalReports` режет их из ввода в PTY на auth-сессиях
  (иначе попадали в stdin поверх пароля → `invalid credentials`); раз ответ не доходит до PTY —
  tty его не эхоит, так что и текст-мусор пропал. Если правишь ввод терминала — не сломай этот
  фильтр (тесты `terminalInput.test.ts`, `SessionManager.test.ts`).
- **Дедуп восстановления xterm** — renderer подписывается на `session/data` до снапшота (иначе
  дыра); чтобы «хвост» снапшота и живые чанки не задвоились, поток нумеруется (`cursor`/`end`),
  а `replaySlice` (shared/stream) режет пересечение. Правишь replay в `TerminalView` — держи
  инвариант (тесты `stream.test.ts`, `SessionManager.test.ts`).
- **Смок-логика чипов**: залогинен → 4 чипа (юзер/кластер/kube/серт); не залогинен →
  1 красный чип. Оба валидны для smoke.

## Troubleshooting

- **`Error: posix_spawnp failed.` при старте PTY-сессии**: слетел exec-бит
  spawn-helper (npm его теряет). `npm run postinstall` или
  `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`.
- **`ERR_MODULE_NOT_FOUND: Cannot find package 'playwright-core'`**: скрипт лежит вне
  репо и резолвит от себя. Драйвер уже решает это через `createRequire` — используй его.
- **Таймаут `waitForSelector('.app')` / пустое окно**: нет или протух `out/` →
  `npm run build`.
- **Чип «tsh недоступен»**: login-shell не дал PATH с tsh → прописать абсолютный путь в
  `~/Library/Application Support/xet-infra-gui/config.json` → `teleport.tshPath`.
