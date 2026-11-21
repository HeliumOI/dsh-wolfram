# Wolfram math

A DeepSeek Harness plugin that evaluates Wolfram Language in the local Wolfram Engine, so demanding
mathematics is computed rather than estimated.

## What it does

- **`wolfram` tool.** One call evaluates one Wolfram Language expression and returns a structured
  result: `status`, `inputForm`, `tex`, kernel `messages`, kernel time, wall time, and an optional
  `detail`.
- **Routing guidance.** A system-prompt section tells the model which problems warrant a call — exact
  symbolic work, large or stiff systems, high-precision numerics, multi-step derivations — and asks
  it to state assumptions such as `Assumptions -> a > 0`.
- **Per-step nudge.** When the newest message looks like demanding mathematics, one sentence is added
  to the turn asking the model to verify with the tool first. It is a fixed set of text rules: no extra
  model call, no session state, at most once per turn.
- **Wolfram Language skill.** A `wolfram-math` skill lists the idioms that change an answer — `xy` is
  one symbol, `=` versus `==`, `Log` is the natural log, `Solve` drops parameter cases, where
  `Assumptions` belongs, exact versus numeric functions, and how to check a result. The model loads the
  body only while preparing a real call.
- **Answer cache.** An identical call within ten minutes is answered from memory and says `cached`
  instead of starting another kernel.
- **Write-confined execution.** When the session's sandbox policy is confined, the kernel runs through
  the session sandbox: a runaway expression cannot modify files outside the workspace and its private
  temporary directory, and the result is marked `sandboxed`. Reads and network are outside that
  backend's scope — see Limits.
- **Structured failures.** Syntax errors carry the kernel's own message (for example
  `ToExpression::sntxi`), `$Failed` evaluations, timeouts, and crashes each return a distinct status
  with an actionable hint. A conditional answer is labelled `Conditional:` so the model reports the
  condition with the result.

## Requirements

- Wolfram Engine (or Mathematica), activated on this machine, with the kernel binary `wolfram.exe`
  beside the `wolframscript` launcher. The install is discovered under
  `C:\Program Files\Wolfram Research`; override the kernel with `kernelPath`, or the launcher used to
  locate it with `wolframscriptPath`.
- **The kernel runs directly, not through `wolframscript`.** On Windows the launcher forwards its kernel's
  output through a pipe; a confined process cannot create that pipe, so all of the launcher's stdout is
  lost (its configuration warning is noise, not a failure). The kernel writes to the inherited handles and
  needs no configuration write, so launching it directly keeps diagnostics intact under confinement.
- No shell, PATH, or sandbox configuration is involved: the tool spawns the kernel binary with
  `-noprompt -script` and reads the result from a per-call temporary directory.

## Usage

The model calls it on its own when a problem warrants it. Example arguments:

```json
{ "code": "Integrate[Exp[-a x^2] Cos[b x], {x, -Infinity, Infinity}]", "label": "Gaussian cosine integral" }
```

Write **one** expression; sequence steps with `;` or wrap them in `Module`. Optional `timeoutSec`
(1–30 by default) bounds the kernel's own budget.

## Configuration

Settings live in the profile's `cordis.patch.yml` — the same file the Harness tells you to edit:

```yaml
- id: wolfram-math
  name: "@local/dsh-wolfram"
  config:
    kernelPath: 'C:\Program Files\Wolfram Research\Wolfram Engine\15.0\SystemFiles\Kernel\Binaries\Windows-x86-64\wolfram.exe'
    wolframscriptPath: 'C:\Program Files\Wolfram Research\Wolfram Engine\15.0\SystemFiles\Kernel\Binaries\Windows-x86-64\wolframscript.exe'
    timeoutMs: 30000
    autoNudge: heuristic     # off | heuristic
    nudgeThreshold: 5
    enableCache: true
    cacheMaxEntries: 16
    cacheTtlMs: 600000
    enableSkill: true
    sandbox: auto            # auto | off
```

`kernelPath` is the only executable the tool starts; `wolframscriptPath` is consulted only to find the
kernel beside it when `kernelPath` is unset. `sandbox: auto` honours the calling session's policy —
`workspace-write` and `read-only` confine the kernel, `danger-full-access` does not — and `off` always
runs unconfined. Every other field has a default; an unknown field fails activation with a message
naming it.

## Limits

- **Write-confined, not sandboxed.** When the calling session's policy is confined (`workspace-write`
  or `read-only`), the kernel runs through the session's sandbox and can write only where that policy
  allows — the workspace and its private temporary directory. The result then says `· sandboxed`. What
  the Windows backend does **not** restrict is reads and network: `Get["…"]` over files and
  `Import["http://…"]` still work, so confinement prevents damage to files, not data leaving the
  machine. Its enforcement is also reported as `partial`. A `danger-full-access` session, or
  `sandbox: off`, runs the kernel with no confinement at all.
- **Arbitrary code execution.** Wolfram Language can read and write files, start processes, and reach
  the network. Confinement narrows writes only; treat the tool's reach as equivalent to trusting the
  model with a shell, and use a container when the whole environment must be isolated.
- **Fail-closed.** If the session is confined but no sandbox backend can enforce it, the call fails
  with a message and an explicit opt-out (`sandbox: off`) rather than silently running unconfined.
- **Lexical refusals are advisory.** The `denyPatterns` setting refuses obvious `Run[...]`,
  `Import["http...]`, and similar constructs, but string construction can bypass it. The `refused`
  card is not proof that code was confined.
- **No plotting.** The tool returns textual forms only; graphics are not rendered.
- **Start-up cost.** Each call starts a fresh kernel — a few seconds regardless of the computation.
  Batch related questions into one expression; the cache covers exact repeats.
- **Cached answers are reused as-is.** Results are cached by expression text and timeout, so a
  deliberately non-deterministic expression such as `RandomReal[]` returns its first value until the
  entry expires. Disable the cache when that matters.
- **The nudge reads only the newest message.** A short follow-up such as "and the third one?" carries
  no math signal of its own, so it is not nudged; the model handles multi-step work inside a turn. A
  message that quotes this tool's own output is explicitly discounted, so pasting a result does not
  spawn another kernel.
- **Displayed precision is restated, not implied.** Arbitrary-precision numbers are shown without
  Wolfram's `` `30. `` mark and get a `Precision: 30 digits` line instead.
