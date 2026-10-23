import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runImprovementStep } from '../lib/core/loop.js'
import { createMockSubstrate, createScriptedChannels } from '../lib/adapters/mock.js'
import { createLibrary } from '../lib/core/lessons.js'
import { spec } from './helpers.mjs'

const task = { id: 't1', domain: 'code', prompt: 'fix the flaky test', index: 0 }

/** A mountable substrate whose runs differ per spec — the probe mechanism
 *  made visible: 'web' in keep ⇒ web_search shows up in the trace. */
const behaviorScript = (s, t) => {
  const keep = s.tools?.keep ?? []
  const steps = [{ seq: 1, kind: 'action', tool: 'fs_read', input: 'x.js' }]
  let text = 'base answer'
  if (keep.includes('web_search')) {
    steps.push({ seq: 2, kind: 'action', tool: 'web_search', input: 'flaky test cause' })
    steps.push({ seq: 3, kind: 'observation', text: 'found the race condition' })
    text = 'BETTER answer with web evidence'
  }
  if (keep.includes('fs_write')) {
    steps.push({ seq: 4, kind: 'action', tool: 'fs_write', input: 'fix.js' })
    text = 'BEST answer with web evidence and written fix'
  }
  return {
    runId: `run_${keep.join('_') || 'base'}_${steps.length}`,
    specHash: 'h_x',
    task: { id: t.id, domain: t.domain, prompt: t.prompt },
    steps,
    deliverable: { delivered: true, finalText: text, files: { 'fix.js': 'code' } },
    outcome: 'ok',
    stats: { steps: steps.length, toolCalls: keep.length, tokens: 100 + keep.length * 50, wallS: 1, costUsd: 0.01 },
  }
}

const improveProposal = { kind: 'domain', description: 'enable web search', patch: { tools: { keep: ['fs_read', 'web_search'] } } }
const judgePrefersBetter = (a, b) => (
  a.includes('BEST') ? 'A' : b.includes('BEST') ? 'B'
    : a.includes('BETTER') ? 'A' : b.includes('BETTER') ? 'B' : 'tie')
const lessonDraft = () => ({ cue: 'flaky test', lesson: 'search before editing', evidence: [{ runId: 'run_fs_read_web_search_3', seq: 2 }], confidence: 'high' })

test('full loop: propose → probe → compose → judge wins → auto-adopt on routed channel', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true }, script: behaviorScript })
  const channels = createScriptedChannels({
    proposals: [improveProposal],
    composed: { tools: { keep: ['fs_read', 'web_search', 'fs_write'] } },
    judge: judgePrefersBetter,
    lesson: () => null,
  })
  const r = await runImprovementStep({ task, baseSpec: spec(), substrate, channels })
  assert.equal(r.ok, true)
  assert.equal(r.improved, true)
  assert.equal(r.adoptedLabel, 'refined')
  assert.deepEqual(r.adoptedSpec.tools.keep, ['fs_read', 'web_search', 'fs_write'])
  // mount/run/dispose all happened: base + probe + refined = 3 rollouts
  assert.equal(substrate.journal.filter((j) => j.op === 'run').length, 3)
  assert.equal(substrate.journal.filter((j) => j.op === 'dispose').length, 3)
})

test('human gate required when no modelRouting: decline keeps base', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true }, script: behaviorScript })
  let asked = null
  const channels = createScriptedChannels({
    proposals: [improveProposal],
    composed: { tools: { keep: ['fs_read', 'web_search'] } },
    judge: judgePrefersBetter,
  })
  const r = await runImprovementStep({
    task, baseSpec: spec(), substrate, channels,
    gate: { confirm: (s) => { asked = s; return false } },
  })
  assert.equal(r.improved, false)
  assert.equal(r.adoptedLabel, 'base')
  assert.ok(asked && /refined|candidate/.test(asked.label))
  assert.match(asked.specDiff, /web_search/)
})

test('human gate: approval adopts the winner', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true }, script: behaviorScript })
  const channels = createScriptedChannels({
    proposals: [improveProposal], composed: { tools: { keep: ['fs_read', 'web_search'] } }, judge: judgePrefersBetter,
  })
  const r = await runImprovementStep({ task, baseSpec: spec(), substrate, channels, gate: { confirm: () => true } })
  assert.equal(r.improved, true)
})

test('no candidate outscoring base → keep base, improved=false', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true }, script: behaviorScript })
  const channels = createScriptedChannels({
    proposals: [{ kind: 'domain', description: 'worse', patch: { memory: 'noise' } }],
    composed: { memory: 'noise' },
    judge: () => 'tie',
  })
  const r = await runImprovementStep({ task, baseSpec: spec(), substrate, channels })
  assert.equal(r.improved, false)
  assert.equal(r.adoptedLabel, 'base')
})

test('pin violation rejects the proposal before any probe', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true }, script: behaviorScript })
  const channels = createScriptedChannels({
    proposals: [{ kind: 'invariant', description: 'grab persona', patch: { prompt: { persona: 'evil' } } }],
  })
  const r = await runImprovementStep({ task, baseSpec: spec(), substrate, channels, pins: ['prompt.persona'] })
  assert.equal(r.ok, true)
  assert.equal(r.improved, false)
  assert.ok(r.notes.some((n) => n.includes('pinned')))
  assert.equal(substrate.journal.filter((j) => j.op === 'run').length, 1) // base only
})

test('lesson admitted only when reflect cites real runIds+seqs', async () => {
  const library = createLibrary()
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true, structuredLog: true }, script: behaviorScript })
  const good = createScriptedChannels({
    proposals: [improveProposal], composed: { tools: { keep: ['fs_read', 'web_search'] } },
    judge: judgePrefersBetter, lesson: lessonDraft,
  })
  const r1 = await runImprovementStep({ task, baseSpec: spec(), substrate, channels: good, library })
  assert.ok(r1.lesson, 'expected admitted lesson')
  assert.equal(library.entries.length, 1)

  const library2 = createLibrary()
  const bad = createScriptedChannels({
    proposals: [improveProposal], composed: { tools: { keep: ['fs_read', 'web_search'] } },
    judge: judgePrefersBetter, lesson: () => ({ cue: 'c', lesson: 'l', evidence: [{ runId: 'ghost', seq: 1 }] }),
  })
  const r2 = await runImprovementStep({ task, baseSpec: spec(), substrate, channels: bad, library: library2 })
  assert.equal(r2.lesson, null)
  assert.equal(library2.entries.length, 0)
  assert.ok(r2.notes.some((n) => n.includes('lesson rejected')))
})

test('offline mode (no caps): no probes, base evidence required or supplied', async () => {
  const substrate = createMockSubstrate({ script: behaviorScript }) // all flags false
  const channels = createScriptedChannels({ proposals: [improveProposal] })
  const r1 = await runImprovementStep({ task, baseSpec: spec(), substrate, channels })
  assert.equal(r1.ok, false)
  assert.match(r1.notes[0], /offline mode needs a supplied baseEvidence/)

  const baseEvidence = behaviorScript(spec(), task)
  const r2 = await runImprovementStep({ task, baseSpec: spec(), substrate, channels, baseEvidence })
  assert.equal(r2.ok, true)
  assert.equal(r2.improved, false) // nothing can be adopted without probes
  assert.equal(substrate.journal.filter((j) => j.op === 'run').length, 0) // never mounted
  assert.equal(r2.trail.proposals[0].probe, 'skipped-offline')
})

test('lesson library feeds the next task in the same domain (prefix rule)', async () => {
  const library = createLibrary()
  library.add({ id: 'l1', domain: 'code', cue: 'c', lesson: 'l', refs: [], confidence: 'high', status: 'active', counts: { confirmed: 0, refuted: 0 }, lastValidated: 0 }, { taskIndex: 0 })
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true }, script: behaviorScript })
  let saw = null
  const channels = createScriptedChannels({ proposals: [] })
  channels.propose = async (ctx) => { saw = ctx.lessons; return [] }
  await runImprovementStep({ task: { ...task, index: 1 }, baseSpec: spec(), substrate, channels, library })
  assert.equal(saw.length, 1)
  assert.equal(saw[0].id, 'l1')
})

test('no propose channel → evidence-collection only, still ok', async () => {
  const substrate = createMockSubstrate({ capabilities: { isolatedMount: true }, script: behaviorScript })
  const r = await runImprovementStep({ task, baseSpec: spec(), substrate, channels: {} })
  assert.equal(r.ok, true)
  assert.equal(r.improved, false)
  assert.ok(r.notes.some((n) => n.includes('no propose channel')))
})
