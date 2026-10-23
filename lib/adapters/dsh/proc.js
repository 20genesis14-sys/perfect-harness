// DSH external-process substrate — every roll-out is a REAL OS process:
// `dsh headless --patch <base> --patch <generated> --json <task>` parsed from
// the NDJSON event stream on stdout. Verified live against the desktop CLI
// (ELECTRON_RUN_AS_NODE + --expose-internals entry).
//
// vs the in-process substrate (index.js):
//   + TRUE isolation — no shared host, no teardown race (the in-process
//     factory dies when the main task ends; each proc here lives exactly as
//     long as its own roll-out)
//   - no seededFork (no way to seed a fresh process), no logRecords, no
//     userSignal, no per-request tools.restrict (patch rows disable whole
//     plugins — coarser than the in-process keep-list; honestly flagged)
//
// Spec→patch mapping (verified rows):
//   model.{provider,model,effort} → `agent-default-model` config
//     {provider, model, reasoningEffort?}  (config schema read from
//     dsh-agent-default-model/lib/index.js — all three fields volatile)
//   prompt.{persona,guidance,systemAppend,toolGuidance} → generated
//     `ph-sections.mjs` plugin registering systemPrompt.section rows
//   skills/agents/scripts → `insert:` rows beside the generated patch
//     (scripts' source → sibling .mjs files — patch-anchored relative names
//     ARE legal here, unlike registered presets)
//   tools.keep/hide → honest note: row-disabling needs a tool→plugin-row
//     map we haven't built; restrict is per-request, not patch-able.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeEvidence } from '../../core/evidence.js'
import { normalizeSpec, specHash } from '../../core/spec.js'
import { planMount } from './spec-mount.js'

const fn = (v) => typeof v === 'function'
const isStr = (v) => typeof v === 'string'

/** Minimal YAML emitter — patches are nested {row} lists + scalars only. */
const dumpYaml = (v, indent = 0) => {
  const pad = '  '.repeat(indent)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (/^[a-zA-Z0-9_./@:+$\\-]+$/.test(v) && !/^(true|false|null|y|n|yes|no|on|off)$/i.test(v)) return v
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    return v.map((item) => {
      if (item !== null && typeof item === 'object') {
        const inner = dumpYaml(item, indent + 1)
        const lines = inner.split('\n')
        return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join('\n')}`
      }
      return `${pad}- ${dumpYaml(item, 0)}`
    }).join('\n')
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return '{}'
    return keys.map((k) => {
      const val = v[k]
      const complex = val !== null && typeof val === 'object' && (Array.isArray(val) ? val.length : Object.keys(val).length)
      return `${pad}${k}:${complex ? '\n' + dumpYaml(val, indent + 1) : ' ' + dumpYaml(val, 0)}`
    }).join('\n')
  }
  return JSON.stringify(v)
}

/** Generated plugin carrying prompt sections for the main headless agent. */
const sectionsPlugin = (sections) => `export const name = 'ph-spec-sections'
export function apply(ctx) {
  const sp = ctx.get?.('systemPrompt') ?? ctx.systemPrompt
  if (!sp || typeof sp.section !== 'function') return
${sections.map((s) => `  try { sp.section({ name: ${JSON.stringify(s.name)}, order: ${JSON.stringify(s.order)}, text: ${JSON.stringify(s.text)}, interpolate: false }) } catch {}`).join('\n')}
}
`

/** NDJSON status-phase → canonical outcome mapping (turn_end.reason.kind). */
const REASON_OUTCOME = {
  completed: 'ok',
  aborted: 'aborted',
  error: 'error',
}

/**
 * Parse a `dsh headless --json` stdout stream into canonical evidence parts.
 * Stream vocabulary (verified live):
 *   session{sessionId,cwd} · status{phase,turn,step,usage,reason}
 *   text{text} · tool_call{callId,tool,input} · tool_result{callId,status,result}
 *   final{text}
 * seqs are STREAM-ORDER ordinals — the host's session-log seqs never reach
 * stdout, so lesson refs cite these synthetic numbers (documented limit).
 */
export function evidenceFromNdjson(stdout, { taskId, domain, prompt, wallS, specHash: sHash } = {}) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const steps = []
  const callNames = new Map()
  let runId = `dshproc:${randomUUID()}`
  let outcome = 'error'
  let finalText = ''
  let delivered = false
  let tokens = 0
  const errors = []
  let seq = 0
  for (const line of lines) {
    let ev
    try { ev = JSON.parse(line) } catch { continue } // non-JSON noise (warnings)
    if (ev.type === 'session' && isStr(ev.sessionId)) {
      runId = `dshproc:${ev.sessionId}`
    } else if (ev.type === 'tool_call' && isStr(ev.tool)) {
      callNames.set(ev.callId, ev.tool)
      steps.push({ seq: seq++, kind: 'action', tool: ev.tool, input: JSON.stringify(ev.input ?? {}) })
    } else if (ev.type === 'tool_result') {
      const isErr = ev.status !== undefined && ev.status !== 'completed'
      steps.push({
        seq: seq++, kind: isErr ? 'error' : 'observation',
        tool: callNames.get(ev.callId) ?? 'tool',
        text: isStr(ev.result) ? ev.result : JSON.stringify(ev.result ?? ''),
      })
    } else if (ev.type === 'text' && isStr(ev.text)) {
      finalText = ev.text // last text wins — same rule as session-log evidence
    } else if (ev.type === 'status') {
      if (ev.phase === 'step_end' && ev.usage && Number.isFinite(ev.usage.totalTokens)) {
        tokens = Math.max(tokens, ev.usage.totalTokens)
      } else if (ev.phase === 'turn_end') {
        const kind = ev.reason?.kind
        outcome = REASON_OUTCOME[kind] ?? (kind ? 'error' : outcome)
        if (kind && !REASON_OUTCOME[kind]) errors.push(`unmapped turn reason ${kind}`)
      }
    } else if (ev.type === 'final' && isStr(ev.text)) {
      finalText = ev.text
      delivered = true
    } else if (ev.type === 'error') {
      steps.push({ seq: seq++, kind: 'error', text: String(ev.message ?? ev.error ?? line).slice(0, 2000) })
    }
  }
  if (outcome === 'error' && delivered) outcome = 'ok' // final wins over missing turn_end
  return normalizeEvidence({
    runId,
    specHash: sHash ?? 'proc',
    task: { id: taskId ?? 'proc-task', domain: domain ?? '_', prompt: prompt ?? '' },
    steps,
    deliverable: { delivered, finalText, files: {} },
    outcome,
    stats: {
      steps: steps.length,
      toolCalls: steps.filter((s) => s.kind === 'action').length,
      tokens, wallS: Math.round(wallS ?? 0), costUsd: 0,
    },
  })
}

/**
 * @param {object} args
 * @param {string} args.exe host executable (DeepSeek Harness.exe)
 * @param {string} args.cli path to the desktop-host cli.js inside app.asar
 * @param {string[]} args.basePatches patch files always applied (provider
 *   credentials, registry insert — e.g. tests/live/probe.patch.yml)
 * @param {string} [args.workdir] default cwd + temp-patch parent
 * @param {object} [args.deps] {spawnImpl} for tests
 */
export function createDshProcSubstrate({ exe, cli, basePatches = [], workdir, deps = {}, opts = {} } = {}) {
  if (!isStr(exe) || !isStr(cli)) throw new Error('createDshProcSubstrate needs {exe, cli} paths')
  const spawnImpl = deps.spawnImpl ?? spawn
  const cwd = workdir ?? process.cwd()

  const capabilities = () => ({
    isolatedMount: true,   // stronger than in-process: a real OS process
    seededFork: false,     // no seed seam on a fresh process
    modelRouting: true,    // agent-default-model config row
    liveRestrict: false,   // patch can only disable whole plugins — coarser
    structuredLog: true,   // NDJSON stream
    logRecords: false,
    userSignal: false,
  })

  const mount = async (spec) => {
    const normalized = normalizeSpec(spec)
    const plan = planMount(normalized, { toolUniverse: [] }) // patch-level: no universe to intersect
    const notes = [...plan.notes]
    const dir = await mkdtemp(join(tmpdir(), 'ph-proc-'))
    const patchRows = []

    // model routing → default-model row (all three fields verified volatile)
    const m = normalized.model
    if (m && (m.provider || m.model || m.effort)) {
      const config = {}
      if (m.provider) config.provider = m.provider
      if (m.model) config.model = m.model
      if (m.effort) config.reasoningEffort = m.effort
      patchRows.push({ id: 'agent-default-model', config })
    }

    // prompt sections → generated sibling plugin (relative './' anchors at
    // the PATCH file — legal for patches, unlike registered presets)
    if (plan.sections.length) {
      const file = join(dir, 'ph-sections.mjs')
      await writeFile(file, sectionsPlugin(plan.sections))
      patchRows.push({ insert: [{ id: 'ph-spec-sections', name: './ph-sections.mjs' }] })
    }

    // tools.keep/hide → honest note (no per-request restrict externally)
    if (normalized.tools?.keep?.length || normalized.tools?.hide?.length) {
      notes.push('tools.keep/hide: no per-request restrict on a spawned process — closest patch equivalent is disabling plugin rows (not mapped yet) — skipped')
    }

    // preset rows → inserts; scripts' __content → sibling .mjs files
    const inserts = []
    for (const row of plan.presetRows) {
      if (row.__content !== undefined) {
        const { __content, ...rest } = row
        const file = join(dir, `${row.id}.mjs`)
        try {
          await writeFile(file, __content)
          inserts.push({ ...rest, name: `./${row.id}.mjs` })
        } catch (e) {
          notes.push(`scripts.${row.id}: scratch write failed — ${String(e?.message ?? e).slice(0, 120)}`)
        }
      } else {
        inserts.push(row)
      }
    }
    if (inserts.length) patchRows.push({ insert: inserts })

    const patchPath = join(dir, 'ph-spec.patch.yml')
    await writeFile(patchPath, dumpYaml(patchRows) + '\n')
    return { dir, patchPath, notes, specHash: specHash(normalized) }
  }

  const run = async (handle, task) => {
    const patchArgs = [...basePatches, handle.patchPath].flatMap((p) => ['--patch', p])
    const started = Date.now()
    const child = spawnImpl(exe, ['--expose-internals', cli, 'headless', ...patchArgs, '--json', task.prompt], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd,
    })
    const stdout = await new Promise((resolvePromise, reject) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr?.on('data', () => {}) // drain
      child.on('error', reject)
      child.on('close', () => resolvePromise(out))
    })
    const wallS = (Date.now() - started) / 1000
    return evidenceFromNdjson(stdout, { taskId: task.id, domain: task.domain, prompt: task.prompt, wallS, specHash: handle.specHash })
  }

  const dispose = async (handle) => {
    try { await rm(handle.dir, { recursive: true, force: true }) } catch { /* scratch best-effort */ }
  }

  const describeMount = (h) => `proc patch=${h.patchPath}`

  return { capabilities, mount, run, dispose, describeMount, notes: () => [] }
}
