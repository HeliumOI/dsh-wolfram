/**
 * Model-facing rendering of a `wolfram` call.
 *
 * The kernel's `InputForm` is authoritative; LaTeX is a convenience for answers.
 * Two details get explicit lines because they change how a result must be
 * reported: a conditional answer (report the condition) and an arbitrary-precision
 * number (the display drops the precision mark, so the digit count is restated).
 *
 * @module @local/dsh-wolfram/lib/render
 */

/** Human labels for the result statuses. */
const STATUS_LABEL = {
  ok: 'ok',
  syntax: 'syntax error',
  failed: 'evaluation failed',
  timeout: 'timeout',
  crashed: 'engine failure',
  denied: 'refused',
  cancelled: 'cancelled',
}

/** One follow-up line per status that needs it; `ok` and `cancelled` need none. */
const HINTS = {
  syntax: 'code must be one Wolfram Language expression; sequence steps with ";" or wrap them in Module.',
  failed: 'The expression returned $Failed. State assumptions (Assumptions -> …) or switch to a numeric method such as NIntegrate or NSolve.',
  timeout: 'Raise timeoutSec or split the work into smaller expressions.',
  crashed: 'The kernel did not return a result; see the detail above.',
  denied: 'This tool evaluates mathematics only.',
}

/** Longest card label accepted from the model. */
const MAX_LABEL_CHARS = 60

/**
 * Read the precision mark off an `InputForm` number, e.g. `1.64…`30.` → `30`.
 *
 * @param inputForm - the canonical result text.
 * @returns the precision in digits, or undefined when the value is exact.
 */
export function precisionDigits(inputForm) {
  const match = /`(\d+(?:\.\d+)?)\.?/.exec(inputForm)
  return match === null ? undefined : match[1]
}

/**
 * Drop Wolfram's precision/accuracy marks from a display string.
 *
 * @param value - one `InputForm` string.
 * @returns the same text without trailing `` `30. `` style marks.
 */
export function stripPrecision(value) {
  return value.replace(/`\d+(?:\.\d+)?\.?/g, '')
}

/**
 * Present a pending call as a generic tool card.
 *
 * @param args - raw call arguments.
 * @returns the generic call view, titled `Wolfram · <label>`.
 */
export function presentCall(args) {
  const label = typeof args?.label === 'string' ? args.label.trim().slice(0, MAX_LABEL_CHARS) : ''
  const title = label.length > 0 ? `Wolfram · ${label}` : 'Wolfram'
  return { card: 'generic', title, kind: 'math', rawInput: typeof args?.code === 'string' ? args.code : '' }
}

/**
 * Render one result as the tool's model-facing text.
 *
 * @param args - the call arguments (unused; kept for the render signature).
 * @param value - the structured result.
 * @returns bounded multi-line text.
 */
export function renderResult(args, value) {
  const status = STATUS_LABEL[value.status] ?? value.status
  // Total wall time, because that is the wait the caller experienced. A reused
  // answer says so instead of reporting a timing it did not spend.
  const timing = value.cached === true ? 'cached' : `${((value.wallMs ?? value.elapsedMs) / 1000).toFixed(2)} s`
  // Say when the run was confined: a reader must not have to assume either way.
  const scope = value.sandboxed === true ? ' · sandboxed' : ''
  const lines = [`wolfram · ${status} · ${timing}${scope}`]

  if (value.inputForm.length > 0) lines.push(`InputForm: ${stripPrecision(value.inputForm)}`)

  if (value.status === 'ok') {
    const digits = precisionDigits(value.inputForm)
    if (digits !== undefined) lines.push(`Precision: ${digits} digits`)
    if (value.tex.length > 0) lines.push(`LaTeX: ${value.tex}`)
    if (/ConditionalExpression\[|\bIf\[/.test(value.inputForm)) {
      lines.push('Conditional: this holds only under the stated condition — report the condition with the answer.')
    }
  }

  if (value.messages.length > 0) lines.push(`Messages: ${value.messages.join(', ')}`)
  if (value.detail.length > 0) lines.push(value.detail)
  if (value.truncated) lines.push('(result truncated; ask for a shorter form such as Short[…], N[…], or a summary)')

  const hint = HINTS[value.status]
  if (hint !== undefined) lines.push(hint)
  return lines.join('\n')
}
