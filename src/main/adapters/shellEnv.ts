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

/** Абсолютный путь к tsh: override из конфига → `command -v` в резолвнутом PATH → «tsh». */
export async function resolveTshPath(
  env: Record<string, string | undefined>,
  override: string | null,
  logger: Logger
): Promise<string> {
  if (override) return override
  try {
    const { stdout } = await execFileP('/bin/sh', ['-c', 'command -v tsh'], {
      timeout: 4000,
      encoding: 'utf8',
      env: env as NodeJS.ProcessEnv
    })
    const p = stdout.trim()
    if (p) return p
  } catch {
    /* не нашли — упадём осмысленно ниже по стеку */
  }
  logger.warn('tsh не найден в PATH — оставляю «tsh», задай путь в config.json (teleport.tshPath)')
  return 'tsh'
}
