#!/usr/bin/env node
// Драйвер xet-infra-gui: запускает СОБРАННОЕ приложение (out/) через Playwright
// _electron и даёт программный доступ: скриншоты, клики, тексты, клавиатура.
//
//   node .claude/skills/run-xet-infra-gui/driver.mjs smoke   — сквозной прогон M0
//   node .claude/skills/run-xet-infra-gui/driver.mjs repl    — REPL (stdin построчно,
//                                                              можно pipe'ом)
//
// Креды (XET_TELEPORT_PASSWORD/TOTP_SECRET) по умолчанию ВЫРЕЗАЮТСЯ из окружения:
// автоматизация не должна логиниться по-настоящему без явного намерения.
// Вернуть их: флаг --with-creds (например `smoke --with-creds`).
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const ROOT = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(ROOT, 'package.json'))
const { _electron } = require('playwright-core')
const electronPath = require('electron')
const SHOTS = join(ROOT, 'out', 'shots')

let app = null
let win = null
const logs = []

async function launch(withCreds = false) {
  if (app) return 'уже запущено (сначала quit)'
  const env = { ...process.env }
  if (!withCreds) {
    delete env.XET_TELEPORT_PASSWORD
    delete env.XET_TELEPORT_TOTP_SECRET
  }
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: ROOT,
    env
  })
  app.process().stdout?.on('data', (d) => logs.push(String(d)))
  app.process().stderr?.on('data', (d) => logs.push(String(d)))
  win = await app.firstWindow()
  await win.waitForSelector('.app', { timeout: 15_000 })
  return 'OK: окно готово'
}

async function screenshot(name) {
  mkdirSync(SHOTS, { recursive: true })
  const path = join(SHOTS, `${name || 'shot'}.png`)
  await win.screenshot({ path })
  return path
}

const need = () => {
  if (!win) throw new Error('приложение не запущено — сначала `launch`')
}

const commands = {
  help: async () =>
    'launch [--with-creds] | ss <имя> | click <селектор> | texts <селектор> | ' +
    'keys <текст> | press <сочетание> | enter | eval <js-выражение> | wait <мс> | ' +
    'logs [n] | quit | exit',
  launch: (args) => launch(args.includes('--with-creds')),
  ss: async (args) => (need(), screenshot(args[0])),
  click: async (args) => (need(), await win.click(args.join(' '), { timeout: 5000 }), 'OK'),
  texts: async (args) => (
    need(), JSON.stringify(await win.locator(args.join(' ')).allTextContents())
  ),
  keys: async (args) => (need(), await win.keyboard.type(args.join(' ')), 'OK'),
  // сочетание в формате Playwright: `Meta+k`, `Escape`, `Control+2` (хоткеи окна)
  press: async (args) => (need(), await win.keyboard.press(args.join(' ')), 'OK'),
  enter: async () => (need(), await win.keyboard.press('Enter'), 'OK'),
  eval: async (args) => {
    need()
    const result = await win.evaluate(args.join(' '))
    return result === undefined ? 'undefined' : JSON.stringify(result)
  },
  wait: (args) => new Promise((r) => setTimeout(() => r('OK'), Number(args[0]) || 500)),
  logs: async (args) => logs.slice(-(Number(args[0]) || 10)).join('') || '(пусто)',
  quit: async () => {
    await app?.close().catch(() => {})
    app = null
    win = null
    return 'OK: закрыто'
  }
}

async function repl() {
  const rl = createInterface({ input: process.stdin })
  process.stdout.write('driver> ')
  // строки обрабатываются строго последовательно — pipe-режим безопасен
  for await (const line of rl) {
    const [cmd, ...args] = line.trim().split(/\s+/)
    if (!cmd) continue
    if (cmd === 'exit') break
    try {
      const fn = commands[cmd]
      process.stdout.write((fn ? await fn(args) : `неизвестная команда: ${cmd} (help)`) + '\n')
    } catch (e) {
      process.stdout.write(`ERR: ${e.message}\n`)
    }
    process.stdout.write('driver> ')
  }
  await commands.quit()
}

async function smoke(withCreds) {
  const step = (msg) => console.log(`[smoke] ${msg}`)
  step('запуск приложения (собранного из out/)…')
  await launch(withCreds)
  await commands.wait(['2500']) // bootstrap → tsh status → событие status/update
  const chips = await win.locator('.header-left .chip').allTextContents()
  step(`статус-чипы: ${JSON.stringify(chips)}`)
  if (chips.length === 0) throw new Error('статус-чипы не отрисовались')
  step(`скриншот: ${await screenshot('smoke-1-initial')}`)

  step('клик Login…')
  await win.click('button.primary')
  await commands.wait(['4000'])
  const tabs = await win.locator('.tab').allTextContents()
  step(`табы: ${JSON.stringify(tabs)}`)
  if (!tabs.some((t) => t.includes('tsh login'))) {
    throw new Error('сессия tsh login не появилась')
  }
  step(`скриншот: ${await screenshot('smoke-2-after-login')}`)

  const stop = win.locator('.tab-stop')
  if ((await stop.count()) > 0) {
    step('живая сессия — завершаю (креды не вводим)…')
    await stop.click()
    await commands.wait(['1500'])
  }
  step(`скриншот: ${await screenshot('smoke-3-final')}`)
  step(`хвост логов main:\n${logs.slice(-5).join('')}`)
  await commands.quit()
  console.log('SMOKE OK')
}

const mode = process.argv[2] || 'repl'
const withCreds = process.argv.includes('--with-creds')
if (mode === 'smoke') {
  smoke(withCreds).catch(async (e) => {
    console.error('SMOKE FAIL:', e.message)
    try {
      if (win) console.error('скриншот падения:', await screenshot('smoke-fail'))
    } catch {}
    await commands.quit()
    process.exit(1)
  })
} else if (mode === 'repl') {
  repl().catch((e) => {
    console.error('ERR:', e)
    process.exit(1)
  })
} else {
  console.error(`неизвестный режим: ${mode} (smoke | repl)`)
  process.exit(1)
}
