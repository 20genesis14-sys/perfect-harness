// Campaign tests — spec carry-forward, lesson accumulation, crash survival.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runCampaign } from '../lib/core/campaign.js'
import { createMockSubstrate, createScriptedChannels } from '../lib/adapters/mock.js'
import { createLibrary } from '../lib/core/lessons.js'

const CAPS = {
  isolatedMount: true, seededFork: true, modelRouting: true,
  liveRestrict: true, structuredLog: true, logRecords: true, userSignal: true,
}

const mkTask = (i, domain = 'd') => ({ id: `t${i}`, domain, prompt: `task ${i}` })

test('runCampaign: adopted spec becomes the next task base (carry-forward)', async () => {
  // Deliverable differs BY SPEC: 'X'-guidance harnesses produce 'DONE-X' —
  // the judge can prefer content consistently (position-swap then confirms
  // the preference is real, not positional).
  const substrate = createMockSubstrate({
    script: (spec, task) => ({
      runId: `m_${spec.prompt?.guidance === 'X' ? 'x' : 'b'}_${Math.random().toString(36).slice(2, 8)}`,
      specHash: 'h',
      task: { id: task.id, domain: task.domain ?? '_', prompt: task.prompt },
      steps: [{ seq: 0, kind: 'action', tool: 'echo', input: 'p' }],
      deliverable: { delivered: true, finalText: spec.prompt?.guidance === 'X' ? 'DONE-X' : 'DONE-base', files: {} },
      outcome: 'ok',
      stats: { steps: 1, toolCalls: 1, tokens: 10, wallS: 0.01, costUsd: 0 },
    }),
  })
  const channels = createScriptedChannels({
    proposals: [{ description: 'add guidance X', patch: { prompt: { guidance: 'X' } } }],
    judge: (a, b) => (a.includes('DONE-X') && !b.includes('DONE-X')) ? 'A'
      : (b.includes('DONE-X') && !a.includes('DONE-X')) ? 'B' : 'tie',
    lesson: () => null,
  })
  const library = createLibrary()
  const out = await runCampaign({
    tasks: [mkTask(0), mkTask(1), mkTask(2)],
    baseSpec: { prompt: { guidance: 'base' } },
    substrate, channels, caps: CAPS, library,
    gate: { confirm: async () => true },
  })
  assert.equal(out.ok, true)
  assert.equal(out.tasks.length, 3)
  // step0 adopts 'X'; steps 1-2 propose the same patch → spec already
  // carries it → no diff → base kept (carry-forward proven by finalSpec).
  assert.equal(out.finalSpec.prompt.guidance, 'X')
  assert.equal(out.metrics.improved, 1)
  assert.equal(out.metrics.baseKept, 2)
  assert.ok(out.tasks.every((s) => s.evidences >= 2), JSON.stringify(out.tasks.map((t) => t.evidences)))
})

test('runCampaign: base kept → spec unchanged for next task', async () => {
  const substrate = createMockSubstrate({ respond: 'SAME' })
  const channels = createScriptedChannels({
    proposals: [{ description: 'noop', patch: {} }],
    judge: () => 'tie',
  })
  const base = { prompt: { guidance: 'keepme' } }
  const out = await runCampaign({ tasks: [mkTask(0), mkTask(1)], baseSpec: base, substrate, channels, caps: CAPS })
  assert.equal(out.finalSpec.prompt.guidance, 'keepme')
  assert.equal(out.metrics.improved, 0)
  assert.equal(out.metrics.baseKept, 2)
})

test('runCampaign: a crashing step is recorded and the campaign continues', async () => {
  const inner = createMockSubstrate({ respond: 'OK' })
  let mounts = 0
  const substrate = {
    ...inner,
    async mount(spec) { mounts++; if (mounts === 1) throw new Error('mount boom'); return inner.mount(spec) },
  }
  const channels = {
    async propose() { return [{ description: 'd', patch: { prompt: { guidance: 'G' } } }] },
    async select() { return 'B' },
  }
  const out = await runCampaign({
    tasks: [mkTask(0), mkTask(1)], baseSpec: {}, substrate, channels, caps: CAPS,
    gate: { confirm: async () => true },
  })
  assert.equal(out.ok, true)
  assert.equal(out.tasks.length, 2)
  assert.equal(out.tasks[0].ok, false)                       // crashed step recorded
  assert.ok(out.tasks[0].notes[0].includes('mount boom'))    // crash surfaced in notes
  assert.equal(out.tasks[1].ok, true)                        // campaign continued
})

test('runCampaign: prefix rule — task i sees only earlier-domain lessons', async () => {
  const seen = []
  const substrate = createMockSubstrate({ respond: 'OK' })
  const channels = {
    async propose(ctx) { seen.push((ctx.lessons ?? []).length); return [] },
    async select() { return 'tie' },
  }
  const library = createLibrary()
  library.add({ id: 'L0', domain: 'dom-a', cue: 'c', lesson: 'l', refs: [], confidence: 'medium', status: 'active', counts: { confirmed: 0, refuted: 0 } }, { taskIndex: 0 })
  await runCampaign({
    tasks: [mkTask(0, 'dom-a'), mkTask(1, 'dom-b'), mkTask(2, 'dom-a')],
    baseSpec: {}, substrate, channels, caps: CAPS,
    library,
  })
  // task0 dom-a@index0: L0.taskIndex 0 !< 0 → 0 served
  // task1 dom-b: wrong domain → 0
  // task2 dom-a@index2: L0.taskIndex 0 < 2 → 1 served
  assert.deepEqual(seen, [0, 0, 1])
})
