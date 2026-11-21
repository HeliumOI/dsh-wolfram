/**
 * The bundled `wolfram-math` skill: Wolfram Language idioms that keep the
 * `wolfram` tool's answers trustworthy.
 *
 * It is registered as a runtime skill, so it costs nothing until the model
 * loads it: the catalog shows one description line, and the body arrives only
 * when a call is actually being prepared.
 *
 * @module @local/dsh-wolfram/lib/skill
 */

/** Kebab-case skill name. */
export const SKILL_NAME = 'wolfram-math'

/** One-line routing description shown in the skill catalog. */
const SKILL_DESCRIPTION = 'Wolfram Language idioms for getting trustworthy exact results from the `wolfram` tool: '
  + 'syntax that silently changes meaning, assumptions, exact vs numeric, solving, linear algebra, and result checks.'

/** When loading the full body pays off. */
const SKILL_WHEN_TO_USE = 'Load before a non-trivial `wolfram` call: systems of equations, differential equations, '
  + 'integrals with parameters, precision-sensitive numbers, or after a result looked wrong or came back conditional.'

/** The instruction body. */
const SKILL_CONTENT = `# Wolfram Language for the \`wolfram\` tool

The tool evaluates exactly one expression and returns its \`InputForm\`. Wolfram has no
implicit multiplication between identifiers and several common notations mean something
else, so a call that parses is not necessarily the call you meant.

## Syntax that silently changes meaning

- \`xy\` is one symbol, not \`x*y\`. Write \`x*y\` or \`x y\` (space).
- Functions are capitalised: \`Sin\`, \`Cos\`, \`Exp\`, \`Log\`, \`Sqrt\`, \`Abs\`, \`D\`, \`Integrate\`.
  \`sin[x]\` is an undefined symbol called sin.
- \`Log[x]\` is the natural log; \`Log[b, x]\` is base b. \`Exp[x]\` is e^x.
- Equations use \`==\`; \`=\` assigns. Rules use \`->\`; \`/.\` applies them.
- \`Pi\`, \`E\`, \`I\`, \`Infinity\` are built in.
- A pattern is \`x_\`; \`f[x_] := x^2\` defines a function. \`f[x] := x^2\` does not.
- Sequence steps with \`;\` or \`Module\`; only the last value is returned.

## Get exact results first, then numbers

- Exact: \`Integrate\`, \`Sum\`, \`D\`, \`Limit\`, \`Solve\`, \`DSolve\`, \`Eigenvalues\`.
- Numeric: \`NIntegrate\`, \`NSum\`, \`NSolve\`, \`NDSolveValue\`, \`FindRoot\`.
- High precision: \`N[expr, 50]\` — pass the digit count; default machine precision loses
  digits on cancellation.
- Simplification ladder: \`Simplify\`, then \`FullSimplify\` (slower); \`Together\`, \`Apart\`,
  \`TrigExpand\`, \`TrigReduce\` for specific shapes.

## Assumptions decide the answer

A parameterised integral or limit usually has conditions. Give them explicitly:

\`\`\`
Integrate[Exp[-a x^2], {x, 0, Infinity}, Assumptions -> a > 0]
Simplify[Sqrt[x^2], Assumptions -> x > 0]
Assuming[n > 0, Limit[n^(1/n), n -> Infinity]]
\`\`\`

If a result comes back as a \`ConditionalExpression\`, the conditions were not proven.
Either add \`Assumptions\` or ask \`Reduce\` for the complete answer.

## Solving

- \`Solve[eqs, vars]\` — generic solutions, but it silently drops degenerate parameter
  values. \`Solve[a x == 1, x]\` assumes \`a != 0\`.
- \`Reduce[eqs, vars, Reals]\` — complete, handles inequalities and parameter cases.
  Prefer it when the answer must be exhaustive.
- \`NSolve\` for numeric polynomial roots; \`FindRoot\` for transcendental starting points.
- \`DSolve[{ode, y[0] == 1}, y, x]\` for closed forms; \`NDSolveValue\` when none exists.
- Substitute a candidate back: \`eq /. sol\` should reduce to \`True\`.

## Linear algebra

\`\`\`
Det[m]  Inverse[m]  Eigenvalues[m]  Eigenvectors[m]  MatrixExp[m]
NullSpace[m]  RowReduce[m]  LinearSolve[m, b]  MatrixRank[m]
\`\`\`

Matrices are nested lists: \`{{1, 2}, {3, 4}}\`. Exact radicals beat \`N[...]\` when the
eigenvalues are meant to be exact.

## Check before reporting

- Read the returned \`Messages\`. A message is evidence that a condition was missed,
  not cosmetic noise.
- Cross-check a symbolic answer numerically: compare \`N[exact]\` with \`NIntegrate\`.
- If the result is \`$Failed\` or unevaluated, the input was probably wrong — fix the
  expression instead of reporting it.

## Out of scope for this tool

No plotting, no file or network I/O, no shell commands. It evaluates mathematics.
`

/**
 * Register the skill when the profile has a skill registry.
 *
 * The service is optional: without `ctx.skills` the tool still works, so the
 * dependency is pulled in with `ctx.inject` rather than declared in `inject`.
 *
 * @param ctx - plugin context.
 * @returns a disposer, or undefined when no skill registry is available.
 */
export function bindSkill(ctx) {
  if (typeof ctx.inject !== 'function') return undefined
  return ctx.inject(['skills'], (scoped) => scoped.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content: SKILL_CONTENT,
    resourceBase: { kind: 'opaque', description: 'Bundled with the wolfram-math plugin; no external files.' },
    invocation: { modelInvocable: true, userInvocable: true },
  }))
}

/** Exposed for tests. */
export const internals = { SKILL_DESCRIPTION, SKILL_WHEN_TO_USE, SKILL_CONTENT }
