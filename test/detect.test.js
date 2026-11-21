/**
 * Detector acceptance tests.
 *
 * Two groups matter equally: prompts that must fire (a missed calculation is the
 * failure this plugin prevents) and prompts that must stay silent (a nudge on
 * every turn is noise that erodes trust in the guidance).
 *
 * Run directly with the DSH Electron runtime, which is an ordinary Node:
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/detect.test.js
 * or with `node --test test/detect.test.js`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_NUDGE_THRESHOLD, scoreMath } from '../lib/detect.js'

/** Whether the message would trigger the nudge at the shipped threshold. */
function fires(text) {
  return scoreMath(text).score >= DEFAULT_NUDGE_THRESHOLD
}

/** Report the score and reasons when an expectation fails. */
function explain(text) {
  const { score, reasons } = scoreMath(text)
  return `score=${score} reasons=[${reasons.join('; ')}]`
}

// ---------------------------------------------------------------------------
// Must fire
// ---------------------------------------------------------------------------

const MUST_FIRE = [
  '求解 x^3-2x+1=0 的精确根',
  "求解微分方程 y' + y = sin x",
  '请计算 $\\int_0^1 x^2\\,dx$',
  '计算 ∫₀^∞ e^{-x²} dx',
  '矩阵 [[1,2],[3,4]] 的特征值是多少',
  'Integrate[x^2 Sin[x], x] 的结果',
  'Prove that n^3 - n is divisible by 6 for every integer n',
  "设 f(x) = x^2，求 f'(3)",
  "Use the Laplace transform to solve the ODE y'' + y = 0",
  'Find the determinant of {{2,1},{1,3}}',
  // Plural English requests: the shape a user actually types (review finding 1).
  'Check these integrals for me',
  'Find the eigenvalues of this matrix',
  'compute the integrals of x^2',
]

for (const prompt of MUST_FIRE) {
  test(`fires: ${prompt}`, () => {
    assert.ok(fires(prompt), `expected a nudge — ${explain(prompt)}`)
  })
}

// ---------------------------------------------------------------------------
// Must stay silent
// ---------------------------------------------------------------------------

const MUST_NOT_FIRE = [
  '你好',
  '今天天气怎么样？',
  '谢谢，明天见',
  '解释一下什么是特征值',
  '什么是傅里叶变换',
  '1+1=?',
  '计算 2+3',
  '帮我把这个函数改名成 foo',
  '用 Python 写一个解方程的脚本',
  '这个函数该怎么写：\n```js\nfunction add(a, b) { return a + b }\n```',
  '把 README 里的 mode 字段改成 strict',
  // Quoting this tool's own output is not a new math request (review finding 1).
  '这个结果对吗？\nwolfram · ok · 6.05 s\nInputForm: -((-2 + x^2)*Cos[x]) + 2*x*Sin[x]\nLaTeX: 2 x \\sin (x)',
]

for (const prompt of MUST_NOT_FIRE) {
  test(`stays silent: ${prompt.replace(/\n/g, ' ⏎ ')}`, () => {
    assert.ok(!fires(prompt), `expected no nudge — ${explain(prompt)}`)
  })
}

// ---------------------------------------------------------------------------
// Contract details
// ---------------------------------------------------------------------------

test('empty and non-string input score zero without throwing', () => {
  for (const input of ['', '   ', undefined, null, 42]) {
    const { score, reasons } = scoreMath(input)
    assert.equal(score, 0, `input=${String(input)}`)
    assert.deepEqual(reasons, [])
  }
})

test('reasons explain every point, so a misfire is diagnosable', () => {
  const { score, reasons } = scoreMath('求解 x^3-2x+1=0 的精确根')
  assert.ok(score >= DEFAULT_NUDGE_THRESHOLD)
  assert.ok(reasons.length >= 3, `reasons=${reasons.join('; ')}`)
  assert.ok(reasons.some(reason => reason.includes('cjk')))
  assert.ok(reasons.some(reason => reason.includes('equation')))
})

test('a concept question keeps its math word but is pulled below the threshold', () => {
  const withWord = scoreMath('矩阵的特征值')
  const asQuestion = scoreMath('解释一下什么是矩阵的特征值')
  assert.ok(asQuestion.score < withWord.score)
  assert.ok(asQuestion.score < DEFAULT_NUDGE_THRESHOLD)
  assert.ok(asQuestion.reasons.some(reason => reason.includes('concept-question')))
})

test('a bare arithmetic question is discounted below any real threshold', () => {
  const { score, reasons } = scoreMath('12 * 7 = ?')
  assert.ok(score < 0, `score=${score}`)
  assert.ok(reasons.some(reason => reason.includes('bare-arithmetic')))
})

test('english terms respect word boundaries ("code" is not "ode")', () => {
  assert.equal(scoreMath('code').score, 0)
  assert.equal(scoreMath('node').score, 0)
  assert.equal(scoreMath('model').score, 0)
  assert.ok(scoreMath('solve the ODE').score > 0)
})

test('the same signal repeated does not inflate the score', () => {
  const once = scoreMath('计算这个积分').score
  const thrice = scoreMath('计算这个积分，计算这个积分，计算这个积分').score
  assert.equal(once, thrice)
})

test('a plural math noun is a real request, not a miss', () => {
  const singular = scoreMath('check this integral for me').score
  const plural = scoreMath('check these integrals for me').score
  assert.ok(plural >= DEFAULT_NUDGE_THRESHOLD, `plural request must fire — ${explain('check these integrals for me')}`)
  assert.equal(singular, plural, 'plural and singular must score the same')
})

test('quoted tool output is discounted, so a paste does not spawn a kernel', () => {
  const quoted = '这个结果对吗？\nwolfram · ok · 6.05 s\nInputForm: 1/0\nLaTeX: \\text{ComplexInfinity}'
  const { score, reasons } = scoreMath(quoted)
  assert.ok(score < DEFAULT_NUDGE_THRESHOLD, `score=${score}`)
  assert.ok(reasons.some(reason => reason.includes('quoted-tool-output')))
})
