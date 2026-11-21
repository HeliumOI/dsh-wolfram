/**
 * Deterministic "this turn looks like demanding mathematics" detector and the
 * per-step nudge it drives.
 *
 * The detector is a pure function over the newest human message: no model call,
 * no session state, so it costs nothing and can be unit-tested. It deliberately
 * over-asks rather than under-asks only up to the threshold — a false positive
 * costs one sentence of context, a false negative costs a wrong hand
 * calculation, which is the failure this plugin exists to prevent.
 *
 * @module @local/dsh-wolfram/lib/detect
 */

import { randomUUID } from 'node:crypto'

/** The one-off context injected when the detector fires. */
export const NUDGE_TEXT = 'This turn looks like a demanding math problem. Prefer calling `wolfram` '
  + 'to verify the exact result before answering, and state your assumptions in the code.'

/** Score at or above which the nudger fires (deployment default). */
export const DEFAULT_NUDGE_THRESHOLD = 5

/** The plugin's own message source, so the detector never nudges itself. */
const SOURCE_KIND = 'wolfram-math'

/** Chinese math actions and nouns. Substrings of each other are fine: the cap is two terms. */
const CJK_TERMS = [
  '求解', '解方程', '方程组', '方程', '不等式', '积分', '微分方程', '偏微分', '微分', '求导', '导数',
  '极限', '级数', '矩阵', '行列式', '特征值', '特征向量', '多项式', '因式分解', '化简', '展开',
  '证明', '推导', '计算', '概率', '期望', '方差', '傅里叶', '拉普拉斯', '精确根', '根号', '收敛',
]

/** English math actions and nouns. */
const ENGLISH_TERMS = [
  'solve', 'solution', 'integrate', 'integration', 'integral', 'derivative', 'differentiate',
  'limit', 'series', 'expand', 'simplify', 'factor', 'factorize', 'prove', 'proof', 'determinant',
  'eigenvalue', 'eigenvector', 'matrix', 'matrices', 'polynomial', 'quadratic', 'divisible',
  'integer', 'prime', 'converge', 'convergent', 'fourier', 'laplace', 'ode', 'pde',
  'probability', 'expectation', 'variance', 'equation', 'inequality', 'closed form', 'exact value',
]

/**
 * Word-boundary matchers for {@link ENGLISH_TERMS}, tolerating a plural suffix.
 *
 * Boundaries matter: without them `ode` would match inside "code", "node", and
 * "model", which would score every programming question as mathematics. The
 * optional suffix matters too: `\bintegral\b` misses "integrals", which is how a
 * real request usually arrives ("check these integrals").
 */
const ENGLISH_PATTERNS = ENGLISH_TERMS.map(term => ({
  term,
  pattern: new RegExp(`\\b${term}(?:s|es)?\\b`, 'i'),
}))

/** Verbs that turn a math noun into a request for computation. */
const ACTION_VERB = /\b(?:compute|calculate|evaluate|check|verify|find|derive|prove|solve|simplify|expand|integrate|determine|confirm|work out)\b/i

/**
 * A message that quotes this tool's own output. Such text is evidence that a
 * kernel already ran; scoring it as a new request would spawn a kernel for a
 * review or a paste.
 */
const QUOTED_OUTPUT = /InputForm:|LaTeX:|wolfram · (?:ok|syntax error|timeout|engine failure|refused|cancelled)/

/** LaTeX markup: delimiters and the commands that only appear in real formulas. */
const LATEX = /(?:\$[^$\n]{1,200}\$)|\\\(|\\\[|\\frac|\\sqrt|\\int|\\sum|\\lim|\\begin\{(?:pmatrix|bmatrix|matrix|aligned|cases|array)\}/

/** Unicode math symbols that do not survive inside ordinary prose by accident. */
const UNICODE_MATH = /[∫∑∏∂√π∞≤≥≠±×÷∈∀∃]/

/** Named elementary functions. */
const FUNCTION_CALL = /\b(?:sin|cos|tan|cot|sec|csc|exp|log|ln|sqrt|sinh|cosh|tanh)\b/i

/** A capitalized bracket call, the shape of every Wolfram/Mathematica expression. */
const WL_CALL = /\b[A-Z][A-Za-z0-9]+\[[^\]]*\]/

/** A prime mark on an identifier, e.g. `f'(3)` or `y''`. */
const DERIVATIVE_MARK = /\b[A-Za-z]'/

/** A variable raised to a power. */
const POWER = /[A-Za-z]\s*(?:\^|²|³)/

/** A matrix or list-of-lists literal. */
const MATRIX_SHAPE = /(?:\{\s*\{|\[\s*\[)/

/** A declared function such as `f(x) = x^2`, as opposed to a call. */
const FUNCTION_DEFINITION = /[A-Za-z]\s*\(\s*[A-Za-z]\s*\)\s*=/

/** A bare arithmetic question such as `1+1=?` or `2*3`. */
const PURE_ARITHMETIC = /^\s*[-+(]?\d+(?:[.,]\d+)?(?:\s*[-+*/×÷]\s*[-+(]?\d+(?:[.,]\d+)?)+\s*=?\s*[?？]?\s*$/

/** Concept questions, which mention math words without asking for computation. */
const CONCEPT = /什么是|是什么|什么意思|有何区别|什么区别|解释|定义|原理|为什么/

/** A fenced code block. */
const CODE_FENCE = /```/

/** Operators counted by the density rule. */
const OPERATORS = /[+\-*/^=<>]/g

/**
 * Find the distinct Chinese terms that occur in `text`.
 *
 * @param text - raw message text.
 * @param terms - needles, matched as substrings because they have no word form.
 * @returns matched terms, each counted once however often it repeats.
 */
function distinctCjkTerms(text, terms) {
  const hits = []
  for (const term of terms) {
    if (text.includes(term)) hits.push(term)
  }
  return hits
}

/**
 * Find the distinct English terms that occur in `text`.
 *
 * @param lower - lowercased message text.
 * @returns matched terms, each counted once however often it repeats.
 */
function distinctEnglishTerms(lower) {
  const hits = []
  for (const { term, pattern } of ENGLISH_PATTERNS) {
    if (pattern.test(lower)) hits.push(term)
  }
  return hits
}

/**
 * Score a user message for "requires a computer-algebra check".
 *
 * @param raw - the newest human message text.
 * @returns the total score and the rules that contributed, for tests and logs.
 */
export function scoreMath(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const lower = text.toLowerCase()
  const reasons = []
  let score = 0

  /** Record one contributing rule. */
  const add = (points, reason) => {
    score += points
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`)
  }

  const latex = LATEX.test(text)
  const unicode = UNICODE_MATH.test(text)
  const cjkHits = distinctCjkTerms(text, CJK_TERMS)
  const englishHits = distinctEnglishTerms(lower)

  if (latex) add(3, 'latex')
  if (unicode) add(3, 'unicode-math')
  // Cap at three terms: repetition must not inflate the score, but several
  // distinct math words are stronger evidence than one.
  if (cjkHits.length > 0) add(Math.min(6, cjkHits.length * 2), `cjk:${cjkHits.join('|')}`)
  if (englishHits.length > 0) add(Math.min(6, englishHits.length * 2), `english:${englishHits.join('|')}`)

  const hasMathWord = latex || unicode || cjkHits.length > 0 || englishHits.length > 0

  // A request verb aimed at a math noun is the strongest single-request shape
  // ("check these integrals", "find the eigenvalues"), so it can carry a message
  // past the threshold on its own.
  if (ACTION_VERB.test(text) && hasMathWord) add(3, 'action-request')

  if (FUNCTION_CALL.test(text) && /[A-Za-z]/.test(text)) add(2, 'function-call')
  if (WL_CALL.test(text)) add(2, 'wolfram-call')

  // `=` with a variable and some arithmetic: an equation, not an assignment in prose.
  if (text.includes('=') && /[A-Za-z]/.test(text) && (/[\^²³√]/.test(text) || /[+\-*/]/.test(text))) {
    add(2, 'equation')
  }

  if (MATRIX_SHAPE.test(text)) add(3, 'matrix-shape')
  if (FUNCTION_DEFINITION.test(text)) add(1, 'function-definition')
  if (DERIVATIVE_MARK.test(text)) add(2, 'derivative-mark')
  if (POWER.test(text)) add(1, 'power')
  if ((text.match(/\d/g) ?? []).length >= 4) add(1, 'numeric-density')
  if ((text.match(OPERATORS) ?? []).length >= 3 && /[A-Za-z]/.test(text)) add(1, 'operator-density')

  // Discounts applied last, so they can pull a borderline prose message back down.
  if (PURE_ARITHMETIC.test(text)) add(-5, 'discount:bare-arithmetic')
  if (CONCEPT.test(text) && !latex && !unicode) add(-3, 'discount:concept-question')
  if (CODE_FENCE.test(text) && !hasMathWord) add(-4, 'discount:code-only')
  if (QUOTED_OUTPUT.test(text)) add(-8, 'discount:quoted-tool-output')

  return { score, reasons }
}

/**
 * Find the newest human-authored user text among the step's messages.
 *
 * @param messages - the messages entering the step.
 * @returns the text, or undefined when the step carries none.
 */
function newestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const part = Array.isArray(message.content)
      ? message.content.find(item => item?.type === 'text')
      : undefined
    if (typeof part?.text === 'string' && part.text.trim().length > 0) return part.text
  }
  return undefined
}

/**
 * Build the injected context message. The shape matches what `createUserMessage`
 * produces, which is what a `snapshot` context from `dsh-time-context` uses.
 *
 * @returns a user-role message carrying a `snapshot` source.
 */
function nudgeMessage() {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: NUDGE_TEXT }],
    source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text: NUDGE_TEXT }] },
  }
}

/**
 * Register the pre-step listener that appends at most one nudge per turn.
 *
 * @param ctx - plugin context.
 * @param config - resolved plugin config.
 * @param scorer - score provider; injectable so the rules can be unit-tested.
 * @returns a disposer that also clears the per-turn dedupe state.
 */
export function bindNudger(ctx, config, scorer = scoreMath) {
  /** Turns already nudged; bounded because this is only a derived cache. */
  const nudged = new Set()
  const cap = 500

  const dispose = ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const key = `${agent.session.id}:${turn}`
    if (nudged.has(key)) return decision

    const text = newestUserText(decision.messages)
    if (text === undefined) return decision
    if (scorer(text).score < config.nudgeThreshold) return decision

    if (nudged.size >= cap) nudged.clear()
    nudged.add(key)
    // Spread the decision: fields such as `startsRequestSeries` must survive.
    return { ...decision, messages: [...decision.messages, nudgeMessage()] }
  }, { prepend: true })

  return () => {
    nudged.clear()
    dispose?.()
  }
}
