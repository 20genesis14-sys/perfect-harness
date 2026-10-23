import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeEvidence, findVerdictLeaks, taskLeakTokens,
  formatTrajectory, formatDeliverable, contrastEvidences, formatContrast,
} from '../lib/core/evidence.js'
import { ev } from './helpers.mjs'

test('normalizeEvidence accepts a valid object and fills stats defaults', () => {
  const e = normalizeEvidence(ev({ stats: {} }))
  assert.equal(e.stats.steps, 2) // falls back to steps.length
  assert.equal(e.stats.tokens, 0)
  assert.equal(e.deliverable.delivered, true)
})

test('rejects non-object / missing required fields', () => {
  assert.throws(() => normalizeEvidence(null), /must be an object/)
  assert.throws(() => normalizeEvidence(ev({ runId: '' })), /runId/)
  assert.throws(() => normalizeEvidence(ev({ specHash: '' })), /specHash/)
  assert.throws(() => normalizeEvidence(ev({ task: { id: '', domain: 'd', prompt: 'p' } })), /task\.id/)
  assert.throws(() => normalizeEvidence(ev({ task: { id: 't', domain: '', prompt: 'p' } })), /domain/)
  assert.throws(() => normalizeEvidence(ev({ task: { id: 't', domain: 'd', prompt: ' ' } })), /prompt/)
})

test('rejects non-increasing or non-unique seqs', () => {
  assert.throws(() => normalizeEvidence(ev({
    steps: [{ seq: 2, kind: 'action' }, { seq: 2, kind: 'observation' }],
  })), /strictly increasing/)
  assert.throws(() => normalizeEvidence(ev({
    steps: [{ seq: 3, kind: 'action' }, { seq: 1, kind: 'observation' }],
  })), /strictly increasing/)
  assert.throws(() => normalizeEvidence(ev({
    steps: [{ seq: 0, kind: 'action' }],
  })), /seq must be an integer >= 1/)
})

test('rejects unknown step kinds and non-string fields', () => {
  assert.throws(() => normalizeEvidence(ev({ steps: [{ seq: 1, kind: 'verdict' }] })), /kind/)
  assert.throws(() => normalizeEvidence(ev({ steps: [{ seq: 1, kind: 'action', text: 5 }] })), /text/)
})

test('verdict fields are rejected anywhere in the tree — including nested', () => {
  assert.throws(() => normalizeEvidence(ev({ score: 0.9 })), /verdict fields/)
  assert.throws(() => normalizeEvidence(ev({ deliverable: { delivered: true, rubric: 'x' } })), /verdict fields/)
  assert.throws(() => normalizeEvidence(ev({ steps: [{ seq: 1, kind: 'observation', meta: { passed: true } }] })), /verdict fields/)
  assert.deepEqual(findVerdictLeaks({ a: { b: [{ grade: 1 }] } }), ['$.a.b[0].grade'])
})

test('rejects bad outcome and bad files', () => {
  assert.throws(() => normalizeEvidence(ev({ outcome: 'success' })), /outcome/)
  assert.throws(() => normalizeEvidence(ev({ deliverable: { delivered: true, files: { 'a.md': 42 } } })), /files/)
})

test('taskLeakTokens flags measurement words in the prompt', () => {
  assert.deepEqual(taskLeakTokens(normalizeEvidence(ev({ task: { id: 't', domain: 'd', prompt: 'score the rubric' } }))), ['rubric', 'score'])
  assert.deepEqual(taskLeakTokens(normalizeEvidence(ev())), [])
})

test('formatTrajectory renders the shared grammar deterministically', () => {
  const t = formatTrajectory(normalizeEvidence(ev()))
  assert.match(t, /\[TASK\] fix the bug/)
  assert.match(t, /\[ACTION #1\] tool=fs_read input=a\.js/)
  assert.match(t, /\[OBS #2\] file contents/)
  assert.match(t, /\[DELIVERED\]/)
  assert.match(t, /\[OUTCOME\] ok steps=2 tools=1 tokens=100 wall=1s cost=\$0\.001/)
})

test('formatTrajectory clips long observation text', () => {
  const big = 'x'.repeat(200)
  const t = formatTrajectory(normalizeEvidence(ev({
    steps: [{ seq: 1, kind: 'observation', text: big }],
  })), { obsTrunc: 50 })
  assert.match(t, /truncated]/)
  assert.ok(t.length < 200)
})

test('formatDeliverable concatenates final text and files, hides provenance', () => {
  const s = formatDeliverable(normalizeEvidence(ev({
    deliverable: { delivered: true, finalText: 'answer', files: { 'a.md': 'content' } },
  })))
  assert.match(s, /answer/)
  assert.match(s, /--- a\.md ---\ncontent/)
  assert.doesNotMatch(s, /r_\d|h_base|specHash/)
})

test('contrastEvidences reports behavioral deltas, not scores', () => {
  const a = normalizeEvidence(ev({ runId: 'a' }))
  const b = normalizeEvidence(ev({
    runId: 'b',
    steps: [
      { seq: 1, kind: 'action', tool: 'fs_read' },
      { seq: 2, kind: 'action', tool: 'web_search' },
      { seq: 3, kind: 'error', tool: 'web_search', text: 'timeout' },
      { seq: 4, kind: 'correction', text: 'user stopped it' },
    ],
    stats: { steps: 4, toolCalls: 2, tokens: 250, wallS: 3, costUsd: 0.004 },
  }))
  const c = contrastEvidences(a, b)
  assert.deepEqual(c.toolsOnlyB, ['web_search×1'])
  assert.deepEqual(c.errors, { a: 0, b: 1 })
  assert.deepEqual(c.corrections, { a: 0, b: 1 })
  assert.equal(c.statsDelta.tokens, 150)
  const txt = formatContrast(c)
  assert.match(txt, /\+tools in B: web_search×1/)
  assert.match(txt, /errors 0→1/)
})
