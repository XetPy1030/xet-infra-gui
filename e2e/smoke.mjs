#!/usr/bin/env node
// E2E-смоук (M4): собранное приложение + фейковый `tsh` + временный userData.
// Проверяет сквозные пути, которых не видит ни один unit-тест: bootstrap →
// статус → поды → палитра ⌘K → сессия, и отдельно первый запуск на пустом
// конфиге (мастер + валидация схемы).
//
//   npm run build && npm run test:e2e
//
// Реальный кластер, креды и MFA не участвуют: fake-tsh отвечает синтетикой.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')

const FAKE_TSH = join(ROOT, 'e2e', 'fake-tsh.mjs')
chmodSync(FAKE_TSH, 0o755)

const CONFIG = {
  teleport: {
    proxy: 'teleport.example.com:443',
    user: 'e2e@example.com',
    cluster: 'teleport.example.com',
    tshPath: FAKE_TSH,
    mfaMode: 'otp'
  },
  db: {
    portStrategy: 'shared',
    presets: [
      {
        id: 'db-dev',
        env: 'dev',
        tunnel: 'dev-postgres',
        dbUser: 'app',
        dbName: 'dev',
        port: 6543,
        dangerous: false
      }
    ]
  },
  kube: {
    namespace: 'apps',
    clusters: { dev: 'dev-k8s-cluster', stage: 'stage-k8s-cluster', prod: 'prod-k8s-cluster' },
    workloads: [
      {
        id: 'api',
        title: 'api',
        podPrefix: 'api-web-',
        podExclude: ['-cron-'],
        container: 'api',
        containerAutoDiscover: true
      }
    ],
    logsTail: 10
  },
  sql: { dumpPresets: [] },
  ui: { hotkeys: { palette: 'CommandOrControl+K', envStage: 'CommandOrControl+2' } }
}

let failures = 0
const check = (ok, what) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`)
  if (!ok) failures += 1
}

/** Запуск приложения на своём конфиге и своём userData: чужие данные не трогаем. */
async function launch(config) {
  const dir = mkdtempSync(join(tmpdir(), 'xet-e2e-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const env = { ...process.env, XET_CONFIG_PATH: configPath }
  delete env.XET_TELEPORT_PASSWORD
  delete env.XET_TELEPORT_TOTP_SECRET
  const app = await _electron.launch({
    executablePath: electronPath,
    // свой user-data-dir: и секреты приложения целы, и single-instance lock не мешает
    args: ['.', `--user-data-dir=${join(dir, 'userData')}`],
    cwd: ROOT,
    env
  })
  // вывод main'а копим: часть проверок — про то, чего в окне не видно
  let out = ''
  app.process().stdout?.on('data', (d) => (out += String(d)))
  app.process().stderr?.on('data', (d) => (out += String(d)))
  const win = await app.firstWindow()
  await win.waitForSelector('.app', { timeout: 20_000 })
  return { app, win, dir, mainOut: () => out }
}

const texts = (win, selector) => win.locator(selector).allTextContents()

/** Основной сценарий: настроенное приложение с живым (фейковым) tsh. */
async function scenarioConfigured() {
  console.log('\n[1] Настроенное приложение')
  const { app, win, mainOut } = await launch(CONFIG)
  try {
    // первый bootstrap отдаёт кэш (он пуст), свежий статус приходит событием
    await win
      .locator('.header-left .chip', { hasText: 'e2e@example.com' })
      .waitFor({ timeout: 15_000 })
      .catch(() => {})
    const chips = (await texts(win, '.header-left .chip')).join(' ')
    check(chips.includes('e2e@example.com'), `статус из tsh: ${chips.replace(/\s+/g, ' ')}`)

    await win.click('text=Поды')
    await win.waitForSelector('.pods-group', { timeout: 15_000 })
    const pods = (await texts(win, '.pods-group')).join(' ')
    check(pods.includes('api-web-7c9d5f-aaa11'), 'таблица подов собралась из вывода kubectl')
    check(!pods.includes('api-cron'), 'исключения маски работают: cron-под не попал в workload')

    // палитра: каталог действий приходит из реестра и фильтруется fuzzy-поиском
    await win.keyboard.press('Meta+k')
    // ждём строки, а не саму палитру: она открывается сразу, а каталог приезжает
    // ответом `actions.list` — иначе проверка ловит пустой список
    await win.waitForSelector('.pal-row', { timeout: 5000 })
    const all = await texts(win, '.pal-row')
    check(all.length > 3, `палитра открылась хоткеем, действий: ${all.length}`)
    check(
      all.some((t) => t.includes('DB-прокси')) && all.some((t) => t.includes('SQL')),
      'в каталоге есть действия прокси и SQL'
    )

    await win.keyboard.type('логи api')
    await win.waitForTimeout(200)
    const found = await texts(win, '.pal-row')
    check(found.length === 1 && found[0].includes('Логи → api'), `fuzzy-поиск: ${found.join('|')}`)

    await win.keyboard.press('Enter')
    await win.waitForSelector('.tab-stop', { timeout: 15_000 })
    const tabs = (await texts(win, '.tab')).join(' ')
    check(tabs.includes('логи: api'), `действие из палитры открыло сессию: ${tabs}`)
    check((await texts(win, '.palette')).length === 0, 'палитра закрылась после запуска')

    // регрессия (поймано на живом логине): у схлопнутого хоста FitAddon отдаёт
    // rows = Math.max(1, …) — вырожденный размер летел в main и отбивался ZodError'ом
    await win.evaluate(() => {
      const host = document.querySelector('.terminal-host')
      host.style.flex = 'none'
      host.style.height = '0px'
    })
    await win.waitForTimeout(600)
    await win.evaluate(() => {
      const host = document.querySelector('.terminal-host')
      host.style.flex = '1'
      host.style.height = ''
    })
    await win.waitForTimeout(600)
    check(!/session\.resize/.test(mainOut()), 'схлопнутый терминал не шлёт вырожденный resize')

    // хоткей окружения: ⌘2 → stage, через тот же реестр действий
    await win.keyboard.press('Meta+2')
    await win.waitForTimeout(1500)
    const kubebar = (await texts(win, '.kubebar')).join(' ')
    check(kubebar.includes('stage'), `⌘2 переключил окружение: ${kubebar.replace(/\s+/g, ' ')}`)

    // параметризованное действие: палитра спрашивает аргумент вторым шагом
    await win.keyboard.press('Meta+k')
    await win.waitForSelector('.palette', { timeout: 5000 })
    await win.keyboard.type('команда в api')
    await win.waitForTimeout(200)
    await win.keyboard.press('Enter')
    await win.waitForSelector('.pal-pending', { timeout: 5000 })
    check(true, 'действие с параметром просит аргумент, а не запускается вслепую')
    await win.keyboard.press('Escape')
    await win.keyboard.press('Escape')
  } finally {
    await app.close().catch(() => {})
  }
}

/** Первый запуск: пустой конфиг — мастер и валидация схемы. */
async function scenarioFirstRun() {
  console.log('\n[2] Первый запуск (пустой конфиг)')
  const { app, win } = await launch({})
  try {
    await win.waitForSelector('.wizard', { timeout: 10_000 })
    const steps = await texts(win, '.wiz-step')
    check(steps.length === 4, `мастер открылся сам, шагов: ${steps.length}`)
    check(steps.join(' ').includes('Кластер и пользователь'), 'шаг конфига на месте')

    const issues = await win.evaluate(() =>
      window.api.invoke('config.check', {
        text: JSON.stringify({ db: { presets: [{ id: 'x', env: 'dev' }] } })
      })
    )
    check(!issues.ok && issues.issues.length > 0, 'проверка схемы находит проблемы неполного конфига')
    check(
      !issues.ok && issues.issues.some((i) => i.path.startsWith('db.presets.0.')),
      `проблема указывает путь: ${!issues.ok ? issues.issues[0].path : '—'}`
    )

    const ok = await win.evaluate(() =>
      window.api.invoke('config.check', { text: '{ "kube": { "logsTail": 10 } }' })
    )
    check(ok.ok === true, 'валидный кусок конфига проблем не даёт')
  } finally {
    await app.close().catch(() => {})
  }
}

const started = Date.now()
try {
  await scenarioConfigured()
  await scenarioFirstRun()
} catch (e) {
  console.error('E2E упал:', e)
  failures += 1
}
console.log(`\n${failures === 0 ? 'E2E OK' : `E2E FAIL (${failures})`} · ${Date.now() - started} мс`)
process.exit(failures === 0 ? 0 : 1)
