// runImprovementStep — the propose → probe → compose → gate cycle as pure
// orchestration over injected deps. No I/O here: the substrate mounts and
// runs, the channels think, the gate decides. Everything is a function you
// hand in, which is exactly why the mock adapter can prove the seam.
//
//   channels.propose({task, spec, specHash, baseTrajectory, lessons})
//     → [{kind:'invariant'|'domain', description, patch}]
//   channels.compose({task, baseTrajectory, entries:[{label,diff,trajectory}]})
//     → {patch} | null
//   channels.select(textA, textB)                          — blind judge, optional
//     → 'A'|'B'|'tie'
//   channels.reflect({task, baseTrajectory, adoptedTrajectory, diffs, lessons})
//     → lesson draft {cue, lesson, evidence:[{runId,seq}]} | null
//
//   substrate.mount(spec) → handle
//   substrate.run(handle, task) → Evidence (normalized by the adapter)
//   substrate.dispose(handle)
//   substrate.capabilities() → flag map (optional)
//
//   gate.confirm(summary) → truthy to adopt   — required when the resolved
//   mode says 'human-required' or opts.requireHuman is set.
//
// Discipline carried over from the reference design: selectors see only
// deliverable text; lesson refs must resolve; the base is always in the
// adoption pool; a proposal that violates pins is rejected, not trimmed.

import { normalizeEvidence, formatTrajectory, formatDeliverable, contrastEvidences } from './evidence.js'
import { normalizeSpec, applyPatch, diffSpecs, formatDiff, specHash, composeUnionDisjoint } from './spec.js'
import { resolveCapabilities } from './capabilities.js'
import { admitLesson } from './lessons.js'
import { selectAdoption } from './selection.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

async function rollout(substrate, spec, task, label) {
  const handle = await substrate.mount(spec)
  try {
    const ev = normalizeEvidence(await substrate.run(handle, task))
    return { label, specHash: specHash(spec), evidence: ev }
  } finally {
    try { await substrate.dispose(handle) } catch (e) { /* teardown must not sink the step */ }
  }
}

/**
 * One improvement step for one task.
 * @param {object} deps
 * @returns {Promise<object>} result — see AGENTS.md vocabulary; never throws
 *   for operational failures (they land in `notes`), only for contract
 *   violations by the caller.
 */
export async function runImprovementStep(deps) {
  const {
    task, baseSpec: rawBase, baseEvidence,
    library, substrate, channels = {},
    gate, pins = [], caps,
    seqRefs, requireHuman, composeStrategy = 'model',
  } = deps ?? {}
  if (!isObj(task) || typeof task.id !== 'string' || typeof task.prompt !== 'string') {
    throw new Error('task must be {id, domain, prompt}')
  }
  if (!isObj(substrate)) throw new Error('substrate {mount, run, dispose} is required')

  const baseSpec = normalizeSpec(rawBase)
  const resolved = resolveCapabilities(caps ?? (typeof substrate.capabilities === 'function' ? substrate.capabilities() : {}))
  const { mode } = resolved
  const refsAreSeq = seqRefs ?? mode.refs === 'seq'
  const notes = []
  const trail = { evidences: [], proposals: [], selection: null }

  // ── 1. base rollout ────────────────────────────────────────────────────
  let baseEntry
  if (baseEvidence) {
    baseEntry = { label: 'base', specHash: specHash(baseSpec), evidence: normalizeEvidence(baseEvidence) }
  } else {
    if (mode.probes === 'offline') {
      return {
        ok: false, improved: false, adoptedSpec: baseSpec, adoptedLabel: 'base', lesson: null,
        notes: ['offline mode needs a supplied baseEvidence — nothing to analyze otherwise'],
        trail, mode,
      }
    }
    baseEntry = await rollout(substrate, baseSpec, task, 'base')
  }
  trail.evidences.push(baseEntry)
  const baseTrajectory = formatTrajectory(baseEntry.evidence)
  const evidenceByRun = new Map([[baseEntry.evidence.runId, baseEntry.evidence]])

  // ── 2. lessons the editor may read (prefix rule) ───────────────────────
  const lessons = library
    ? library.selectFor({ domain: task.domain ?? '_', beforeTaskIndex: task.index ?? Infinity })
    : []

  // ── 3. propose ─────────────────────────────────────────────────────────
  let proposals = []
  if (typeof channels.propose === 'function') {
    try {
      const out = await channels.propose({
        task, spec: baseSpec, specHash: baseEntry.specHash,
        baseTrajectory, lessons,
      })
      proposals = Array.isArray(out) ? out : []
    } catch (e) {
      notes.push(`propose failed: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  } else {
    notes.push('no propose channel — step is evidence-collection only')
  }

  // ── 4. probes ──────────────────────────────────────────────────────────
  const probeEntries = []
  for (const [i, p] of proposals.entries()) {
    const label = `candidate:${i}`
    if (!isObj(p) || !isObj(p.patch)) {
      notes.push(`${label}: rejected — proposal needs {description, patch}`)
      continue
    }
    let candSpec
    try {
      candSpec = applyPatch(baseSpec, p.patch, { pins })
    } catch (e) {
      notes.push(`${label}: patch rejected — ${String(e?.message ?? e).slice(0, 200)}`)
      continue
    }
    const prop = { label, kind: p.kind ?? 'invariant', description: String(p.description ?? ''), patch: p.patch, spec: candSpec }
    trail.proposals.push(prop)
    if (mode.probes === 'offline') {
      prop.probe = 'skipped-offline'
      continue
    }
    try {
      const entry = await rollout(substrate, candSpec, task, label)
      prop.probe = entry
      prop.diff = diffSpecs(baseSpec, candSpec)
      probeEntries.push(entry)
      trail.evidences.push(entry)
      evidenceByRun.set(entry.evidence.runId, entry.evidence)
    } catch (e) {
      prop.probe = 'failed'
      notes.push(`${label}: probe run failed — ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }

  // ── 5. compose ─────────────────────────────────────────────────────────
  // composeStrategy: 'model' (channel merge) | 'union' (deterministic
  // disjoint-leaf merge — no model) | 'model-else-union' (union when the
  // channel is absent or its patch is unusable). Union never guesses a
  // ranking: conflicting leaves stay on base and are reported.
  let refinedSpec = baseSpec
  let refinedDiffs = []
  const probed = trail.proposals.filter((p) => isObj(p.probe))
  const unionCompose = () => {
    const { patch, adopted, conflicts } = composeUnionDisjoint(baseSpec, probed.map((p) => p.spec), { pins })
    if (adopted.length === 0) return
    refinedSpec = applyPatch(baseSpec, patch, { pins })
    refinedDiffs = diffSpecs(baseSpec, refinedSpec)
    notes.push(`compose[union]: adopted ${adopted.length} agreed leaves` +
      (conflicts.length ? `, left ${conflicts.length} conflicting on base (${conflicts.join(', ')})` : ''))
  }
  const wantUnion = composeStrategy === 'union' || (composeStrategy === 'model-else-union' && typeof channels.compose !== 'function')
  if (wantUnion && probed.length) {
    unionCompose()
  } else if (typeof channels.compose === 'function' && probed.length) {
    try {
      const entries = probed.map((p) => ({
        label: p.label,
        diff: formatDiff(p.diff ?? []),
        contrast: contrastEvidences(baseEntry.evidence, p.probe.evidence),
        trajectory: formatTrajectory(p.probe.evidence),
      }))
      const out = await channels.compose({ task, baseTrajectory, entries })
      if (out && isObj(out.patch)) {
        refinedSpec = applyPatch(baseSpec, out.patch, { pins })
        refinedDiffs = diffSpecs(baseSpec, refinedSpec)
      } else if (composeStrategy === 'model-else-union') {
        unionCompose()
      }
    } catch (e) {
      notes.push(`compose rejected: ${String(e?.message ?? e).slice(0, 200)}`)
      if (composeStrategy === 'model-else-union') unionCompose()
    }
  } else if (typeof channels.compose !== 'function') {
    notes.push('no compose channel — candidates stand unmerged')
  }

  // ── 6. final rollout of the refined spec (only if it differs) ──────────
  let refinedEntry = null
  if (refinedDiffs.length && mode.probes !== 'offline') {
    refinedEntry = await rollout(substrate, refinedSpec, task, 'refined')
    trail.evidences.push(refinedEntry)
    evidenceByRun.set(refinedEntry.evidence.runId, refinedEntry.evidence)
  } else if (!refinedDiffs.length && trail.proposals.length) {
    notes.push('compose produced no net change — refined == base')
  }

  // ── 7. blind selection over finals (base always in pool) ───────────────
  const finals = [baseEntry, ...probeEntries, ...(refinedEntry ? [refinedEntry] : [])]
  const specOf = (label) =>
    label === 'refined' ? refinedSpec
    : label.startsWith('candidate:')
      ? trail.proposals.find((p) => p.label === label)?.spec ?? baseSpec
      : baseSpec
  let selection = null
  if (finals.length > 1 && mode.probes !== 'offline') {
    selection = await selectAdoption({
      entries: finals.map((e) => ({ label: e.label, text: formatDeliverable(e.evidence) })),
      judge: channels.select,
    })
    trail.selection = selection
    notes.push(`selection: ${selection.reason} (confidence ${selection.confidence})`)
  }

  // ── 8. gate ────────────────────────────────────────────────────────────
  let adopted = baseEntry
  let gateResult = 'none'
  const winner =
    selection && selection.adoptIndex >= 0 ? finals[selection.adoptIndex] : null
  const humanRequired =
    mode.adoptionGate === 'human-required' ||
    requireHuman === true ||
    !channels.select ||
    (selection && selection.confidence === 'inconsistent')
  if (winner) {
    const summary = {
      label: winner.label,
      reason: selection.reason,
      confidence: selection.confidence,
      specDiff: formatDiff(diffSpecs(baseSpec, specOf(winner.label))),
    }
    if (humanRequired) {
      if (typeof gate?.confirm === 'function') {
        const yes = await gate.confirm(summary)
        gateResult = yes ? 'approved' : 'declined'
        notes.push(yes ? 'gate: human approved adoption' : 'gate: human declined — keeping base')
        if (yes) adopted = winner
      } else {
        gateResult = 'missing'
        notes.push('gate: human required but no gate.confirm — keeping base (safe default)')
      }
    } else {
      adopted = winner
      gateResult = 'auto'
      notes.push('gate: auto-adopted on routed channel')
    }
  }

  const adoptedSpec = specOf(adopted.label)

  // ── 9. reflect → lesson ────────────────────────────────────────────────
  let lesson = null
  if (typeof channels.reflect === 'function') {
    try {
      const adoptedEntry = adopted === baseEntry ? (refinedEntry ?? baseEntry) : adopted
      const adoptedDiffs = adopted === baseEntry ? []
        : adopted === refinedEntry ? refinedDiffs
        : (trail.proposals.find((p) => p.probe === adopted)?.diff ?? [])
      const draft = await channels.reflect({
        task,
        baseTrajectory,
        adoptedTrajectory: formatTrajectory(adoptedEntry.evidence),
        adoptedLabel: adoptedEntry.label,
        diffs: refinedDiffs.length ? formatDiff(refinedDiffs) : '(no harness change adopted)',
        improved: adopted !== baseEntry,
        selectionReason: selection?.reason ?? null,
        gateResult,
        adoptedDiff: adoptedDiffs.length ? formatDiff(adoptedDiffs) : null,
        runIds: { base: baseEntry.evidence.runId, adopted: adoptedEntry.evidence.runId },
        citeable: [baseEntry, adoptedEntry].map((e) => ({
          runId: e.evidence.runId,
          seqs: e.evidence.steps.map((s) => s.seq),
        })),
      })
      if (draft && isObj(draft)) {
        const { ok, errors, entry } = admitLesson(
          { ...draft, domain: task.domain ?? '_' },
          { lookupRun: (id) => evidenceByRun.get(id) ?? null, seqRefs: refsAreSeq },
        )
        if (ok) {
          lesson = entry // returned regardless — caller may persist it
          if (library) library.add(entry, { taskIndex: task.index ?? 0 })
        } else {
          notes.push(`lesson rejected: ${errors.join('; ')}`)
        }
      }
    } catch (e) {
      notes.push(`reflect failed: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }

  return {
    ok: true,
    improved: adopted !== baseEntry,
    adoptedSpec,
    adoptedLabel: adopted.label,
    lesson,
    notes,
    trail,
    mode,
  }
}
