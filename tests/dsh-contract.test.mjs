// DSH adapter contract tests — the mocked ctx mirrors the real
// @deepseek-ai .d.ts shapes (dsh-agent AgentRegistry.create + AgentSetup,
// dsh-session snapshotEvents/'session/event', tools.restrict semantics).
// If DSH changes shape, update the adapter AND this mock.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshSubstrate } from '../lib/adapters/dsh/index.js'
import { planMount } from '../lib/adapters/dsh/spec-mount.js'
import { evidenceFromEvents } from '../lib/adapters/dsh/evidence.js'
import { runImprovementStep } from '../lib/core/loop.js'
import { createScriptedChannels } from '../lib/adapters/mock.js'
import { specHash, normalizeSpec } from '../lib/core/spec.js'

// ── mocked host ctx, mirroring .d.ts shapes ─────────────────────────────────

const TOOL_UNIVERSE = ['fs_read', 'fs_write', 'web_search', 'mc_discover']

function makeDshContext({ withAgents = true, scripted = null } = {}) {
  const listeners = new Map()
  const sessions = new Map()
  let seqCounter = 0

  const emit = (session, type, payload) => {
    const event = { sessionId: session.id, seq: seqCounter++, time: Date.now(), type, payload }
    session._events.push(event)
    for (const h of listeners.get('session/event') ?? []) h(session, event)
    return event
  }

  const makeSession = (id) => ({
    id,
    _events: [],
    snapshotEvents(fromSeq = 0) { return this._events.filter((e) => e.seq >= fromSeq) },
  })

  const makeAgent = (session, behavior) => ({
    session,
    sent: [],
    canceled: [],
    send(message, target, wakeup) {
      this.sent.push({ message, target, wakeup })
      const script = behavior ?? defaultScript
      script(session, emit)
    },
    whenIdle() { return this._idle ?? Promise.resolve() },
    cancel(cause) { this.canceled.push(cause) },
    _idle: null,
  })

  const defaultScript = (session, emitFn) => {
    emitFn(session, 'turn/start', { turn: 1 })
    emitFn(session, 'user/message', { message: { role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } } })
    emitFn(session, 'tool/call', { callId: 'c1', name: 'fs_read', arguments: { path: 'a.txt' } })
    emitFn(session, 'tool/result', { callId: 'c1', content: [{ type: 'text', text: 'file body' }] })
    emitFn(session, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'DONE-BASE' }] }, usage: { inputTokens: 100, outputTokens: 20 } })
    emitFn(session, 'turn/end', { reason: 'completed' })
  }

  const services = {
    sessions: { get: (id) => sessions.get(id) ?? null },
    tools: {
      schemas: () => TOOL_UNIVERSE.map((name) => ({ name })),
      register: () => {},
      restrict: (filter, ownerCtx) => {
        const list = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        if (!list.length) throw new Error('restrict: empty filter')
        for (const n of list) if (!TOOL_UNIVERSE.includes(n)) throw new Error(`restrict: unknown tool ${n}`)
        ;(ownerCtx._restricts ??= []).push(filter)
      },
    },
    systemPrompt: { section: () => {}, context: () => {} },
  }
  if (withAgents) {
    services.agents = {
      async create(options) {
        const session = makeSession(options.sessionId)
        sessions.set(session.id, session)
        const agent = makeAgent(session, scripted)
        const agentCtx = {
          _sections: [],
          _restricts: [],
          systemPrompt: {
            section: (s) => { agentCtx._sections.push(s) },
          },
          tools: {
            restrict: (filter) => services.tools.restrict(filter, agentCtx),
          },
        }
        if (options.setup) await options.setup(agentCtx, agent)
        session._agentCtx = agentCtx
        session._options = options
        return { agent, dispose: async () => { session._disposed = true } }
      },
    }
  }

  return {
    get: (name) => services[name],
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => listeners.set(event, listeners.get(event).filter((h) => h !== handler))
    },
    _sessions: sessions,
    _emit: emit,
    _makeSession: makeSession,
  }
}

// ── capabilities ─────────────────────────────────────────────────────────────

test('capabilities: full ctx + deps → all flags honest', () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({
    ctx,
    deps: { buildForkSeed: (e, b) => e.slice(0, b + 1), appendPluginRecord: () => 0, createUserMessage: (m) => ({ id: 'm1', role: 'user', ...m }) },
  })
  const flags = sub.capabilities()
  assert.equal(flags.isolatedMount, true)
  assert.equal(flags.seededFork, true)
  assert.equal(flags.modelRouting, true)
  assert.equal(flags.liveRestrict, true)
  assert.equal(flags.structuredLog, true)
  assert.equal(flags.logRecords, true)
  assert.equal(flags.userSignal, true)
})

test('capabilities: missing agents + no deps → honest degradation', () => {
  const ctx = makeDshContext({ withAgents: false })
  const sub = createDshSubstrate({ ctx, deps: {} })
  const flags = sub.capabilities()
  assert.equal(flags.isolatedMount, false)
  assert.equal(flags.seededFork, false)
  assert.equal(flags.modelRouting, false)
  assert.equal(flags.logRecords, false)
  assert.equal(flags.structuredLog, true) // sessions service still exists
  assert.ok(sub.notes().some((n) => n.includes('agents.create')))
})

// ── mount ────────────────────────────────────────────────────────────────────

test('mount: setup applies sections + restrict + agentOptions atomically', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const spec = {
    prompt: { persona: 'senior', guidance: 'be terse', systemAppend: 'extra' },
    tools: { keep: ['fs_read', 'web_search'], guidance: 'prefer reads' },
    model: { provider: 'openrouter', model: 'deepseek-v4', effort: 'high' },
    memory: 'remember: check locks',
  }
  const handle = await sub.mount(spec)
  const agentCtx = handle.agent.session._agentCtx
  const names = agentCtx._sections.map((s) => s.name)
  for (const n of ['ph:persona', 'ph:guidance', 'ph:system-append', 'ph:memory', 'ph:tool-guidance']) {
    assert.ok(names.includes(n), `missing section ${n}`)
  }
  assert.equal(agentCtx._sections.find((s) => s.name === 'ph:persona').order, 0)
  assert.deepEqual(agentCtx._restricts, [{ allow: ['fs_read', 'web_search'] }])
  assert.deepEqual(handle.agent.session._options.agentOptions, { provider: 'openrouter', model: 'deepseek-v4', reasoningEffort: 'high' })
  assert.equal(handle.specHash, specHash(spec))
  await sub.dispose(handle)
  assert.equal(handle.agent.session._disposed, true)
})

test('mount: unknown tool names filtered to notes, never passed to restrict', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ tools: { hide: ['web_search', 'no_such_tool'] } })
  const agentCtx = handle.agent.session._agentCtx
  assert.deepEqual(agentCtx._restricts, [{ deny: ['web_search'] }])
  assert.ok(handle.notes.some((n) => n.includes('no_such_tool')))
  await sub.dispose(handle)
})

test('mount: throws without agents.create seam', async () => {
  const sub = createDshSubstrate({ ctx: makeDshContext({ withAgents: false }) })
  await assert.rejects(() => sub.mount({}), /agents\.create/)
})

test('mount: seeded fork builds seed + marks meta + counts prefix', async () => {
  const ctx = makeDshContext()
  const forkCalls = []
  const sub = createDshSubstrate({
    ctx,
    deps: { buildForkSeed: (events, boundary) => { forkCalls.push(boundary); return events.slice(0, boundary + 1) } },
  })
  const prefix = [{ seq: 0 }, { seq: 1 }, { seq: 2 }]
  const handle = await sub.mount({}, { seed: { events: prefix, boundary: 2, parentSession: 'parent-1' } })
  assert.deepEqual(forkCalls, [2])
  assert.equal(handle.inheritedEventCount, 3)
  assert.equal(handle.agent.session._options.meta.isSeeded, true)
  assert.equal(handle.agent.session._options.meta.parentSession, 'parent-1')
  await sub.dispose(handle)
})

// ── plan purity ──────────────────────────────────────────────────────────────

test('planMount: pure spec → plan, keep−hide resolved, unmounted sections noted', () => {
  const plan = planMount(
    { tools: { keep: ['a', 'b'], hide: ['b', 'ghost'] }, skills: { web: {} }, prompt: { persona: 'p' } },
    { toolUniverse: ['a', 'b', 'c'] },
  )
  assert.deepEqual(plan.restrict, { allow: ['a'] })
  assert.deepEqual(plan.unmounted, ['skills'])
  assert.ok(plan.notes.some((n) => n.includes('ghost')))
  assert.equal(plan.sections.find((s) => s.name === 'ph:persona').text, 'p')
})

// ── run → evidence ───────────────────────────────────────────────────────────

test('run: events become normalized evidence with seqs, usage, outcome', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't1', domain: 'code', prompt: 'do the thing' })

  assert.equal(ev.runId, `dsh:${handle.sessionId}`)
  assert.equal(ev.specHash, handle.specHash)
  assert.equal(ev.outcome, 'ok')
  assert.equal(ev.deliverable.finalText, 'DONE-BASE')
  assert.equal(ev.deliverable.delivered, true)
  assert.equal(ev.stats.tokens, 120)
  assert.equal(ev.stats.toolCalls, 1)
  const kinds = ev.steps.map((s) => s.kind)
  assert.deepEqual(kinds, ['action', 'observation'])
  assert.equal(ev.steps[0].tool, 'fs_read')
  // seqs survive for lesson refs
  for (let i = 1; i < ev.steps.length; i++) assert.ok(ev.steps[i].seq > ev.steps[i - 1].seq)
  assert.equal(handle.agent.sent.length, 1)
  assert.equal(handle.agent.sent[0].target, 'next-turn')
  await sub.dispose(handle)
})

test('run: correction steps from second user message, injections skipped', async () => {
  const scripted = (session, emit) => {
    emit(session, 'user/message', { message: { content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } } })
    emit(session, 'user/message', { message: { content: [{ type: 'text', text: 'injected ctx' }], source: { kind: 'runtime-context' } } })
    emit(session, 'user/message', { message: { content: [{ type: 'text', text: 'wait, not that' }], source: { kind: 'user' } } })
    emit(session, 'assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } })
    emit(session, 'turn/end', { reason: 'completed' })
  }
  const sub = createDshSubstrate({ ctx: makeDshContext({ scripted }) })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })
  const corr = ev.steps.filter((s) => s.kind === 'correction')
  assert.equal(corr.length, 1)
  assert.match(corr[0].text, /wait, not that/)
  await sub.dispose(handle)
})

test('run: timeout → cancel + outcome timeout', async () => {
  const ctx = makeDshContext({
    scripted: (session, emit) => { emit(session, 'turn/start', { turn: 1 }) },
  })
  const sub = createDshSubstrate({ ctx, opts: { wallMs: 30 } })
  const handle = await sub.mount({})
  // agent never goes idle
  handle.agent._idle = new Promise(() => {})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.outcome, 'timeout')
  assert.deepEqual(handle.agent.canceled, [{ kind: 'user' }])
  await sub.dispose(handle)
})

// ── end-to-end: the same improvement loop runs on the DSH seam ───────────────

test('full improvement loop over DSH substrate (routed selector → auto gate)', async () => {
  // Spec depth → better scripted answer: persona alone beats base; the
  // composed spec (persona + guidance) beats both. Distinct texts keep the
  // blind judge consistent — identical artifacts would honestly split.
  const ctx = makeDshContext({
    scripted: (session, emit) => {
      const names = session._agentCtx._sections.map((s) => s.name)
      const answer = names.includes('ph:persona') && names.includes('ph:guidance')
        ? 'DONE-COMPOSED'
        : names.includes('ph:persona') ? 'DONE-BETTER' : 'DONE-BASE'
      emit(session, 'tool/call', { callId: 'c1', name: 'fs_read', arguments: { path: 'x' } })
      emit(session, 'tool/result', { callId: 'c1', content: [{ type: 'text', text: 'body' }] })
      emit(session, 'assistant/message', { message: { content: [{ type: 'text', text: answer }] }, usage: { inputTokens: 50, outputTokens: 10 } })
      emit(session, 'turn/end', { reason: 'completed' })
    },
  })
  const sub = createDshSubstrate({ ctx })
  const rank = (t) => (t.includes('DONE-COMPOSED') ? 3 : t.includes('DONE-BETTER') ? 2 : t.includes('DONE-BASE') ? 1 : 0)
  const channels = createScriptedChannels({
    proposals: [{ kind: 'invariant', description: 'add persona', patch: { prompt: { persona: 'senior' } } }],
    composed: { prompt: { persona: 'senior', guidance: 'terse' } },
    judge: (a, b) => (rank(a) > rank(b) ? 'A' : rank(a) < rank(b) ? 'B' : 'tie'),
    lesson: null,
  })
  const result = await runImprovementStep({
    task: { id: 't1', domain: 'code', prompt: 'produce the artifact' },
    baseSpec: normalizeSpec({}),
    substrate: sub,
    channels,
    caps: sub.capabilities(), // modelRouting true → auto-allowed gate
  })
  assert.equal(result.ok, true)
  assert.equal(result.improved, true)
  assert.equal(result.mode.selectorChannel, 'routed')
  assert.equal(result.adoptedSpec.prompt.persona, 'senior')
  assert.equal(result.adoptedSpec.prompt.guidance, 'terse')
  // every rollout produced real DSH evidence with session-backed runIds
  assert.ok(result.trail.evidences.every((e) => e.evidence.runId.startsWith('dsh:ph-probe-')))
})
