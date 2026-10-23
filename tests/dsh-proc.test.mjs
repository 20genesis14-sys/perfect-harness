// Contract tests for the external-process substrate — real NDJSON stream
// shapes captured live from `dsh headless --json`, plus patch generation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createDshProcSubstrate, evidenceFromNdjson } from '../lib/adapters/dsh/proc.js'

// Real stream captured from a tool-using headless run (verbatim shapes).
const REAL_STREAM = [
  { type: 'session', sessionId: 'session-bf9d0ac8-93e9-45a7-9800-4027f7b8ee61', cwd: 'D:\\w' },
  { type: 'status', phase: 'turn_start', turn: 1 },
  { type: 'status', phase: 'step_start', turn: 1, step: 1 },
  { type: 'tool_call', callId: 'call_d699', tool: 'read', input: { file_path: 'D:\\f\\probe-input.txt' } },
  { type: 'tool_result', callId: 'call_d699', status: 'completed', result: '<content>\n1: BANANA\n</content>' },
  { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 1357, outputTokens: 52, totalTokens: 7169, cacheReadTokens: 5760 } },
  { type: 'status', phase: 'step_start', turn: 1, step: 2 },
  { type: 'text', text: 'BANANA' },
  { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 2152, outputTokens: 5, totalTokens: 7277, cacheReadTokens: 5120 } },
  { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
  { type: 'final', text: 'BANANA' },
].map(JSON.stringify).join('\n')

test('evidenceFromNdjson: real stream → canonical evidence', () => {
  const ev = evidenceFromNdjson(REAL_STREAM, { taskId: 't1', domain: 'exact-output', prompt: 'read then echo', wallS: 4.2 })
  assert.equal(ev.runId, 'dshproc:session-bf9d0ac8-93e9-45a7-9800-4027f7b8ee61')
  assert.equal(ev.outcome, 'ok')
  assert.equal(ev.steps.length, 2)
  assert.deepEqual(ev.steps.map((s) => s.kind), ['action', 'observation'])
  assert.equal(ev.steps[0].tool, 'read')
  assert.equal(ev.steps[0].seq, 0)
  assert.ok(ev.steps[0].input.includes('probe-input.txt'))
  assert.ok(ev.steps[1].text.includes('BANANA'))
  assert.equal(ev.deliverable.delivered, true)
  assert.equal(ev.deliverable.finalText, 'BANANA')
  assert.equal(ev.stats.tokens, 7277) // last cumulative usage, not summed
  assert.equal(ev.stats.toolCalls, 1)
  assert.equal(ev.stats.wallS, 4)
})

test('evidenceFromNdjson: priced route → costUsd from the LAST cumulative split', () => {
  const ev = evidenceFromNdjson(REAL_STREAM, {
    taskId: 't', domain: 'd', prompt: 'p',
    pricing: { input: 1, output: 10, cacheRead: 0.001 }, // $/Mtok, test rates
  })
  // last usage record: in 2152, out 5, cacheRead 5120
  const want = (2152 / 1e6) * 1 + (5 / 1e6) * 10 + (5120 / 1e6) * 0.001
  assert.equal(ev.stats.costUsd, +want.toFixed(8))
  const unpriced = evidenceFromNdjson(REAL_STREAM, { taskId: 't', domain: 'd', prompt: 'p' })
  assert.equal(unpriced.stats.costUsd, 0)
})

test('evidenceFromNdjson: aborted turn → aborted outcome; error status → error step', () => {
  const stream = [
    { type: 'session', sessionId: 's1' },
    { type: 'tool_call', callId: 'c1', tool: 'bash', input: { cmd: 'x' } },
    { type: 'tool_result', callId: 'c1', status: 'error', result: 'denied' },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'aborted' } },
  ].map(JSON.stringify).join('\n')
  const ev = evidenceFromNdjson(stream, { taskId: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.outcome, 'aborted')
  assert.equal(ev.steps[1].kind, 'error')
  assert.equal(ev.deliverable.delivered, false)
})

test('evidenceFromNdjson: final without turn_end still delivers (degraded)', () => {
  const stream = [
    { type: 'session', sessionId: 's2' },
    { type: 'final', text: 'PARTIAL' },
  ].map(JSON.stringify).join('\n')
  const ev = evidenceFromNdjson(stream, { taskId: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.outcome, 'ok')
  assert.equal(ev.deliverable.finalText, 'PARTIAL')
})

test('evidenceFromNdjson: non-JSON noise lines skipped', () => {
  const stream = 'CreateFile: warning text\n' + JSON.stringify({ type: 'final', text: 'OK' })
  const ev = evidenceFromNdjson(stream, { taskId: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.deliverable.finalText, 'OK')
})

/** Fake spawnImpl: emits REAL_STREAM and captures argv. */
const fakeSpawn = (capture) => () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => {
    child.stdout.emit('data', REAL_STREAM)
    child.emit('close', 0)
  })
  return child
}

test('proc mount: spec → generated patch rows (model/sections/scripts)', async () => {
  const sub = createDshProcSubstrate({
    exe: 'EXE', cli: 'CLI', basePatches: ['base.patch.yml'],
    workdir: 'W', deps: { spawnImpl: fakeSpawn() },
  })
  const h = await sub.mount({
    model: { provider: 'openrouter', model: 'm/m-1', effort: 'high' },
    prompt: { guidance: 'be exact' },
    skills: { 'skill-x': { name: '@v/x' } },
    scripts: { 'my-script': 'export const name="s"\nexport function apply(){}' },
  })
  assert.ok(existsSync(h.patchPath), 'patch file written')
  const yml = readFileSync(h.patchPath, 'utf8')
  assert.ok(yml.includes('agent-default-model'), 'route row')
  assert.ok(yml.includes('reasoningEffort: high'), 'effort mapped')
  assert.ok(yml.includes('ph-spec-sections'), 'sections plugin row')
  assert.ok(yml.includes('skill-x'), 'skill row')
  assert.ok(yml.includes('./my-script.mjs'), 'script sibling row')
  assert.ok(existsSync(join(h.dir, 'ph-sections.mjs')))
  assert.ok(existsSync(join(h.dir, 'my-script.mjs')))
  const sections = readFileSync(join(h.dir, 'ph-sections.mjs'), 'utf8')
  assert.ok(sections.includes('be exact'))
  assert.ok(h.notes.every((n) => !n.includes('failed')), JSON.stringify(h.notes))
})

test('proc mount: tools.keep degrades to an honest note (no per-request restrict)', async () => {
  const sub = createDshProcSubstrate({ exe: 'E', cli: 'C', deps: { spawnImpl: fakeSpawn() } })
  const h = await sub.mount({ tools: { keep: ['read'] } })
  assert.ok(h.notes.some((n) => n.includes('keep')), 'honest note emitted')
  const yml = readFileSync(h.patchPath, 'utf8')
  assert.ok(!yml.includes('restrict'), 'no restrict attempt in patch')
})

test('proc run: spawns headless --json with both patches; evidence maps', async () => {
  const argv = []
  const sub = createDshProcSubstrate({
    exe: 'EXE', cli: 'CLI', basePatches: ['base.patch.yml'],
    deps: {
      spawnImpl: (exe, args, options) => {
        argv.push(...args)
        const child = new EventEmitter()
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        queueMicrotask(() => { child.stdout.emit('data', REAL_STREAM); child.emit('close', 0) })
        return child
      },
    },
  })
  const h = await sub.mount({ model: { provider: 'p', model: 'm' } })
  const ev = await sub.run(h, { id: 't', domain: 'd', prompt: 'do it' })
  assert.ok(argv.includes('headless'))
  assert.ok(argv.includes('--json'))
  assert.deepEqual(argv.filter((a) => a === '--patch').length, 2, 'base + generated patch')
  assert.equal(ev.outcome, 'ok')
  await sub.dispose(h)
  assert.ok(!existsSync(h.dir), 'temp dir cleaned')
})

test('proc capabilities: honest flags (no seededFork/liveRestrict/userSignal)', () => {
  const sub = createDshProcSubstrate({ exe: 'E', cli: 'C' })
  const c = sub.capabilities()
  assert.equal(c.isolatedMount, true)
  assert.equal(c.modelRouting, true)
  assert.equal(c.structuredLog, true)
  assert.equal(c.seededFork, false)
  assert.equal(c.liveRestrict, false)
  assert.equal(c.userSignal, false)
  assert.equal(c.logRecords, false)
})
