/**
 * Spawns `wolframscript` once per call and turns its JSON envelope into a
 * structured tool result.
 *
 * Two invariants drive the design:
 *  - No shell strings. `-code` argument quoting is destroyed by Windows shells
 *    (PowerShell strips the quotes inside `Print["x"]`), so code travels as a
 *    UTF-8 file and the launcher gets exactly two argv entries.
 *  - Two timeouts. `runner.wls` enforces the model's budget inside the kernel so
 *    a result is still exported; this module enforces a hard ceiling for the
 *    case where the kernel never returns.
 *
 * @module @local/dsh-wolfram/lib/executor
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The launcher script shipped beside this module. */
const RUNNER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'runner.wls')

/** Kernel start-up alone measured 3–7 s; the hard ceiling only guards a hung kernel. */
const HARD_OVERHEAD_MS = 20_000

/** Per-stream capture bound; stderr is diagnostic only. */
const MAX_STREAM_CHARS = 64 * 1024

/** Diagnostics kept in the result's `detail` field. */
const MAX_DETAIL_CHARS = 800

/** Statuses `runner.wls` may report. */
const KERNEL_STATUSES = new Set(['ok', 'syntax', 'failed', 'timeout'])

let active = 0
const waiters = []

/**
 * Run `task` while holding one of `limit` slots. Waiters re-check after waking,
 * so a burst of calls cannot exceed the cap.
 *
 * @param limit - maximum concurrent kernels.
 * @param task - work to run inside the slot.
 * @returns the task's value.
 */
async function withSlot(limit, task) {
  while (active >= limit) {
    await new Promise(resolve => waiters.push(resolve))
  }
  active += 1
  try {
    return await task()
  } finally {
    active -= 1
    for (const wake of waiters.splice(0)) wake()
  }
}

/**
 * Terminate a launcher and anything it started. On Windows `child.kill()` can
 * leave the kernel process behind, so the tree is killed explicitly.
 *
 * @param child - the spawned launcher.
 */
function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

/**
 * Spawn one execution and settle exactly once on close, spawn error, abort, or
 * the hard ceiling.
 *
 * @param argv - complete command line to spawn: the kernel directly, or the
 *   sandbox runner wrapping it. `argv[0]` is the program.
 * @param budgetMs - the model-facing kernel budget, used to derive the ceiling.
 * @param signal - caller cancellation.
 * @returns exit code, captured streams, and which watchdog fired.
 */
function runLauncher(argv, budgetMs, signal) {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let killedBy
    let settled = false
    let child

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(ceiling)
      clearTimeout(afterKill)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...outcome, stdout, stderr, wallMs: Date.now() - started })
    }

    const onAbort = () => {
      if (killedBy !== undefined) return
      killedBy = 'abort'
      killTree(child)
      // A launcher that ignores the kill must not hang the tool call.
      afterKill = setTimeout(() => finish({ code: null, killedBy, spawnError: undefined }), 5_000)
      afterKill.unref?.()
    }

    let afterKill
    const ceiling = setTimeout(() => {
      if (killedBy !== undefined) return
      killedBy = 'ceiling'
      killTree(child)
      afterKill = setTimeout(() => finish({ code: null, killedBy, spawnError: undefined }), 5_000)
      afterKill.unref?.()
    }, budgetMs + HARD_OVERHEAD_MS)
    ceiling.unref?.()

    try {
      // `-script` sets `$InputFileName` for `runner.wls`; `-noprompt` keeps the
      // kernel from waiting on an error. A confined launch replaces this argv
      // wholesale with the sandbox runner's own.
      child = spawn(argv[0], argv.slice(1), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ code: null, killedBy, spawnError: error })
      return
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STREAM_CHARS) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STREAM_CHARS) stderr += chunk
    })
    child.on('error', error => finish({ code: null, killedBy, spawnError: error }))
    child.on('close', code => finish({ code, killedBy, spawnError: undefined }))
  })
}

/**
 * Bound a model-facing string.
 *
 * @param value - raw text.
 * @param max - character cap.
 * @returns the capped text.
 */
function bound(value, max) {
  if (typeof value !== 'string') return ''
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

/** The marker `runner.wls` prints immediately before its JSON envelope. */
const RESULT_MARKER = '@@DSH-WOLFRAM-RESULT@@'

/**
 * Extract the JSON envelope from the kernel's stdout.
 *
 * @param stdout - captured standard output, which also carries kernel messages.
 * @returns the last marked payload, or undefined when the runner never printed one.
 */
function envelopeFromStdout(stdout) {
  const index = stdout.lastIndexOf(RESULT_MARKER)
  if (index < 0) return undefined
  // The runner writes the envelope last, so everything after the marker is the
  // payload — including its formatting newlines, which JSON parsing accepts.
  const payload = stdout.slice(index + RESULT_MARKER.length).trim()
  return payload.length > 0 ? payload : undefined
}

/**
 * Trim captured text down to something a model can act on.
 *
 * @param text - captured standard error or output.
 * @returns one bounded line-block, or an empty string.
 */
function tailOf(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length === 0) return ''
  return bound(trimmed.split('\n').slice(-6).join('\n'), MAX_DETAIL_CHARS)
}

/**
 * Build a result with every field present, so `output.schema` validation and the
 * renderer never see a hole.
 *
 * @param fields - the partial result.
 * @returns a complete tool result value.
 */
function result(fields) {
  const elapsedMs = Number.isFinite(fields.elapsedMs) ? Math.round(fields.elapsedMs) : 0
  return {
    status: fields.status,
    inputForm: fields.inputForm ?? '',
    tex: fields.tex ?? '',
    messages: fields.messages ?? [],
    elapsedMs,
    // Wall time is what the caller waited; for statuses that never evaluate it is
    // the only meaningful number, so it defaults to the elapsed value.
    wallMs: Number.isFinite(fields.wallMs) ? Math.round(fields.wallMs) : elapsedMs,
    // Whether this run went through the session's sandbox. Carried so a reader can
    // tell a confined result from an unconfined one instead of assuming.
    sandboxed: fields.sandboxed === true,
    truncated: fields.truncated ?? false,
    detail: bound(fields.detail ?? '', MAX_DETAIL_CHARS),
  }
}

/**
 * Find the sandbox denial signature the backend would have printed.
 *
 * @param stderr - captured standard error.
 * @param signatures - the selected backend's denial dialect.
 * @returns the matched signature, or undefined.
 */
function denialIn(stderr, signatures) {
  if (!Array.isArray(signatures)) return undefined
  const lower = stderr.toLowerCase()
  return signatures.find(signature => typeof signature === 'string' && lower.includes(signature.toLowerCase()))
}

/**
 * Find the first denied construct in the code.
 *
 * @param code - candidate Wolfram Language source.
 * @param patterns - configured lexical patterns.
 * @returns the matched pattern, or undefined.
 */
function deniedBy(code, patterns) {
  for (const pattern of patterns) {
    if (code.includes(pattern)) return pattern
  }
  return undefined
}

/**
 * Evaluate one Wolfram Language expression.
 *
 * @param args - model arguments: `code`, optional `timeoutSec`.
 * @param config - resolved plugin config.
 * @param signal - the calling tool's cancellation signal.
 * @param confiner - optional sandbox hook: receives the kernel argv and returns
 *   the argv to spawn plus whether it is confined.
 * @returns the structured tool result described by the tool's output schema.
 */
export async function runWolfram(args, config, signal, confiner) {
  const code = typeof args?.code === 'string' ? args.code : ''
  if (code.trim().length === 0) {
    return result({ status: 'syntax', detail: 'code must be a non-empty Wolfram Language expression' })
  }

  const denied = deniedBy(code, config.denyPatterns)
  if (denied !== undefined) {
    return result({
      status: 'denied',
      detail: `code contains the refused construct ${JSON.stringify(denied)}; this tool is for mathematics, not system or network access`,
    })
  }

  const ceilingSec = Math.floor(config.timeoutMs / 1000)
  const requested = Number.isFinite(args?.timeoutSec) ? Math.floor(args.timeoutSec) : ceilingSec
  const budgetSec = Math.max(1, Math.min(requested, ceilingSec))

  return withSlot(config.maxConcurrent, async () => {
    if (signal?.aborted) {
      return result({ status: 'cancelled', detail: 'the call was cancelled before the kernel started' })
    }

    const dir = await mkdtemp(join(tmpdir(), 'dsh-wolfram-'))
    try {
      await copyFile(RUNNER_SOURCE, join(dir, 'runner.wls'))
      await writeFile(join(dir, 'code.wl'), code, 'utf8')
      await writeFile(join(dir, 'timeout.txt'), String(budgetSec), 'utf8')

      const argv = [config.kernelPath, '-noprompt', '-script', join(dir, 'runner.wls')]
      let launch = { argv, sandboxed: false, denialSignatures: [] }
      if (confiner !== undefined && config.sandbox !== 'off') {
        try {
          launch = await confiner(argv, signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const unavailable = error?.code === 'SANDBOX_UNAVAILABLE'
            || error?.name === 'SandboxUnavailableError'
          return result({
            status: 'crashed',
            detail: unavailable
              ? `the session's sandbox could not be enforced (${message}); refusing to run the kernel `
                + "unconfined. Set sandbox: 'off' to run without confinement."
              : `the sandbox could not wrap the kernel (${message})`,
          })
        }
      }

      const outcome = await runLauncher(launch.argv, budgetSec * 1000, signal)

      if (outcome.killedBy === 'abort' || signal?.aborted) {
        return result({
          status: 'cancelled',
          elapsedMs: outcome.wallMs,
          sandboxed: launch.sandboxed,
          detail: 'the call was cancelled; no result was returned',
        })
      }

      // The envelope arrives on stdout, because a confined kernel may be unable to
      // write anywhere. The file remains a fallback for an older runner copy.
      let raw = envelopeFromStdout(outcome.stdout)
      if (raw === undefined) {
        try {
          raw = await readFile(join(dir, 'result.json'), 'utf8')
        } catch {
          raw = undefined
        }
      }

      let payload
      let parseError
      if (raw !== undefined) {
        try {
          // A byte-order mark would defeat JSON.parse; tolerate it.
          payload = JSON.parse(raw.replace(/^\uFEFF/, ''))
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error)
        }
      }

      if (payload !== undefined && KERNEL_STATUSES.has(payload.status)) {
        const inputMax = config.maxOutputChars
        const texMax = Math.min(2_000, config.maxOutputChars)
        const inputForm = bound(String(payload.inputForm ?? ''), inputMax)
        const tex = bound(String(payload.tex ?? ''), texMax)
        const messages = Array.isArray(payload.messages)
          ? payload.messages.slice(0, 12).map(message => bound(String(message), 200))
          : []
        return result({
          status: payload.status,
          inputForm,
          tex,
          messages,
          elapsedMs: Number(payload.elapsedMs),
          wallMs: outcome.wallMs,
          sandboxed: launch.sandboxed,
          truncated: String(payload.inputForm ?? '').length > inputMax || String(payload.tex ?? '').length > texMax,
        })
      }

      if (outcome.spawnError !== undefined) {
        const code = outcome.spawnError.code ?? outcome.spawnError.name
        return result({
          status: 'crashed',
          elapsedMs: outcome.wallMs,
          sandboxed: launch.sandboxed,
          detail: code === 'ENOENT' || code === 'EACCES'
            ? `could not start ${config.kernelPath} (${code}); check the plugin's kernelPath`
            : `could not start the Wolfram Engine (${code}): ${outcome.spawnError.message}`,
        })
      }

      if (outcome.killedBy === 'ceiling') {
        // The kernel ignored its own budget and had to be killed: that is still a
        // timeout from the caller's point of view, not an engine failure.
        return result({
          status: 'timeout',
          elapsedMs: outcome.wallMs,
          sandboxed: launch.sandboxed,
          detail: `the kernel exceeded its ${budgetSec} s budget plus ${HARD_OVERHEAD_MS / 1000} s of start-up grace and was terminated`,
        })
      }

      if (parseError !== undefined) {
        return result({
          status: 'crashed',
          elapsedMs: outcome.wallMs,
          sandboxed: launch.sandboxed,
          detail: `the kernel wrote a result this plugin could not read (${parseError}); `
            + `first bytes: ${bound(raw ?? '', 200)}`,
        })
      }

      const tail = tailOf(outcome.stderr)
      const output = tailOf(outcome.stdout)
      const denied = launch.sandboxed ? denialIn(outcome.stderr, launch.denialSignatures) : undefined
      return result({
        status: 'crashed',
        elapsedMs: outcome.wallMs,
        sandboxed: launch.sandboxed,
        detail: denied !== undefined
          ? `the run was confined and the sandbox denied a file write (${denied}); `
            + 'the kernel could not produce its result'
          : tail.length > 0
            ? `the kernel exited with code ${outcome.code} and produced no result:\n${tail}`
            : output.length > 0
              ? `the kernel exited with code ${outcome.code} and produced no result; output:\n${output}`
              : `the kernel exited with code ${outcome.code} and produced no result; check that the Wolfram Engine is activated`,
      })
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
}
