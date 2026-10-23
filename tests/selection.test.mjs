import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectAdoption } from '../lib/core/selection.js'

const mk = (labels) => labels.map((label) => ({ label, text: `deliverable of ${label}` }))

test('requires base + at least one candidate — trivial adoption banned', async () => {
  await assert.rejects(() => selectAdoption({ entries: mk(['base']), judge: () => 'A' }), /trivial adoption/)
})

test('no judge → keep base, confidence none', async () => {
  const r = await selectAdoption({ entries: mk(['base', 'c0']), judge: undefined })
  assert.equal(r.adoptIndex, -1)
  assert.equal(r.confidence, 'none')
  assert.match(r.reason, /human/)
})

test('consistent winner over base is adopted with high confidence', async () => {
  // judge prefers whatever text contains 'better'
  const judge = (a, b) => (a.includes('better') ? 'A' : b.includes('better') ? 'B' : 'tie')
  const r = await selectAdoption({
    entries: [
      { label: 'base', text: 'plain' },
      { label: 'c0', text: 'better work' },
    ],
    judge,
  })
  assert.equal(r.adoptIndex, 1)
  assert.equal(r.confidence, 'high')
  assert.match(r.reason, /c0 wins/)
})

test('base never loses by default: ties keep base', async () => {
  const r = await selectAdoption({
    entries: mk(['base', 'c0', 'c1']),
    judge: () => 'tie',
  })
  assert.equal(r.adoptIndex, -1)
  assert.match(r.reason, /no candidate outscored the base/)
})

test('position-dependent judge produces split verdicts and inconsistent confidence', async () => {
  const biased = (a, b) => 'A' // always prefers first seat = pure order bias
  const r = await selectAdoption({ entries: mk(['base', 'c0']), judge: biased })
  assert.equal(r.pairs[0].result, 'split')
  assert.equal(r.confidence, 'inconsistent')
  // split gives both 0.5 → no strict winner over base → keep base
  assert.equal(r.adoptIndex, -1)
})

test('sync judges are awaited the same as async ones', async () => {
  const r = await selectAdoption({
    entries: [{ label: 'base', text: 'x' }, { label: 'c0', text: 'y' }],
    judge: (a, b) => (a === 'y' || b === 'y' ? (a === 'y' ? 'A' : 'B') : 'tie'),
  })
  assert.equal(r.adoptIndex, 1)
})
