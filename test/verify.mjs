#!/usr/bin/env node
/**
 * M1 acceptance harness for @local/dsh-wolfram.
 *
 * Runs the plugin against a minimal fake Host context and against the real
 * Wolfram Engine, so every part of M1 except the DSH registry itself is
 * exercised:
 *   - manifest, exports, and the no-`@deepseek-ai` import rule
 *   - config resolution and autodetection
 *   - tool registration shape and the model-facing schema
 *   - guidance section that disappears when the tool is hidden
 *   - per-step nudge wiring (scorer injected, so M2 rules are not required)
 *   - live kernel calls: success, kernel messages, syntax error, Unicode, timeout
 *   - cancellation and orphan-process cleanup
 *
 * Run with the DSH Electron runtime so the spawn happens in an ordinary Node
 * process outside the tool sandbox:
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/verify.mjs
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject, name as pluginName } from '../index.js'
import { resolveConfig } from '../lib/config.js'
import { bindNudger } from '../lib/detect.js'
import { renderResult } from '../lib/render.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const results = []

/**
 * Run one acceptance check and record its outcome.
 *
 * @param label - what is being verified.
 * @param fn - check body; return a short detail string.
 */
async function check(label, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ label, ok: true, detail: detail ?? '', ms: Date.now() - started })
  } catch (error) {
    results.push({ label, ok: false, detail: error?.message ?? String(error), ms: Date.now() - started })
  }
}

/**
 * Build a Host context that records what the plugin registers.
 *
 * @param options - `skills: false` emulates a profile with no skill registry.
 */
function fakeHost(options = {}) {
  const tools = []
  const sections = []
  const listeners = []
  const skills = []
  const confineCalls = []
  const skillRegistryAvailable = options.skills !== false
  const sandboxAvailable = options.sandbox !== false
  const policy = options.policy ?? { mode: 'workspace-write', workspaceRoot: process.cwd() }

  const skillsService = {
    register(skill) {
      skills.push(skill)
      return () => {
        const index = skills.indexOf(skill)
        if (index >= 0) skills.splice(index, 1)
      }
    },
  }

  const sandboxService = {
    async confine(argv, resolvedPolicy, signal) {
      confineCalls.push({ argv: [...argv], policy: resolvedPolicy, signal })
      if (options.confine !== undefined) return options.confine(argv, resolvedPolicy)
      return { argv: [...argv], enforcement: 'partial', denialSignatures: ['EACCES'], runnerFailureRules: [] }
    },
  }
  const policyService = { resolve: () => ({ ...policy }) }

  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
      get(toolName) {
        return tools.find(tool => tool.name === toolName)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      getSectionOrder() {
        return 120
      },
    },
    on(event, handler, opts) {
      listeners.push({ event, handler, options: opts })
      return () => {
        const index = listeners.indexOf(listeners.at(-1))
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    // Mirrors `ctx.inject(deps, cb)`: the callback runs only when EVERY requested
    // service is present, and its return value is the disposer.
    inject(services, callback) {
      const provided = {}
      for (const service of services) {
        if (service === 'skills' && skillRegistryAvailable) provided.skills = skillsService
        if (service === 'sandbox' && sandboxAvailable) provided.sandbox = sandboxService
        if (service === 'sandboxPolicy' && sandboxAvailable) provided.sandboxPolicy = policyService
      }
      if (!services.every(service => service in provided)) return undefined
      return callback(provided)
    },
  }
  return { ctx, tools, sections, listeners, skills, confineCalls }
}

/** A user message as the agent loop hands it to `agent/pre-step`. */
function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** Collect the plugin's own JavaScript sources. */
function sourceFiles() {
  const files = [join(ROOT, 'index.js')]
  for (const entry of readdirSync(join(ROOT, 'lib'))) {
    if (entry.endsWith('.js')) files.push(join(ROOT, 'lib', entry))
  }
  return files
}

/** Wait, without a timer dependency. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Count surviving Wolfram processes. */
function survivingWorframProcesses() {
  const images = ['wolframscript.exe', 'WolframKernel.exe', 'MathKernel.exe']
  const alive = []
  for (const image of images) {
    let output = ''
    try {
      output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    } catch {
      return { checked: false, alive }
    }
    if (/^"[^"]+\.exe"/m.test(output)) alive.push(image)
  }
  return { checked: true, alive }
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

await check('manifest declares the bundle patch and exports', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['.'], './index.js')
  assert.ok(manifest.exports['./icon'], 'must export ./icon')
  assert.ok(manifest.files.includes('lib'), 'must ship lib/')
  return `name=${manifest.name} v${manifest.version}`
})

await check('no @deepseek-ai imports (profile bundles cannot resolve them)', () => {
  const offenders = []
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8')
    if (/(?:from\s+|require\(\s*|import\(\s*)['"]@deepseek-ai\//.test(text)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `bare DSH imports found in ${offenders.join(', ')}`)
  return `${sourceFiles().length} files scanned`
})

await check('locale metadata parses, is localized, and discloses the risk', () => {
  const metas = {}
  for (const locale of ['en', 'zh']) {
    const meta = JSON.parse(readFileSync(join(ROOT, 'locale', `${locale}.json`), 'utf8')).meta
    assert.ok(meta.title.length > 2, `${locale} title`)
    assert.ok(meta.description.length > 40, `${locale} description must explain the capability`)
    if (meta.detail !== undefined) {
      const document = readFileSync(join(ROOT, meta.detail), 'utf8').trim()
      assert.match(document, /^!\[[^\]]+\]\([^)]+\)$/u,
        'a declared detail document must hold exactly one image line, with no prose')
    }
    metas[locale] = meta
  }
  // Consent happens on the Plugins row, so the execution risk must be there.
  assert.match(metas.en.description, /sandbox/i, 'English description must name the risk')
  assert.match(metas.zh.description, /沙箱/, 'the Chinese description must name the risk')
  assert.ok(!/\s[A-Z]/.test(metas.en.title), `English titles use sentence case, got "${metas.en.title}"`)
  assert.ok(!/^[A-Za-z ]+$/.test(metas.zh.title), 'the Chinese locale must be translated, not copied')
  if (metas.en.detail === undefined) {
    assert.ok(existsSync(join(ROOT, 'README.md')), 'without a declared document the README is the detail page')
  }
  return `en="${metas.en.title}" zh="${metas.zh.title}"`
})

await check('icon follows the artwork convention (36px, no tile)', () => {
  const bytes = readFileSync(join(ROOT, 'icon.svg'))
  assert.ok(bytes.length < 256 * 1024, 'icon must stay under the 256 KiB limit')
  const text = bytes.toString('utf8')
  assert.match(text, /^<svg[\s>]/, 'icon must start with an <svg> element')
  assert.match(text, /width="36" height="36" viewBox="0 0 36 36"/, 'the panel draws the tile; the icon is 36x36')
  assert.ok(!/<rect\b/.test(text), 'do not draw a background tile; leave it transparent')
  assert.ok(!/<text\b|<style\b|<script\b/.test(text), 'keep the icon self-contained paths only')
  return `${bytes.length} bytes`
})

await check('config resolves the kernel binary and rejects bad paths', () => {
  const config = resolveConfig({})
  assert.match(config.kernelPath, /wolfram\.exe$/i, 'the kernel is what runs, not the launcher')
  assert.ok(existsSync(config.kernelPath))
  assert.match(config.wolframscriptPath, /wolframscript\.exe$/i, 'the launcher is only a locator')
  assert.equal(config.autoNudge, 'heuristic', 'M2 ships the nudger on')
  assert.equal(config.enableCache, true, 'M3 ships the cache on')
  assert.equal(config.enableSkill, true, 'M3 ships the skill on')
  assert.equal(config.cacheMaxEntries, 16)
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config field/)
  assert.throws(() => resolveConfig({ timeoutMs: 10 }), /timeoutMs/)
  assert.throws(() => resolveConfig({ cacheTtlMs: 10 }), /cacheTtlMs/)
  assert.throws(() => resolveConfig({ cacheMaxEntries: 0 }), /cacheMaxEntries/)
  assert.throws(() => resolveConfig({ kernelPath: 'C:\\definitely-not-here.exe' }), /kernelPath/)
  return config.kernelPath
})

// ---------------------------------------------------------------------------
// Registration checks
// ---------------------------------------------------------------------------

const host = fakeHost()
const dispose = apply(host.ctx, { timeoutMs: 30_000 })
const tool = host.tools[0]

await check('registers exactly one tool and one guidance section', () => {
  assert.equal(pluginName, 'wolfram-math')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.equal(host.tools.length, 1)
  assert.equal(host.tools[0].name, 'wolfram')
  assert.equal(host.sections.length, 1)
  assert.equal(host.sections[0].name, 'tool:wolfram')
  return `tool=${host.tools[0].name}, section=${host.sections[0].name}`
})

await check('model-facing parameter and output schemas are well formed', () => {
  const { parameters, output } = tool
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['code'])
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['code', 'label', 'timeoutSec'])
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 80, 'description must explain when to use the tool')
  assert.equal(output.schema.type, 'object')
  assert.ok(Array.isArray(output.schema.required), 'output schema must use a required array')
  assert.equal(typeof output.render, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.timeoutMs > 30_000, 'declarative budget must exceed the kernel budget')
  return `${Object.keys(parameters.properties).join(', ')}; output=${output.schema.required.join(', ')}`
})

await check('guidance follows tool visibility and disposal withdraws both', () => {
  const section = host.sections[0]
  const visible = section.text({ scope: undefined, toolSet: undefined })
  assert.ok(visible.includes('Wolfram Language'), 'guidance must name the language')
  assert.ok(visible.includes('Assumptions'), 'guidance must ask for assumptions')

  const hiddenHost = fakeHost()
  const hiddenDispose = apply(hiddenHost.ctx, { enableTool: true, guidance: true })
  hiddenHost.tools.length = 0 // simulate a restriction hiding the tool
  const hidden = hiddenHost.sections[0].text({ scope: undefined, toolSet: undefined })
  assert.equal(hidden, '', 'guidance must vanish when the tool is hidden')
  hiddenDispose()

  const afterDispose = fakeHost()
  const drop = apply(afterDispose.ctx, {})
  drop()
  assert.equal(afterDispose.tools.length, 0)
  assert.equal(afterDispose.sections.length, 0)
  return `guidance ${visible.length} chars; hidden=>empty; dispose=>clean`
})

await check('nudge wiring injects once per turn and only above threshold', async () => {
  const nudging = fakeHost()
  const stop = bindNudger(nudging.ctx, { nudgeThreshold: 5 }, () => ({ score: 9, reasons: ['test'] }))
  const listener = nudging.listeners.find(entry => entry.event === 'agent/pre-step')
  assert.ok(listener, 'pre-step listener must be registered')
  assert.equal(listener.options?.prepend, true, 'must prepend so the nudge follows other context')

  const decision = { kind: 'enter', messages: [userMessage('求解 x^3 - 2x + 1 = 0 的精确根')] }
  const payload = () => ({
    agent: { session: { id: 'session-1' } },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    modelSelection: {},
  })
  const first = await listener.handler(payload(), async () => decision)
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.kind, 'wolfram-math')
  assert.equal(first.messages[1].source.form, 'snapshot')
  assert.equal(first.messages[1].source.sections[0].name, 'wolfram-math')
  assert.ok(first.messages[1].id, 'injected message needs an id')

  const again = await listener.handler(payload(), async () => decision)
  assert.equal(again.messages.length, 1, 'one nudge per turn')

  const nextTurn = await listener.handler({ ...payload(), turn: 2 }, async () => decision)
  assert.equal(nextTurn.messages.length, 2, 'a new turn may nudge again')

  const quiet = fakeHost()
  const stopQuiet = bindNudger(quiet.ctx, { nudgeThreshold: 5 }, () => ({ score: 0, reasons: [] }))
  const quietListener = quiet.listeners.find(entry => entry.event === 'agent/pre-step')
  const silent = await quietListener.handler(payload(), async () => decision)
  assert.equal(silent.messages.length, 1, 'below threshold must not inject')

  stop()
  stopQuiet()
  return 'inject/once-per-turn/new-turn/silent all hold'
})

await check('autoNudge "off" registers no pre-step listener', () => {
  const idle = fakeHost()
  const stop = apply(idle.ctx, { autoNudge: 'off' })
  assert.equal(idle.listeners.length, 0)
  stop()
  return 'no listeners with autoNudge=off'
})

/** Drive one `agent/pre-step` through a real plugin instance. */
async function preStep(prompt) {
  const host = fakeHost()
  const stop = apply(host.ctx, {})
  const listener = host.listeners.find(entry => entry.event === 'agent/pre-step')
  assert.ok(listener, 'autoNudge=heuristic must register the pre-step listener')
  const decision = { kind: 'enter', messages: [userMessage(prompt)] }
  const result = await listener.handler({
    agent: { session: { id: 'session-m2' } },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    modelSelection: {},
  }, async () => decision)
  stop()
  return result
}

await check('T7 a demanding math prompt is nudged with the shipped rules', async () => {
  const decision = await preStep('求解 x^3-2x+1=0 的精确根')
  assert.equal(decision.messages.length, 2, 'exactly one nudge is appended')
  const nudge = decision.messages[1]
  assert.equal(nudge.role, 'user')
  assert.equal(typeof nudge.id, 'string')
  assert.ok(nudge.id.length > 0, 'the injected message needs a stable id')
  assert.equal(nudge.source.kind, 'wolfram-math')
  assert.equal(nudge.source.form, 'snapshot')
  assert.equal(nudge.source.sections[0].name, 'wolfram-math')
  assert.match(nudge.content[0].text, /wolfram/)
  return JSON.stringify(nudge.content[0].text.slice(0, 52) + '…')
})

await check('T8 a greeting is not nudged', async () => {
  const decision = await preStep('你好')
  assert.equal(decision.messages.length, 1, 'no injection for small talk')
  return 'no injection'
})

await check('nudger requires the tool: disabled tool means no listener', () => {
  const host = fakeHost()
  const stop = apply(host.ctx, { enableTool: false, autoNudge: 'heuristic' })
  assert.equal(host.listeners.length, 0, 'a nudge toward a missing tool would be broken guidance')
  stop()
  return 'no listener while the tool is disabled'
})

await check('registers the bundled skill and withdraws it on dispose', () => {
  const host = fakeHost()
  const stop = apply(host.ctx, {})
  assert.equal(host.skills.length, 1, 'one runtime skill')
  const skill = host.skills[0]
  assert.equal(skill.name, 'wolfram-math')
  assert.ok(skill.description.length > 40, 'catalog line must explain the skill')
  assert.ok(skill.whenToUse.length > 20)
  assert.ok(skill.content.length > 1_500, 'body must carry the idiom reference')
  assert.equal(skill.invocation.modelInvocable, true)
  assert.equal(skill.invocation.userInvocable, true)
  assert.equal(skill.resourceBase.kind, 'opaque')
  stop()
  assert.equal(host.skills.length, 0, 'dispose must unregister the skill')
  return `${skill.content.length} chars`
})

await check('tool still works in a profile with no skill registry', () => {
  const host = fakeHost({ skills: false })
  const stop = apply(host.ctx, {})
  assert.equal(host.tools.length, 1, 'the tool must not depend on the skill service')
  assert.equal(host.skills.length, 0)
  stop()
  return 'tool registered, skill skipped'
})

// ---------------------------------------------------------------------------
// Live kernel checks
// ---------------------------------------------------------------------------

const signal = new AbortController().signal

/** Execute one call through the registered tool definition. */
async function call(args, execSignal = signal) {
  const value = await tool.execute(args, { signal: execSignal })
  return value
}

await check('T1 integrate returns exact InputForm and LaTeX', async () => {
  const value = await call({ code: 'Integrate[x^2 Sin[x], x]', label: 'integral' })
  assert.equal(value.status, 'ok', `status=${value.status} detail=${value.detail}`)
  assert.match(value.inputForm, /Cos\[x\]/)
  assert.ok(value.tex.length > 0, 'LaTeX must be present')
  assert.deepEqual(value.messages, [])
  // Regression guard: a fractional kernel time used to be exported as `0.e-7`,
  // which is invalid JSON and made a fast evaluation look like a crash.
  assert.ok(Number.isInteger(value.elapsedMs), `elapsedMs must be an integer, got ${value.elapsedMs}`)
  assert.ok(value.wallMs >= value.elapsedMs, 'wall time must cover the kernel start-up the model also waited for')
  return `${value.elapsedMs} ms kernel · ${value.wallMs} ms wall · ${value.inputForm}`
})

await check('T2 1/0 returns ComplexInfinity with the kernel message', async () => {
  const value = await call({ code: '1/0' })
  assert.equal(value.status, 'ok')
  assert.equal(value.inputForm, 'ComplexInfinity')
  assert.ok(value.messages.some(message => message.includes('Power::infy')), `messages=${value.messages}`)
  return `inputForm=${value.inputForm} messages=${value.messages.join(',')}`
})

await check('T3 syntax error is reported with the kernel message', async () => {
  const value = await call({ code: '1 + ' })
  assert.equal(value.status, 'syntax')
  assert.equal(value.inputForm, '')
  assert.ok(value.messages.length > 0, 'the parser message must reach the model, not just "syntax error"')
  assert.match(value.messages.join(' '), /Syntax|snt/i, `messages=${value.messages}`)
  const text = renderResult({}, value)
  assert.match(text, /Messages:/)
  assert.match(text, /syntax error/)
  return value.messages.join(', ')
})

await check('T5 UTF-8 source survives the file channel', async () => {
  const value = await call({ code: 'Expand[(x + 中文变量)^3]' })
  assert.equal(value.status, 'ok', `status=${value.status} detail=${value.detail}`)
  assert.ok(value.inputForm.includes('中文变量'), `inputForm=${value.inputForm}`)
  return value.inputForm
})

await check('T4 model timeout yields status timeout within budget', async () => {
  const started = Date.now()
  const value = await call({ code: 'Pause[30]; 1', timeoutSec: 2 })
  const wall = Date.now() - started
  assert.equal(value.status, 'timeout', `status=${value.status} detail=${value.detail}`)
  assert.ok(value.elapsedMs >= 1_800 && value.elapsedMs <= 3_500, `elapsedMs=${value.elapsedMs}`)
  assert.ok(wall < 25_000, `wall=${wall}ms`)
  return `kernel ${value.elapsedMs} ms, wall ${wall} ms`
})

await check('T9 cancellation kills the launcher and leaves no orphans', async () => {
  const controller = new AbortController()
  const pending = call({ code: 'Pause[60]; 1' }, controller.signal)
  setTimeout(() => controller.abort(), 700)
  const value = await pending
  assert.equal(value.status, 'cancelled', `status=${value.status}`)
  await sleep(2_500)
  const { checked, alive } = survivingWorframProcesses()
  if (checked) assert.deepEqual(alive, [], `surviving processes: ${alive.join(', ')}`)
  return checked ? 'cancelled; no surviving kernel process' : 'cancelled; process check unavailable'
})

await check('render output is the model-facing contract', async () => {
  const value = await call({ code: 'FullSimplify[Sin[x]^2 + Cos[x]^2]' })
  assert.equal(value.status, 'ok')
  assert.equal(value.inputForm, '1')
  const text = renderResult({}, value)
  // The header states the timing and, when applicable, that the run was confined.
  assert.match(text, /^wolfram · ok · (\d+\.\d\d s|cached)(?: · sandboxed)?$/m)
  assert.match(text, /^InputForm: 1$/m)
  assert.match(text, /^LaTeX: 1$/m)
  // This host offers a sandbox, so the marker must be present rather than absent.
  assert.equal(value.sandboxed, true)
  assert.match(text, /· sandboxed/)
  return JSON.stringify(text)
})

await check('T10 a conditional result is flagged for reporting', async () => {
  const value = await call({ code: 'Integrate[Exp[-a x^2], {x, 0, Infinity}]' })
  assert.equal(value.status, 'ok', `status=${value.status} detail=${value.detail}`)
  assert.match(value.inputForm, /ConditionalExpression/, 'this integral is conditional on Re[a] > 0')
  const text = renderResult({}, value)
  assert.match(text, /Conditional:/, 'the model must be told the answer carries a condition')
  assert.match(text, /Re\[a\] > 0/)
  return 'condition surfaced to the model'
})

await check('a repeated call is answered from cache, and says so', async () => {
  const request = { code: 'Expand[(a + b)^2]', label: 'cache probe' }
  const first = await call(request)
  const second = await call(request)
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  assert.notEqual(first.cached, true, 'the first call must reach the kernel')
  assert.equal(second.cached, true, 'the second call must be served from cache')
  assert.equal(second.inputForm, first.inputForm)
  assert.equal(second.elapsedMs, first.elapsedMs, 'a reused answer keeps its original timing')
  assert.match(renderResult({}, second), /cached/)
  return `${first.elapsedMs} ms kernel, then cached`
})

await check('a non-answer status is never cached', async () => {
  const request = { code: 'Run["whoami"]' }
  const first = await call(request)
  const second = await call(request)
  assert.equal(first.status, 'denied')
  assert.equal(second.status, 'denied')
  assert.notEqual(second.cached, true, 'refusals must not masquerade as cached answers')
  return 'both refused fresh'
})

await check('denied constructs are refused without spawning a kernel', async () => {
  const value = await call({ code: 'Run["whoami"]' })
  assert.equal(value.status, 'denied')
  assert.match(value.detail, /Run\[/)
  return value.detail
})

await check('M4a the launcher is off the execution path', async () => {
  // A deliberately broken `wolframscriptPath` must not matter once the kernel is
  // named explicitly: nothing on the execution path may consult the launcher.
  const { kernelPath } = resolveConfig({})
  const host = fakeHost()
  const stop = apply(host.ctx, {
    kernelPath,
    wolframscriptPath: 'C:\\no-such-directory\\wolframscript.exe',
    timeoutMs: 20_000,
  })
  const probe = host.tools[0]
  const value = await probe.execute({ code: '2 + 2' }, { signal: new AbortController().signal })
  stop()
  assert.equal(value.status, 'ok', `status=${value.status} detail=${value.detail}`)
  assert.equal(value.inputForm, '4')
  return `${value.elapsedMs} ms kernel · launcher unused`
})

// ---------------------------------------------------------------------------
// M4b: sandbox wiring
// ---------------------------------------------------------------------------

await check('M4b a confined run spawns the argv the sandbox returned', async () => {
  const { kernelPath } = resolveConfig({})
  const host = fakeHost({
    confine: async (argv) => {
      // Positive proof that the returned argv is what runs: hand the executor a
      // stub runner in the same per-call directory that reports a marker result.
      const dir = dirname(argv[argv.length - 1])
      const stub = join(dir, 'stub.wls')
      // The stub speaks the runner's protocol: marker, then the JSON envelope.
      writeFileSync(stub, 'WriteString[$Output, "@@DSH-WOLFRAM-RESULT@@", ExportString['
        + '<|"status" -> "ok", "inputForm" -> "FROM-CONFINED-STUB", "tex" -> "", '
        + '"messages" -> {}, "elapsedMs" -> 1|>, "JSON"], "\\n"]\n')
      return {
        argv: [kernelPath, '-noprompt', '-script', stub],
        enforcement: 'partial',
        denialSignatures: ['EACCES'],
        runnerFailureRules: [],
      }
    },
  })
  const stop = apply(host.ctx, {})
  const value = await host.tools[0].execute({ code: '2 + 2' }, { signal: new AbortController().signal })
  stop()

  assert.equal(host.confineCalls.length, 1, 'the sandbox must be consulted exactly once')
  assert.match(host.confineCalls[0].argv.at(-1), /runner\.wls$/, 'the kernel argv is offered to the sandbox')
  assert.equal(host.confineCalls[0].policy.mode, 'workspace-write', "the caller's policy decides the mode")
  assert.equal(value.status, 'ok', `status=${value.status} detail=${value.detail}`)
  assert.equal(value.inputForm, 'FROM-CONFINED-STUB', 'the sandbox-returned argv must be what ran')
  assert.equal(value.sandboxed, true)
  assert.match(renderResult({}, value), /· sandboxed/, 'the result must say it was confined')
  return 'confined argv used · marked sandboxed'
})

await check('M4b a full-access session is not wrapped', async () => {
  const host = fakeHost({ policy: { mode: 'danger-full-access', workspaceRoot: process.cwd() } })
  const stop = apply(host.ctx, {})
  const value = await host.tools[0].execute({ code: '2 + 2' }, { signal: new AbortController().signal })
  stop()
  assert.equal(value.status, 'ok', `detail=${value.detail}`)
  assert.equal(value.sandboxed, false)
  assert.equal(host.confineCalls.length, 0, 'danger-full-access must bypass confinement')
  return 'unconfined by the session policy'
})

await check('M4b an unavailable sandbox refuses to run unconfined', async () => {
  const host = fakeHost({
    confine: async () => {
      const error = new Error('no usable backend on this host')
      error.code = 'SANDBOX_UNAVAILABLE'
      error.name = 'SandboxUnavailableError'
      throw error
    },
  })
  const stop = apply(host.ctx, {})
  const value = await host.tools[0].execute({ code: '2+2' }, { signal: new AbortController().signal })
  stop()
  assert.equal(value.status, 'crashed', 'must fail closed, not fall back silently')
  assert.match(value.detail, /refusing to run the kernel unconfined/)
  assert.match(value.detail, /sandbox: 'off'/, 'the detail must name the explicit opt-out')
  return 'fail-closed with an actionable opt-out'
})

await check("M4b sandbox: 'off' skips the sandbox entirely", async () => {
  const host = fakeHost()
  const stop = apply(host.ctx, { sandbox: 'off' })
  const value = await host.tools[0].execute({ code: '2 + 2' }, { signal: new AbortController().signal })
  stop()
  assert.equal(value.status, 'ok')
  assert.equal(host.confineCalls.length, 0)
  assert.equal(value.sandboxed, false)
  return 'opt-out honoured'
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

dispose()

const width = Math.max(...results.map(entry => entry.label.length))
for (const entry of results) {
  const mark = entry.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${entry.label.padEnd(width)}  ${String(entry.ms).padStart(6)} ms  ${entry.detail}`)
}
const failed = results.filter(entry => !entry.ok)
console.log('')
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
