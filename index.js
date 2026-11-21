/**
 * @local/dsh-wolfram — Wolfram Engine mathematics for DeepSeek Harness.
 *
 * A Host-only bundle: it registers the `wolfram` tool, the routing guidance that
 * tells the model when to reach for it, and (from M2) a per-step nudge for
 * demanding math problems. It imports nothing from `@deepseek-ai/*`, because a
 * profile bundle's module paths do not include the application archive; every
 * capability arrives through the injected `ctx` services.
 *
 * @module @local/dsh-wolfram
 */

import { cacheKey, createCache } from './lib/cache.js'
import { resolveConfig } from './lib/config.js'
import { bindNudger } from './lib/detect.js'
import { runWolfram } from './lib/executor.js'
import { presentCall, renderResult } from './lib/render.js'
import { bindSkill } from './lib/skill.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'wolfram-math'

/** Services this plugin registers into. */
export const inject = ['tools', 'systemPrompt']

/** Model-facing routing guidance; the parameters themselves are documented on the schema. */
const GUIDANCE = 'wolfram evaluates one Wolfram Language expression in a local Wolfram Engine kernel '
  + 'and returns InputForm plus LaTeX. Call it before answering when the work is exact symbolic '
  + 'mathematics (integrals, sums and series, limits, derivatives, differential equations, '
  + 'polynomial algebra, determinants, eigenvalues), when the numbers are large or precision '
  + 'matters, or when a derivation has several steps and a mistake would be costly. State '
  + 'assumptions explicitly (Assumptions -> a > 0); the kernel reports unresolved conditions as '
  + 'messages instead of guessing. Do the arithmetic you can do reliably yourself without a call, '
  + 'and never present a kernel result you did not receive.'

/** Tool description: behavior and boundaries, not implementation. */
const TOOL_DESCRIPTION = 'Evaluate one Wolfram Language expression in a local Wolfram Engine kernel and '
  + 'return its exact InputForm and LaTeX. Use it for exact symbolic math, large or stiff systems, '
  + 'high-precision numerics, and any derivation where a hand calculation could slip. Pass one '
  + 'expression; sequence steps with ";" or wrap them in Module. Not for plotting, file or network '
  + 'I/O, or shell commands.'

/**
 * Statuses worth reusing. A timeout or a crash is excluded on purpose: repeating
 * the call is the natural next step and must reach the kernel again.
 */
const CACHEABLE_STATUSES = new Set(['ok', 'syntax', 'failed'])

/**
 * Build the tool definition. The parameters are plain JSON Schema: the registry
 * validates only `output.schema`, so no `defineTool` import is needed.
 *
 * @param config - resolved plugin config.
 * @param cache - per-instance answer cache.
 * @param sandbox - holder for the optional sandbox binding installed by `apply`.
 * @returns a registry-ready tool definition.
 */
function toolDefinition(config, cache, sandbox) {
  return {
    name: 'wolfram',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: {
          type: 'string',
          description: 'One Wolfram Language expression, e.g. "Integrate[Exp[-x^2], {x, 0, Infinity}]". '
            + 'Use ";" or Module to sequence several steps; the last value is returned.',
        },
        timeoutSec: {
          type: 'number',
          description: `Wall-clock budget for the kernel, 1–${Math.floor(config.timeoutMs / 1000)}. `
            + `Defaults to ${Math.floor(config.timeoutMs / 1000)}.`,
        },
        label: {
          type: 'string',
          description: 'Short human label for the call card, e.g. "Gaussian integral".',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'inputForm', 'tex', 'messages', 'elapsedMs'],
        properties: {
          status: { type: 'string' },
          inputForm: { type: 'string' },
          tex: { type: 'string' },
          messages: { type: 'array', items: { type: 'string' } },
          elapsedMs: { type: 'number' },
          wallMs: { type: 'number' },
          sandboxed: { type: 'boolean' },
          truncated: { type: 'boolean' },
          cached: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(_args, value) }],
    },
    // Declarative only: the registry never enforces it. `execute` enforces its own
    // budget, and this value leaves room for kernel start-up and tree termination.
    timeoutMs: config.timeoutMs + 15_000,
    // Reads no process state; concurrent calls are bounded by `maxConcurrent`.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Normalize the timeout so an omitted `timeoutSec` and an explicit value
      // equal to the deployment budget share one cache entry.
      const effectiveTimeout = Number.isFinite(args?.timeoutSec)
        ? Math.floor(args.timeoutSec)
        : Math.floor(config.timeoutMs / 1000)
      const key = cacheKey(args?.code, effectiveTimeout)
      if (config.enableCache && typeof args?.code === 'string') {
        const hit = cache.get(key)
        if (hit !== undefined) return { ...hit, cached: true }
      }
      // The policy is per call, so the confiner is bound to this call's session.
      const binding = sandbox.current
      const confiner = binding === undefined
        ? undefined
        : (argv, signal) => binding.confine(argv, signal, exec?.agent?.session)
      const value = await runWolfram(args, config, exec?.signal, confiner)
      if (config.enableCache && CACHEABLE_STATUSES.has(value.status)) cache.set(key, value)
      return value
    },
    presentCall,
  }
}

/**
 * Register the plugin's contributions. Everything is registered on this context
 * and disposed with it.
 *
 * @param ctx - plugin context carrying `tools` and `systemPrompt`.
 * @param rawConfig - the bundle row's `config` mapping.
 * @returns cleanup for every registration made here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const disposers = []
  const cache = createCache({ maxEntries: config.cacheMaxEntries, ttlMs: config.cacheTtlMs })
  /** Holds the optional sandbox binding; undefined when the profile has none. */
  const sandbox = { current: undefined }

  if (config.enableTool) {
    disposers.push(ctx.tools.register(toolDefinition(config, cache, sandbox)))

    if (config.guidance) {
      disposers.push(ctx.systemPrompt.section({
        name: 'tool:wolfram',
        order: 120,
        // Empty when a restriction hides the tool, so guidance never advertises
        // a capability this agent cannot call.
        text: ({ scope, toolSet }) => (ctx.tools.get('wolfram', scope, toolSet) === undefined ? '' : GUIDANCE),
      }))
    }

    // Optional services: a profile without a sandbox still gets the tool. When they
    // are present, a confined session's policy decides whether the kernel runs
    // wrapped — the plugin never overrides the session's mode.
    if (config.sandbox === 'auto' && typeof ctx.inject === 'function') {
      ctx.inject(['sandbox', 'sandboxPolicy'], (scoped) => {
        sandbox.current = {
          async confine(argv, signal, session) {
            const policy = scoped.sandboxPolicy.resolve({ session })
            if (policy.mode === 'danger-full-access') {
              return { argv, sandboxed: false, denialSignatures: [] }
            }
            const confined = await scoped.sandbox.confine(argv, policy, signal)
            return {
              argv: confined.argv,
              sandboxed: true,
              denialSignatures: Array.isArray(confined.denialSignatures) ? confined.denialSignatures : [],
            }
          },
        }
      })
    }
  }

  // The nudge points at the tool, so it only exists while the tool does.
  if (config.enableTool && config.autoNudge !== 'off') disposers.push(bindNudger(ctx, config))

  // Optional service: a profile without a skill registry still gets the tool.
  if (config.enableSkill) {
    const skillDisposer = bindSkill(ctx)
    if (skillDisposer !== undefined) disposers.push(skillDisposer)
  }

  return () => {
    cache.clear()
    sandbox.current = undefined
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        // A registration that already unwound must not block the others.
      }
    }
  }
}
