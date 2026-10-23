// Mock substrate — the seam-proving adapter. No host, no model, no I/O:
// it stores specs in memory, "runs" tasks by calling an injected script, and
// reports every capability flag as false unless told otherwise.
//
// Its job is to prove the seam is drawn correctly: if the method core can
// run a full improvement step against THIS, the contract is honored and any
// real substrate (DSH, Claude Code, …) is a mapping exercise, not a redesign.
// It doubles as the test fixture for the whole suite — and, with every flag
// off, as the worst-case degradation stress test.

import { normalizeEvidence } from '../core/evidence.js'
import { specHash, normalizeSpec } from '../core/spec.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

let runCounter = 0

const defaultScript = (spec, task) => ({
  runId: `mock_${++runCounter}`,
  specHash: specHash(spec),
  task: { id: task.id, domain: task.domain ?? '_', prompt: task.prompt },
  steps: [
    { seq: 1, kind: 'action', tool: 'echo', input: task.prompt.slice(0, 60) },
    { seq: 2, kind: 'observation', text: 'mock step done' },
  ],
  deliverable: { delivered: true, finalText: `mock answer for ${task.id}`, files: {} },
  outcome: 'ok',
  stats: { steps: 2, toolCalls: 1, tokens: 100, wallS: 0.01, costUsd: 0 },
})

/**
 * @param {object} [opts]
 * @param {object} [opts.capabilities] flag overrides — default: ALL false
 * @param {(spec:object, task:object)=>object|Promise<object>} [opts.script]
 *   produces the raw evidence per (spec, task); sees the normalized spec, so
 *   scripts can branch on harness contents — that IS the probe.
 * @returns {object} mock substrate honoring the adapter contract
 */
export function createMockSubstrate({ capabilities = {}, script } = {}) {
  const runScript = typeof script === 'function' ? script : defaultScript
  const journal = []
  let nextHandle = 0

  return {
    journal,

    capabilities() {
      return {
        isolatedMount: false, seededFork: false, modelRouting: false,
        liveRestrict: false, structuredLog: false, logRecords: false,
        userSignal: false,
        ...capabilities,
      }
    },

    async mount(spec) {
      const normalized = normalizeSpec(spec) // adapter enforces the contract too
      const handle = { id: `h_${++nextHandle}`, spec: normalized, disposed: false }
      journal.push({ op: 'mount', handle: handle.id, specHash: specHash(normalized) })
      return handle
    },

    async run(handle, task) {
      if (!isObj(handle) || handle.disposed) {
        throw new Error(`run on a disposed/foreign handle — mount() first`)
      }
      journal.push({ op: 'run', handle: handle.id, taskId: task.id })
      const raw = await runScript(handle.spec, task)
      // The adapter contract: every substrate returns valid Evidence.
      // normalize here — if the script emits garbage, the error names it.
      return normalizeEvidence(raw)
    },

    async dispose(handle) {
      if (handle && !handle.disposed) {
        handle.disposed = true
        journal.push({ op: 'dispose', handle: handle.id })
      }
    },
  }
}

/**
 * Scripted channels — deterministic propose/compose/select/reflect, the
 * no-model twin of Harness²'s demo editors. Lets the whole loop run offline.
 * @param {object} [opts]
 * @param {object[]} [opts.proposals] fixed proposals for channels.propose
 * @param {object|((ctx)=>object|null)} [opts.composed] patch (or fn) for compose
 * @param {(a:string,b:string)=>('A'|'B'|'tie')|Promise<'A'|'B'|'tie'>} [opts.judge]
 * @param {object|((ctx)=>object|null)} [opts.lesson] draft (or fn) for reflect
 */
export function createScriptedChannels({ proposals = [], composed = null, judge, lesson = null } = {}) {
  return {
    async propose() { return proposals.map((p) => ({ ...p })) },

    async compose(ctx) {
      if (typeof composed === 'function') return composed(ctx)
      return composed ? { patch: composed } : null
    },

    select: typeof judge === 'function'
      ? async (a, b) => judge(a, b)
      : async () => 'tie',

    async reflect(ctx) {
      if (typeof lesson === 'function') return lesson(ctx)
      return lesson ? { ...lesson } : null
    },
  }
}
