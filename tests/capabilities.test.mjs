import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCapabilities, supports, FEATURE_REQUIRES, CAPABILITY_FLAGS } from '../lib/core/capabilities.js'

const allOff = () => ({})

test('zero flags → minimal mode: offline probes, human gate, honest line', () => {
  const { flags, mode, lines } = resolveCapabilities(allOff())
  for (const f of CAPABILITY_FLAGS) assert.equal(flags[f], false)
  assert.equal(mode.probes, 'offline')
  assert.equal(mode.selectorChannel, 'fresh')
  assert.equal(mode.adoptionGate, 'human-required')
  assert.equal(mode.refs, 'runId')
  assert.equal(mode.corrections, 'manual')
  assert.ok(lines.some((l) => l.includes('minimal mode')))
})

test('isolatedMount alone → rerun probes; +seededFork → fork', () => {
  assert.equal(resolveCapabilities({ isolatedMount: true }).mode.probes, 'rerun')
  assert.equal(resolveCapabilities({ isolatedMount: true, seededFork: true }).mode.probes, 'fork')
  // seededFork without mount still can't probe
  assert.equal(resolveCapabilities({ seededFork: true }).mode.probes, 'offline')
})

test('modelRouting flips selector channel AND loosens the gate', () => {
  const on = resolveCapabilities({ modelRouting: true })
  assert.equal(on.mode.selectorChannel, 'routed')
  assert.equal(on.mode.adoptionGate, 'auto-allowed')
  const off = resolveCapabilities({})
  assert.equal(off.mode.adoptionGate, 'human-required')
})

test('remaining flags map to their documented degradations', () => {
  const r = resolveCapabilities({ structuredLog: true, logRecords: true, userSignal: true, liveRestrict: true })
  assert.equal(r.mode.refs, 'seq')
  assert.equal(r.mode.lessonStore, 'log')
  assert.equal(r.mode.corrections, 'auto')
  assert.equal(r.mode.toolPolicy, 'live')
})

test('supports() checks feature requirements against resolved flags', () => {
  const r = resolveCapabilities({ isolatedMount: true, seededFork: true })
  assert.equal(supports(r, 'forkProbes'), true)
  assert.equal(supports(r, 'routedSelector'), false)
  assert.equal(supports({}, 'liveProbes'), false)
  assert.equal(supports(r, 'nonexistent'), false)
  assert.ok(FEATURE_REQUIRES.forkProbes.includes('seededFork'))
})
