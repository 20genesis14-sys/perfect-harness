// Campaign — the harnessing-level recursion made concrete: run N tasks in
// order, let each step's ADOPTED spec become the next task's base, and let
// the lesson library accumulate under the prefix rule (task i sees only
// lessons from tasks < i in its domain — ordering is load-bearing).
//
// Pure orchestration: no I/O, no host imports — substrates/channels/library
// are injected. A step that throws is recorded and the campaign continues
// with the UNCHANGED spec (honest degradation, one bad task can't sink a run).

import { runImprovementStep } from './loop.js'
import { specHash } from './spec.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * @param {object} args
 * @param {object[]} args.tasks [{id, domain, prompt, ...}]
 * @param {object} args.baseSpec initial harness spec
 * @param {object} args.substrate {mount, run, dispose}
 * @param {object} args.channels {propose, compose, select, reflect}
 * @param {object} args.caps capability flags for the substrate in use
 * @param {object} [args.library] lesson library (selectFor/add contract)
 * @param {object} [args.gate] {confirm} human/operator gate
 * @param {object} [args.opts] {pins, requireHuman, seqRefs, proposeCount?}
 * @param {(i:number, step:object)=>void} [args.onStep] progress sink
 * @returns {Promise<object>} campaign report
 */
export async function runCampaign({ tasks, baseSpec, substrate, channels, caps, library, gate, opts = {}, onStep } = {}) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('runCampaign needs a non-empty task list')
  if (!isObj(substrate) || typeof substrate.mount !== 'function') throw new Error('runCampaign needs a substrate')
  const spec = baseSpec ?? {}
  let current = spec
  const steps = []
  const started = Date.now()

  for (const [i, t] of tasks.entries()) {
    const task = { index: i, domain: '_', ...t }
    let step
    try {
      step = await runImprovementStep({
        task,
        baseSpec: current,
        substrate, channels, caps,
        library, gate,
        pins: opts.pins,
        requireHuman: opts.requireHuman,
        seqRefs: opts.seqRefs,
      })
    } catch (e) {
      step = { ok: false, improved: false, adoptedSpec: current, adoptedLabel: 'base', lesson: null, notes: [`step crashed: ${String(e?.message ?? e).slice(0, 200)}`], trail: { evidences: [], proposals: [], selection: null } }
    }
    const adopted = step.adoptedSpec ?? current
    const changed = step.improved === true && adopted !== current
    if (changed) current = adopted
    const rec = {
      taskId: task.id, domain: task.domain,
      ok: step.ok !== false, improved: changed, adoptedLabel: step.adoptedLabel,
      proposals: step.trail?.proposals?.length ?? 0,
      evidences: step.trail?.evidences?.length ?? 0,
      lessonId: step.lesson?.id ?? null,
      specHash: specHash(current),
      notes: step.notes ?? [],
    }
    steps.push(rec)
    try { onStep?.(i, rec) } catch { /* progress sink never sinks the run */ }
  }

  const adoptedCount = steps.filter((s) => s.improved).length
  return {
    ok: true,
    tasks: steps,
    finalSpec: current,
    metrics: {
      total: steps.length,
      improved: adoptedCount,
      baseKept: steps.length - adoptedCount,
      adoptionRate: steps.length ? adoptedCount / steps.length : 0,
      lessonsWritten: steps.filter((s) => s.lessonId).length,
      wallMs: Date.now() - started,
    },
  }
}
