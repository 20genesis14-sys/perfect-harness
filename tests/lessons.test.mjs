import { test } from 'node:test'
import assert from 'node:assert/strict'
import { admitLesson, createLibrary, libraryFromJSON, formatLessons } from '../lib/core/lessons.js'
import { normalizeEvidence } from '../lib/core/evidence.js'
import { ev } from './helpers.mjs'

const evA = normalizeEvidence(ev({ runId: 'run_a' }))
const lookup = (m) => (id) => m.get(id) ?? null
const runs = new Map([['run_a', evA]])

test('admitLesson accepts a draft whose every ref resolves', () => {
  const { ok, errors, entry } = admitLesson(
    { cue: 'web task', lesson: 'discover web_search first', evidence: [{ runId: 'run_a', seq: 1 }], domain: 'code' },
    { lookupRun: lookup(runs) },
  )
  assert.equal(ok, true, errors.join('; '))
  assert.equal(entry.status, 'active')
  assert.deepEqual(entry.refs, [{ runId: 'run_a', seq: 1 }])
  assert.deepEqual(entry.counts, { confirmed: 0, refuted: 0 })
})

test('admitLesson rejects empty fields and non-empty-only refs — the code check, not the prompt', () => {
  const f = (d) => admitLesson(d, { lookupRun: lookup(runs) })
  assert.equal(f({ cue: '', lesson: 'x', evidence: [{ runId: 'run_a', seq: 1 }] }).ok, false)
  assert.equal(f({ cue: 'x', lesson: '', evidence: [{ runId: 'run_a', seq: 1 }] }).ok, false)
  assert.equal(f({ cue: 'x', lesson: 'y', evidence: [] }).ok, false)
})

test('admitLesson rejects refs to runs or seqs that do not exist', () => {
  const ghost = admitLesson(
    { cue: 'c', lesson: 'l', evidence: [{ runId: 'nope', seq: 1 }] },
    { lookupRun: lookup(runs) },
  )
  assert.equal(ghost.ok, false)
  assert.match(ghost.errors[0], /not found/)

  const badSeq = admitLesson(
    { cue: 'c', lesson: 'l', evidence: [{ runId: 'run_a', seq: 99 }] },
    { lookupRun: lookup(runs) },
  )
  assert.equal(badSeq.ok, false)
  assert.match(badSeq.errors[0], /no step seq=99/)
})

test('seqRefs=false relaxes to runId-only resolution', () => {
  const { ok } = admitLesson(
    { cue: 'c', lesson: 'l', evidence: [{ runId: 'run_a' }] },
    { lookupRun: lookup(runs), seqRefs: false },
  )
  assert.equal(ok, true)
})

const entryOf = (domain, n = 0) => ({
  id: `e${n}_${domain}`, domain, cue: 'c', lesson: 'l',
  refs: [{ runId: 'run_a', seq: 1 }], confidence: 'medium',
  status: 'active', counts: { confirmed: 0, refuted: 0 }, lastValidated: 0,
})

test('library prefix rule: task i sees only earlier same-domain entries, never refuted', () => {
  const lib = createLibrary()
  lib.add(entryOf('code', 1), { taskIndex: 0 })
  lib.add(entryOf('legal', 2), { taskIndex: 0 })
  lib.add(entryOf('code', 3), { taskIndex: 1 })
  // taskIndex 1 in 'code' sees only the first code entry
  const seen = lib.selectFor({ domain: 'code', beforeTaskIndex: 1 })
  assert.deepEqual(seen.map((e) => e.id), ['e1_code'])
  // taskIndex 2 sees both code entries, not legal
  assert.deepEqual(lib.selectFor({ domain: 'code', beforeTaskIndex: 2 }).map((e) => e.id), ['e1_code', 'e3_code'])
  // refuted entry is excluded
  lib.recordOutcome('e1_code', 'refuted')
  assert.deepEqual(lib.selectFor({ domain: 'code', beforeTaskIndex: 2 }).map((e) => e.id), ['e3_code'])
})

test('recordOutcome: refuted flips status permanently; confirmed revives stale', () => {
  const lib = createLibrary()
  lib.add(entryOf('d', 1), { taskIndex: 0 })
  assert.equal(lib.recordOutcome('e1_d', 'confirmed', { now: 1000 }), true)
  assert.equal(lib.get('e1_d').lastValidated, 1000)
  lib.decay({ now: 1000 + 100, ttlMs: 50 })
  assert.equal(lib.get('e1_d').status, 'stale')
  lib.recordOutcome('e1_d', 'confirmed', { now: 2000 })
  assert.equal(lib.get('e1_d').status, 'active')
  lib.recordOutcome('e1_d', 'refuted')
  assert.equal(lib.get('e1_d').status, 'refuted')
  assert.equal(lib.recordOutcome('ghost', 'confirmed'), false)
  assert.throws(() => lib.recordOutcome('e1_d', 'meh'), /confirmed|refuted/)
})

test('toJSON/fromJSON round-trips and sanitizes status', () => {
  const lib = createLibrary()
  lib.add(entryOf('d', 1), { taskIndex: 3 })
  const back = libraryFromJSON(JSON.parse(JSON.stringify(lib.toJSON())))
  assert.equal(back.entries.length, 1)
  assert.equal(back.entries[0].taskIndex, 3)
  const dirty = libraryFromJSON({ entries: [{ id: 'x', status: 'bogus', counts: null }] })
  assert.equal(dirty.entries[0].status, 'active')
  assert.deepEqual(dirty.entries[0].counts, { confirmed: 0, refuted: 0 })
})

test('formatLessons renders cue/do/evidence lines', () => {
  const txt = formatLessons([entryOf('d', 1)])
  assert.match(txt, /WHEN: c/)
  assert.match(txt, /DO: l/)
  assert.match(txt, /run_a#1/)
  assert.match(formatLessons([]), /no lessons/)
})
