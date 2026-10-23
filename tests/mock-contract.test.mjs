import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMockSubstrate, createScriptedChannels } from '../lib/adapters/mock.js'
import { spec } from './helpers.mjs'

const task = { id: 't', domain: 'd', prompt: 'do work' }

test('mock defaults to ALL capabilities off — the worst-case host', () => {
  const caps = createMockSubstrate().capabilities()
  assert.deepEqual(Object.values(caps).every((v) => v === false), true)
})

test('mount→run→dispose lifecycle; run on disposed handle throws', async () => {
  const s = createMockSubstrate()
  const h = await s.mount(spec())
  const ev = await s.run(h, task)
  assert.equal(ev.task.id, 't')
  assert.equal(ev.outcome, 'ok')
  await s.dispose(h)
  await assert.rejects(() => s.run(h, task), /disposed/)
})

test('adapter contract: run() output is normalized Evidence — garbage in script is caught', async () => {
  const bad = createMockSubstrate({ script: () => ({ garbage: true }) })
  const h = await bad.mount(spec())
  await assert.rejects(() => bad.run(h, task), /runId/)
})

test('script sees the normalized spec — spec contents change behavior', async () => {
  const s = createMockSubstrate({
    script: (sp, t) => ({
      runId: 'r', specHash: 'h', task: { id: t.id, domain: t.domain, prompt: t.prompt },
      steps: [{ seq: 1, kind: 'action', tool: (sp.tools?.keep ?? [])[0] ?? 'none' }],
      deliverable: { delivered: true, finalText: '', files: {} },
      outcome: 'ok', stats: {},
    }),
  })
  const h = await s.mount({ tools: { keep: ['web_search'] } })
  const ev = await s.run(h, task)
  assert.equal(ev.steps[0].tool, 'web_search')
})

test('journal records mount/run/dispose — observable for tests', async () => {
  const s = createMockSubstrate()
  const h = await s.mount(spec())
  await s.run(h, task)
  await s.dispose(h)
  assert.deepEqual(s.journal.map((j) => j.op), ['mount', 'run', 'dispose'])
})

test('scripted channels: propose emits given proposals; reflect emits draft; judge honored', async () => {
  const ch = createScriptedChannels({
    proposals: [{ kind: 'domain', description: 'd', patch: { memory: 'x' } }],
    composed: { memory: 'y' },
    judge: () => 'A',
    lesson: { cue: 'c', lesson: 'l', evidence: [{ runId: 'r', seq: 1 }] },
  })
  const props = await ch.propose({})
  assert.equal(props.length, 1)
  assert.equal(props[0].patch.memory, 'x')
  assert.deepEqual(await ch.compose({}), { patch: { memory: 'y' } })
  assert.equal(await ch.select('a', 'b'), 'A')
  assert.deepEqual((await ch.reflect({})).cue, 'c')
  // defaults: no proposals, no compose, tie judge, no lesson
  const empty = createScriptedChannels()
  assert.deepEqual(await empty.propose({}), [])
  assert.equal(await empty.compose({}), null)
  assert.equal(await empty.select('a', 'b'), 'tie')
  assert.equal(await empty.reflect({}), null)
})
