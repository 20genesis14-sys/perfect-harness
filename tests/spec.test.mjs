import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSpec, specHash, patchPaths, applyPatch, diffSpecs, formatDiff, stableStringify,
  composeUnionDisjoint,
} from '../lib/core/spec.js'

test('normalizeSpec: empty spec is valid; unknown sections rejected', () => {
  assert.deepEqual(normalizeSpec({}), {})
  assert.deepEqual(normalizeSpec(undefined), {})
  assert.throws(() => normalizeSpec({ prompts: {} }), /unknown section/)
  assert.throws(() => normalizeSpec('x'), /must be an object/)
})

test('normalizeSpec validates field types per section', () => {
  assert.throws(() => normalizeSpec({ prompt: { systemAppend: 5 } }), /systemAppend/)
  assert.throws(() => normalizeSpec({ tools: { keep: 'fs_read' } }), /keep/)
  assert.throws(() => normalizeSpec({ tools: { keep: [1] } }), /keep/)
  assert.throws(() => normalizeSpec({ scripts: { a: {} } }), /scripts\.a/)
  assert.throws(() => normalizeSpec({ skills: { s: 'str' } }), /skills\.s/)
  assert.throws(() => normalizeSpec({ model: { effort: 3 } }), /effort/)
})

test('specHash is stable, content-based, and order-insensitive', () => {
  const a = { prompt: { systemAppend: 'x' }, tools: { keep: ['a'] } }
  const b = { tools: { keep: ['a'] }, prompt: { systemAppend: 'x' } }
  assert.equal(specHash(a), specHash(b))
  assert.notEqual(specHash(a), specHash({ prompt: { systemAppend: 'y' } }))
  assert.match(specHash(a), /^h_[0-9a-f]{8}$/)
})

test('applyPatch: absent inherits, present replaces, null deletes', () => {
  const base = normalizeSpec({
    prompt: { systemAppend: 'base', persona: 'p0' },
    tools: { keep: ['a', 'b'] },
    skills: { s1: { body: 'one' } },
    memory: 'mem',
  })
  const next = applyPatch(base, {
    prompt: { systemAppend: 'new' },          // replace field, persona inherited
    tools: { keep: ['c'] },                    // list replaces wholesale
    skills: { s1: null, s2: { body: 'two' } }, // delete + add
    memory: null,                              // delete section
  })
  assert.equal(next.prompt.systemAppend, 'new')
  assert.equal(next.prompt.persona, 'p0')
  assert.deepEqual(next.tools.keep, ['c'])
  assert.equal(next.skills.s1, undefined)
  assert.deepEqual(next.skills.s2, { body: 'two' })
  assert.equal(next.memory, undefined)
})

test('applyPatch: whole-section null deletes; model override merges', () => {
  const base = normalizeSpec({ model: { provider: 'ds', model: 'v3' } })
  assert.equal(applyPatch(base, { model: null }).model, undefined)
  assert.deepEqual(
    applyPatch(base, { model: { effort: 'high' } }).model,
    { provider: 'ds', model: 'v3', effort: 'high' },
  )
})

test('applyPatch: pins reject violations listing every offender', () => {
  const base = normalizeSpec({ prompt: { persona: 'admin' }, tools: { keep: ['a'] } })
  let err = null
  try {
    applyPatch(base, { prompt: { persona: 'x' }, tools: { keep: [] } }, { pins: ['prompt.persona', 'tools'] })
  } catch (e) { err = e }
  assert.ok(err)
  assert.match(err.message, /prompt\.persona/)
  assert.match(err.message, /tools\.keep/)
  // nested pin paths: pinning 'skills' covers 'skills.deploy'
  assert.throws(() =>
    applyPatch(base, { skills: { deploy: { body: 'x' } } }, { pins: ['skills'] }),
    /skills\.deploy/)
})

test('patchPaths enumerates leaf paths incl. map keys', () => {
  assert.deepEqual(
    patchPaths({ prompt: { persona: 'x', systemAppend: 'y' }, skills: { a: { body: 'b' } }, memory: null }).sort(),
    ['memory', 'prompt.persona', 'prompt.systemAppend', 'skills.a.body'],
  )
})

test('diffSpecs produces leaf-level added/removed/changed', () => {
  const a = normalizeSpec({ prompt: { systemAppend: 'x', persona: 'p' }, tools: { keep: ['a'] } })
  const b = normalizeSpec({ prompt: { systemAppend: 'y' }, tools: { keep: ['b'] }, memory: 'm' })
  const d = diffSpecs(a, b)
  const byPath = Object.fromEntries(d.map((x) => [x.path, x]))
  assert.equal(byPath['prompt.systemAppend'].op, 'changed')
  assert.equal(byPath['prompt.persona'].op, 'removed')
  assert.equal(byPath['tools.keep'].op, 'changed')
  assert.equal(byPath['memory'].op, 'added')
  assert.deepEqual(diffSpecs(a, a), [])
  const txt = formatDiff(d)
  assert.match(txt, /~ prompt\.systemAppend/)
  assert.match(txt, /- prompt\.persona/)
  assert.match(txt, /\+ memory/)
})

test('stableStringify: key order does not change output; array order does', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [2] } }), stableStringify({ a: { d: [2] }, b: 1 }))
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('composeUnionDisjoint: agreed leaves merge, absent-section removes conflict', () => {
  const base = { prompt: { guidance: 'neutral', persona: 'dev' }, tools: { keep: ['read'] } }
  const c1 = { prompt: { guidance: 'terse', persona: 'dev' }, tools: { keep: ['read', 'grep'] }, memory: 'm1' }
  const c2 = { prompt: { guidance: 'terse', persona: 'senior' }, tools: { hide: ['bash'] } }
  const { patch, adopted, conflicts } = composeUnionDisjoint(base, [c1, c2])
  // agreed: guidance='terse' (both), persona='senior' (c1 untouched = consent),
  // hide (only c2), memory (only c1)
  assert.equal(patch.prompt.guidance, 'terse')
  assert.equal(patch.prompt.persona, 'senior')
  assert.deepEqual(patch.tools.hide, ['bash'])
  assert.equal(patch.memory, 'm1')
  // REAL conflict: c2's absent tools section means keep is REMOVED there —
  // c1 changes it, c2 deletes it → stays on base, reported.
  assert.equal(patch.tools.keep, undefined)
  assert.deepEqual(conflicts, ['tools.keep'])
})

test('composeUnionDisjoint: real conflict stays off the patch', () => {
  const base = { prompt: { guidance: 'g0' } }
  const c1 = { prompt: { guidance: 'g1' } }
  const c2 = { prompt: { guidance: 'g2' } }
  const { patch, conflicts } = composeUnionDisjoint(base, [c1, c2])
  assert.deepEqual(patch, {})
  assert.deepEqual(conflicts, ['prompt.guidance'])
})

test('composeUnionDisjoint: pinned agreed leaf is refused + reported', () => {
  const base = { tools: { keep: ['read'] } }
  const c1 = { tools: { keep: ['read', 'bash'] } }
  const { patch, adopted, conflicts } = composeUnionDisjoint(base, [c1], { pins: ['tools.keep'] })
  assert.deepEqual(patch, {})
  assert.deepEqual(adopted, [])
  assert.match(conflicts[0], /pinned/)
})
