// Canonical evidence model — the ONE shape the method reads.
//
// Every substrate adapter must convert its native run log into this shape.
// The method core never sees a host event, transcript line, or raw tool dump:
// it sees `Evidence`. Two evidences are comparable iff they went through
// `normalizeEvidence`.
//
// Hard rules (enforced here, so adapters cannot smuggle them past):
//   - no verdict fields anywhere in the object (score/grade/rubric/passed…);
//   - steps carry strictly increasing unique `seq` ints — lessons reference
//     `runId + seq`, so sequence integrity is a correctness requirement;
//   - `task.prompt` describes the WORK. Grading criteria never reach the
//     editor; adapters strip them before building the evidence.

const STEP_KINDS = Object.freeze(['action', 'observation', 'error', 'correction'])

const OUTCOMES = Object.freeze(['ok', 'error', 'timeout', 'aborted'])

// Field names that would leak the verdict channel into the improver's view.
// Checked at every nesting level — a nested 'score' is still a leak.
const FORBIDDEN_FIELDS = Object.freeze([
  'score', 'scores', 'grade', 'graded', 'rubric', 'rubrics',
  'passed', 'n_passed', 'all_pass', 'verdict', 'judge', 'judgeResult',
  'criteria', 'evaluation', 'evalResult',
])

// Tokens that must not appear in task.prompt — the task describes work, not
// its measurement. Same discipline as Harness²'s BenchPrompts validator.
const FORBIDDEN_TASK_TOKENS = Object.freeze([
  'rubric', 'grader', 'benchmark', 'score', 'criteria', 'evaluation',
])

const DEFAULT_OBS_TRUNC = 50_000

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'

function scanForbidden(obj, path, hits) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) scanForbidden(obj[i], `${path}[${i}]`, hits)
    return
  }
  if (!isObj(obj)) return
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_FIELDS.includes(k.toLowerCase())) hits.push(`${path}.${k}`)
    scanForbidden(obj[k], `${path}.${k}`, hits)
  }
}

/**
 * Deep-scan for verdict-leaking field names. Returns offending paths.
 * @param {unknown} obj
 * @returns {string[]} empty when clean.
 */
export function findVerdictLeaks(obj) {
  const hits = []
  scanForbidden(obj, '$', hits)
  return hits
}

/**
 * Validate and normalize one step. Throws with an actionable message.
 */
function normalizeStep(raw, i) {
  if (!isObj(raw)) throw new Error(`steps[${i}] must be an object, got ${typeof raw}`)
  const { seq, kind } = raw
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`steps[${i}].seq must be an integer >= 1, got ${JSON.stringify(seq)}`)
  }
  if (!STEP_KINDS.includes(kind)) {
    throw new Error(`steps[${i}].kind must be one of ${STEP_KINDS.join('|')}, got ${JSON.stringify(kind)}`)
  }
  const step = { seq, kind }
  if (raw.tool !== undefined) {
    if (!isStr(raw.tool) || !raw.tool.trim()) throw new Error(`steps[${i}].tool must be a non-empty string`)
    step.tool = raw.tool
  }
  for (const f of ['input', 'text', 'summary']) {
    if (raw[f] !== undefined) {
      if (!isStr(raw[f])) throw new Error(`steps[${i}].${f} must be a string`)
      step[f] = raw[f]
    }
  }
  return step
}

/**
 * Validate and normalize one Evidence object.
 * Throws Error listing the first problem found; returns a fresh object —
 * callers can rely on the returned shape exactly.
 * @param {unknown} raw
 * @returns {object} normalized Evidence
 */
export function normalizeEvidence(raw) {
  if (!isObj(raw)) throw new Error(`Evidence must be an object, got ${typeof raw}`)

  const leaks = findVerdictLeaks(raw)
  if (leaks.length) {
    throw new Error(
      `Evidence carries verdict fields at ${leaks.join(', ')} — the improver ` +
      `must never see scores; strip them in the adapter`,
    )
  }

  if (!isStr(raw.runId) || !raw.runId.trim()) throw new Error('Evidence.runId must be a non-empty string')
  if (!isStr(raw.specHash) || !raw.specHash.trim()) {
    throw new Error('Evidence.specHash must be a non-empty string — every rollout knows its spec')
  }

  const task = raw.task
  if (!isObj(task)) throw new Error('Evidence.task must be an object {id, domain, prompt}')
  if (!isStr(task.id) || !task.id.trim()) throw new Error('Evidence.task.id must be a non-empty string')
  if (!isStr(task.domain) || !task.domain.trim()) {
    throw new Error('Evidence.task.domain must be a non-empty string — the library groups by it')
  }
  if (!isStr(task.prompt) || !task.prompt.trim()) {
    throw new Error('Evidence.task.prompt must be a non-empty string')
  }

  const rawSteps = raw.steps
  if (!Array.isArray(rawSteps)) throw new Error('Evidence.steps must be an array')
  const steps = rawSteps.map(normalizeStep)
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].seq <= steps[i - 1].seq) {
      throw new Error(
        `Evidence.steps seqs must be strictly increasing — steps[${i}].seq=${steps[i].seq} ` +
        `follows ${steps[i - 1].seq}; lesson refs runId+seq require it`,
      )
    }
  }

  const del = raw.deliverable ?? {}
  if (!isObj(del)) throw new Error('Evidence.deliverable must be an object')
  const files = {}
  if (del.files !== undefined) {
    if (!isObj(del.files)) throw new Error('Evidence.deliverable.files must be an object name→text')
    for (const [name, content] of Object.entries(del.files)) {
      if (!isStr(content)) throw new Error(`Evidence.deliverable.files[${JSON.stringify(name)}] must be a string`)
      files[name] = content
    }
  }
  const deliverable = {
    delivered: del.delivered === true,
    finalText: isStr(del.finalText) ? del.finalText : '',
    files,
  }

  if (!OUTCOMES.includes(raw.outcome)) {
    throw new Error(`Evidence.outcome must be one of ${OUTCOMES.join('|')}, got ${JSON.stringify(raw.outcome)}`)
  }

  const s = raw.stats ?? {}
  if (!isObj(s)) throw new Error('Evidence.stats must be an object')
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const stats = {
    steps: num(s.steps ?? steps.length),
    toolCalls: num(s.toolCalls),
    tokens: num(s.tokens),
    wallS: num(s.wallS),
    costUsd: num(s.costUsd),
  }

  return {
    runId: raw.runId,
    specHash: raw.specHash,
    task: { id: task.id, domain: task.domain, prompt: task.prompt },
    steps,
    deliverable,
    outcome: raw.outcome,
    stats,
  }
}

/**
 * Warn (not throw) when the task text smells like measurement instead of work.
 * Returns the offending tokens; adapters should strip upstream, but a hint in
 * status output is honest rather than silent.
 * @param {object} evidence normalized evidence
 * @returns {string[]}
 */
export function taskLeakTokens(evidence) {
  const low = evidence.task.prompt.toLowerCase()
  return FORBIDDEN_TASK_TOKENS.filter((t) => low.includes(t))
}

const stepLine = (s) => {
  const tag = { action: 'ACTION', observation: 'OBS', error: 'ERR', correction: 'CORR' }[s.kind]
  const parts = [`[${tag} #${s.seq}]`]
  if (s.tool) parts.push(`tool=${s.tool}`)
  if (s.input) parts.push(`input=${s.input}`)
  if (s.text) parts.push(s.text)
  if (s.summary) parts.push(`— ${s.summary}`)
  return parts.join(' ')
}

/**
 * Render the shared [ACTION]/[OBS]/[ERR]/[CORR] text grammar an editor model
 * consumes. Deterministic: same evidence → same text, so prompt caches hit.
 * @param {object} evidence normalized evidence
 * @param {object} [opts]
 * @param {number} [opts.obsTrunc] per-step text cap in chars (default 50000;
 *   below ~10k the editor invents defects that never happened)
 * @returns {string}
 */
export function formatTrajectory(evidence, { obsTrunc = DEFAULT_OBS_TRUNC } = {}) {
  const clip = (t) => (t.length > obsTrunc ? t.slice(0, obsTrunc) + `…[${t.length - obsTrunc} chars truncated]` : t)
  const lines = [`[TASK] ${clip(evidence.task.prompt)}`]
  for (const s of evidence.steps) {
    lines.push(stepLine({ ...s, text: s.text ? clip(s.text) : s.text, input: s.input ? clip(s.input) : s.input }))
  }
  const d = evidence.deliverable
  if (d.delivered) {
    const names = Object.keys(d.files)
    lines.push(`[DELIVERED]${names.length ? ' files=' + names.join(',') : ''}`)
  } else {
    lines.push('[NOT-DELIVERED]')
  }
  const st = evidence.stats
  lines.push(
    `[OUTCOME] ${evidence.outcome} steps=${st.steps} tools=${st.toolCalls} ` +
    `tokens=${st.tokens} wall=${st.wallS}s cost=$${st.costUsd}`,
  )
  return lines.join('\n')
}

/**
 * Deliverable text for a blind selector: final message + file contents.
 * Contains NO label, NO spec hash — the selector judges work, not provenance.
 * @param {object} evidence
 * @returns {string}
 */
export function formatDeliverable(evidence) {
  const d = evidence.deliverable
  const parts = []
  if (d.finalText) parts.push(d.finalText)
  for (const [name, content] of Object.entries(d.files)) {
    parts.push(`--- ${name} ---\n${content}`)
  }
  return parts.join('\n\n') || '(no deliverable)'
}

const countTools = (steps) => {
  const m = new Map()
  for (const s of steps) {
    if (s.kind !== 'action' || !s.tool) continue
    m.set(s.tool, (m.get(s.tool) ?? 0) + 1)
  }
  return m
}

/**
 * Behavioral contrast between two rollouts of the same task — the evidence
 * the compose/select stages actually reason over. Pure diff of observable
 * behavior, never of scores.
 * @param {object} a normalized evidence (typically the base run)
 * @param {object} b normalized evidence (typically a candidate run)
 * @returns {object} structured contrast
 */
export function contrastEvidences(a, b) {
  const ta = countTools(a.steps)
  const tb = countTools(b.steps)
  const onlyA = [], onlyB = [], moreB = [], moreA = []
  for (const [t, n] of ta) {
    if (!tb.has(t)) onlyA.push(`${t}×${n}`)
    else if (tb.get(t) > n) moreB.push(`${t}:${n}→${tb.get(t)}`)
  }
  for (const [t, n] of tb) {
    if (!ta.has(t)) onlyB.push(`${t}×${n}`)
    else if (n < ta.get(t)) moreA.push(`${t}:${ta.get(t)}→${n}`)
  }
  const k = (ev, kind) => ev.steps.filter((s) => s.kind === kind).length
  return {
    toolsOnlyA: onlyA, toolsOnlyB: onlyB, toolsMoreInB: moreB, toolsMoreInA: moreA,
    errors: { a: k(a, 'error'), b: k(b, 'error') },
    corrections: { a: k(a, 'correction'), b: k(b, 'correction') },
    delivered: { a: a.deliverable.delivered, b: b.deliverable.delivered },
    outcome: { a: a.outcome, b: b.outcome },
    statsDelta: {
      tokens: b.stats.tokens - a.stats.tokens,
      wallS: b.stats.wallS - a.stats.wallS,
      toolCalls: b.stats.toolCalls - a.stats.toolCalls,
      steps: b.stats.steps - a.stats.steps,
      costUsd: +(b.stats.costUsd - a.stats.costUsd).toFixed(6),
    },
  }
}

/** One-paragraph rendering of a contrast for prompts/status. */
export function formatContrast(c) {
  const lines = []
  if (c.toolsOnlyB.length) lines.push(`+tools in B: ${c.toolsOnlyB.join(', ')}`)
  if (c.toolsOnlyA.length) lines.push(`-tools vs A: ${c.toolsOnlyA.join(', ')}`)
  if (c.toolsMoreInB.length) lines.push(`more calls in B: ${c.toolsMoreInB.join(', ')}`)
  if (c.toolsMoreInA.length) lines.push(`fewer calls in B: ${c.toolsMoreInA.join(', ')}`)
  lines.push(`errors ${c.errors.a}→${c.errors.b}, corrections ${c.corrections.a}→${c.corrections.b}`)
  lines.push(`delivered ${c.delivered.a}→${c.delivered.b}, outcome ${c.outcome.a}→${c.outcome.b}`)
  const d = c.statsDelta
  lines.push(`Δ steps ${d.steps >= 0 ? '+' : ''}${d.steps}, tools ${d.toolCalls >= 0 ? '+' : ''}${d.toolCalls}, tokens ${d.tokens >= 0 ? '+' : ''}${d.tokens}, $${d.costUsd >= 0 ? '+' : ''}${d.costUsd}`)
  return lines.join('\n')
}
