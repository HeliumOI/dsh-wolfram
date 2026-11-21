/**
 * Configuration resolution for @local/dsh-wolfram.
 *
 * The bundle intentionally ships no `Config` export: that would require the
 * Schemastery schema object from the installation, and a profile bundle cannot
 * resolve `@deepseek-ai/*` (module paths outside `resourcesPath` do not include
 * the app archive). Defaults and validation live here instead, and a bad value
 * fails plugin activation with a message that names the field.
 *
 * @module @local/dsh-wolfram/lib/config
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Wolfram Engine releases install under this root on Windows. */
const ENGINE_ROOT = 'C:\\Program Files\\Wolfram Research\\Wolfram Engine'

/** Mathematica installs expose the same launcher under a different root. */
const MATHEMATICA_ROOT = 'C:\\Program Files\\Wolfram Research\\Mathematica'

/** Relative path of the launcher inside an installation root. */
const LAUNCHER = 'SystemFiles\\Kernel\\Binaries\\Windows-x86-64\\wolframscript.exe'

/**
 * Candidate kernel binaries beside a launcher.
 *
 * The plugin runs the kernel directly rather than through `wolframscript`:
 * `wolframscript` opens its own configuration file under the user profile for
 * writing, which a confined process cannot do, so it silently evaluates nothing
 * under the Windows sandbox. The kernel needs no such write.
 *
 * @param launcherPath - absolute path of the `wolframscript` launcher.
 * @returns sibling candidates, most likely first.
 */
function kernelCandidates(launcherPath) {
  const dir = dirname(launcherPath)
  return process.platform === 'win32'
    ? [join(dir, 'wolfram.exe')]
    : [join(dir, 'wolfram'), join(dir, 'WolframKernel'), join(dir, 'MathKernel')]
}

/**
 * Pick the newest installed Wolfram launcher, so a version upgrade does not
 * require editing the profile patch.
 *
 * @param root - installation root such as `C:\Program Files\Wolfram Research\Wolfram Engine`.
 * @returns the launcher path, or undefined when this root has none.
 */
function newestUnder(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    // Version directories sort numerically, newest last.
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .reverse()
  for (const version of candidates) {
    const launcher = join(root, version, LAUNCHER)
    if (existsSync(launcher)) return launcher
  }
  return undefined
}

/**
 * Resolve the launcher the plugin should spawn.
 *
 * @returns an absolute launcher path, or `'wolframscript'` to let the OS resolve
 *   it from PATH; undefined only when nothing was configured or discovered.
 */
export function detectWolframscript() {
  const found = newestUnder(ENGINE_ROOT) ?? newestUnder(MATHEMATICA_ROOT)
  if (found !== undefined) return found
  return process.platform === 'win32' ? undefined : 'wolframscript'
}

/** Defaults applied when the bundle row omits a field. */
export const DEFAULTS = {
  /** Kernel budget per call, in milliseconds. */
  timeoutMs: 30_000,
  /** Cap on the rendered `inputForm` string. */
  maxOutputChars: 6_000,
  /** Cap on concurrent kernels across all sessions. */
  maxConcurrent: 2,
  /** Nudge mode: `off`, `heuristic` (default since M2), or `model` (reserved). */
  autoNudge: 'heuristic',
  /** Score at or above which the M2 nudger fires. */
  nudgeThreshold: 5,
  /** Register the `wolfram` tool at all. */
  enableTool: true,
  /** Contribute the routing guidance section. */
  guidance: true,
  /** Register the bundled Wolfram Language skill when a skill registry exists. */
  enableSkill: true,
  /** Reuse an identical recent answer instead of starting another kernel. */
  enableCache: true,
  /**
   * `auto` confines the kernel whenever the calling session's policy is confined;
   * `off` always runs unconfined (the pre-M4b behaviour).
   */
  sandbox: 'auto',
  /** Bounded LRU size for cached answers. */
  cacheMaxEntries: 16,
  /** How long a cached answer stays reusable. */
  cacheTtlMs: 600_000,
  /** Lexical refusals. Advisory only — never a security boundary. */
  denyPatterns: ['Run[', 'SystemOpen[', 'DeleteFile[', 'Import["http'],
}

const OWN_KEYS = new Set([
  'kernelPath',
  'wolframscriptPath',
  'timeoutMs',
  'maxOutputChars',
  'maxConcurrent',
  'autoNudge',
  'nudgeThreshold',
  'enableTool',
  'guidance',
  'enableSkill',
  'enableCache',
  'sandbox',
  'cacheMaxEntries',
  'cacheTtlMs',
  'denyPatterns',
])

/**
 * Validate one integer field.
 *
 * @param field - field name for the error message.
 * @param value - candidate value.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the validated integer.
 */
function integerField(field, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`wolfram-math: ${field} must be an integer from ${min} to ${max}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate one boolean field.
 *
 * @param field - field name for the error message.
 * @param value - candidate value.
 * @returns the validated boolean.
 */
function booleanField(field, value) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`wolfram-math: ${field} must be true or false, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Resolve and validate the bundle row's config.
 *
 * @param raw - the `config` mapping from `cordis.patch.yml`, possibly undefined.
 * @returns a frozen, fully defaulted config object.
 * @throws TypeError when a field is invalid, so activation fails loudly instead
 *   of silently behaving like a different plugin.
 */
export function resolveConfig(raw) {
  const input = raw ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('wolfram-math: config must be a mapping')
  }
  for (const key of Object.keys(input)) {
    if (!OWN_KEYS.has(key)) throw new TypeError(`wolfram-math: unknown config field "${key}"`)
  }

  const timeoutMs = integerField('timeoutMs', input.timeoutMs ?? DEFAULTS.timeoutMs, 1_000, 600_000)
  const autoNudge = input.autoNudge ?? DEFAULTS.autoNudge
  if (!['off', 'heuristic', 'model'].includes(autoNudge)) {
    throw new TypeError(`wolfram-math: autoNudge must be "off", "heuristic" or "model", got ${JSON.stringify(autoNudge)}`)
  }
  const denyPatterns = input.denyPatterns ?? DEFAULTS.denyPatterns
  if (!Array.isArray(denyPatterns) || denyPatterns.some(pattern => typeof pattern !== 'string' || pattern.length === 0)) {
    throw new TypeError('wolfram-math: denyPatterns must be an array of non-empty strings')
  }
  const sandbox = input.sandbox ?? DEFAULTS.sandbox
  if (!['auto', 'off'].includes(sandbox)) {
    throw new TypeError(`wolfram-math: sandbox must be "auto" or "off", got ${JSON.stringify(sandbox)}`)
  }

  const configuredPath = input.wolframscriptPath ?? detectWolframscript()
  if (input.kernelPath === undefined && (typeof configuredPath !== 'string' || configuredPath.length === 0)) {
    throw new TypeError(
      'wolfram-math: no Wolfram installation was found; set kernelPath to the absolute path of '
      + 'wolfram.exe (or set wolframscriptPath so the kernel beside it can be located)',
    )
  }

  // The kernel is what actually runs; `wolframscriptPath` is only a locator.
  let kernelPath = input.kernelPath
  if (kernelPath === undefined) {
    kernelPath = kernelCandidates(configuredPath).find(candidate => existsSync(candidate))
    if (kernelPath === undefined) {
      throw new TypeError(
        `wolfram-math: no kernel binary found beside ${configuredPath} `
        + `(looked for ${kernelCandidates(configuredPath).join(', ')}); `
        + 'set kernelPath to the absolute path of wolfram.exe',
      )
    }
  }
  if (typeof kernelPath !== 'string' || kernelPath.length === 0 || !existsSync(kernelPath)) {
    throw new TypeError(
      `wolfram-math: kernelPath ${JSON.stringify(kernelPath)} does not exist; `
      + 'set it to the absolute path of wolfram.exe',
    )
  }

  return Object.freeze({
    kernelPath,
    wolframscriptPath: configuredPath,
    timeoutMs,
    maxOutputChars: integerField('maxOutputChars', input.maxOutputChars ?? DEFAULTS.maxOutputChars, 500, 100_000),
    maxConcurrent: integerField('maxConcurrent', input.maxConcurrent ?? DEFAULTS.maxConcurrent, 1, 8),
    autoNudge,
    nudgeThreshold: integerField('nudgeThreshold', input.nudgeThreshold ?? DEFAULTS.nudgeThreshold, 0, 50),
    enableTool: booleanField('enableTool', input.enableTool ?? DEFAULTS.enableTool),
    guidance: booleanField('guidance', input.guidance ?? DEFAULTS.guidance),
    enableSkill: booleanField('enableSkill', input.enableSkill ?? DEFAULTS.enableSkill),
    enableCache: booleanField('enableCache', input.enableCache ?? DEFAULTS.enableCache),
    sandbox,
    cacheMaxEntries: integerField('cacheMaxEntries', input.cacheMaxEntries ?? DEFAULTS.cacheMaxEntries, 1, 200),
    cacheTtlMs: integerField('cacheTtlMs', input.cacheTtlMs ?? DEFAULTS.cacheTtlMs, 1_000, 86_400_000),
    denyPatterns: Object.freeze([...denyPatterns]),
  })
}
