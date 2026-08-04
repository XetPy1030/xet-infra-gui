import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Logger } from '@core/ports/Logger'

const execFileP = promisify(execFile)
const MARK = '__XET_PATH__'

/**
 * Классические грабли macOS (docs/03 §8): запуск из Dock/Finder не даёт PATH из
 * .zshrc. Один раз дёргаем login-shell и вытаскиваем PATH через маркер (мимо
 * любого мусора, который печатает rc-файл).
 */
export async function resolveShellEnv(
  logger: Logger
): Promise<Record<string, string | undefined>> {
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await execFileP(
      shell,
      ['-ilc', `printf "${MARK}%s${MARK}" "$PATH"`],
      { timeout: 8000, encoding: 'utf8' }
    )
    const m = new RegExp(`${MARK}([\\s\\S]*?)${MARK}`).exec(stdout)
    if (m?.[1]) {
      return { ...process.env, PATH: m[1] }
    }
    logger.warn('shellEnv: маркер PATH не найден в выводе login-shell')
  } catch (e) {
    logger.warn('shellEnv: не удалось получить PATH из login-shell', e)
  }
  return { ...process.env }
}

/**
 * Креды XET_TELEPORT_* не должны наследоваться дочерними процессами (PTY,
 * execFile): секрет в env любого спавна — лишняя поверхность утечки. Сам main
 * продолжает видеть process.env (EnvCredentialStore — dev-фолбэк).
 */
export function stripCredEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const clean = { ...env }
  for (const k of Object.keys(clean)) {
    if (k.startsWith('XET_TELEPORT_')) delete clean[k]
  }
  return clean
}

/** Найденный tsh: `found: false` — мастер первого запуска попросит указать путь (FR-C2). */
export interface TshPath {
  path: string
  found: boolean
}

/**
 * Путь к tsh: override из конфига, иначе поиск в резолвнутом PATH. `command -v`
 * годится и для абсолютного пути — заодно проверяет, что файл исполняемый.
 */
export async function resolveTshPath(
  env: Record<string, string | undefined>,
  override: string | null,
  logger: Logger
): Promise<TshPath> {
  const candidate = override?.trim() || 'tsh'
  try {
    const { stdout } = await execFileP('/bin/sh', ['-c', `command -v ${JSON.stringify(candidate)}`], {
      timeout: 4000,
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv
    })
    const p = stdout.trim()
    if (p) return { path: p, found: true }
  } catch {
    /* не нашли — скажем об этом ниже, приложение стартует и без tsh */
  }
  logger.warn(
    `tsh не найден (${candidate}) — задай путь в конфиге (teleport.tshPath) или поправь PATH`
  )
  return { path: candidate, found: false }
}
