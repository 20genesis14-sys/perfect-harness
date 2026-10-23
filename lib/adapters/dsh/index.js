// DSH substrate — the live adapter. Implements the core substrate contract:
//   capabilities() → flag map        mount(spec) → handle
//   run(handle, task) → Evidence     dispose(handle)
//
// Everything here may touch the host ctx; nothing here makes a product
// decision (that stays in core/). The adapter is honest about its seams:
// missing agents.create → mount throws; missing session log → run falls
// back to listener-collected events; missing optional deps → flags off.
//
// Mount path (verified against dsh-agent index.d.ts):
//   agents.create({sessionId, meta, agentOptions, seed?, setup}) →
//   {agent, dispose()} — the setup callback runs BEFORE session/created,
//   agent/created, and the first prompt assembly, so every section and
//   restrict lands in the agent's scoped world atomically.
//
// Run path:
//   send(userMessage, 'next-turn', true) → whenIdle() (raced with a wall
//   clock) → evidence from session.snapshotEvents(firstLiveSeq) — the
//   committed log is authoritative; the live 'session/event' listener is
//   the fallback for hosts whose snapshot seam is absent.

import { randomUUID } from 'node:crypto'
import { normalizeEvidence } from '../../core/evidence.js'
import { normalizeSpec, specHash } from '../../core/spec.js'
import { planMount, describePlan, mergePresetRows } from './spec-mount.js'
import { evidenceFromEvents } from './evidence.js'
import { probeSeams } from './seams.js'

const fn = (v) => typeof v === 'function'
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const DEFAULT_WALL_MS = 180_000

const makeUserMessage = (deps, text) => {
  const content = [{ type: 'text', text }]
  if (fn(deps.createUserMessage)) return deps.createUserMessage({ content, source: { kind: 'user' } })
  return { id: `ph-msg-${randomUUID()}`, role: 'user', content, source: { kind: 'user' } }
}

/**
 * @param {object} args
 * @param {object} args.ctx host Cordis ctx (or test double)
 * @param {object} [args.deps] injectable host functions:
 *   buildForkSeed, appendPluginRecord, createUserMessage, installModelSelection
 * @param {object} [args.opts] {cwd, wallMs, parentAgent}
 * @returns {object} substrate for core/loop.js
 */
export function createDshSubstrate({ ctx, deps = {}, opts = {} } = {}) {
  if (!isObj(ctx)) throw new Error('createDshSubstrate needs a host ctx')
  const probe = probeSeams(ctx, deps)
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS
  /** Presets this substrate mounted — id → disposer (register throws on dup). */
  const ownedPresets = new Map()
  let presetCounter = 0

  const toolUniverse = () => {
    try {
      const svc = probe.services.tools ?? ctx.tools
      const schemas = svc && fn(svc.schemas) ? svc.schemas() : []
      return Array.isArray(schemas) ? schemas.map((t) => t && t.name).filter(Boolean) : []
    } catch { return [] }
  }

  const capabilities = () => ({ ...probe.flags })

  /**
   * @param {object} spec normalized (or raw — normalized here) harness spec
   * @param {object} [mountOpts] {sessionId, cwd, parentAgent, agentPreset,
   *   seed:{events, boundary} — fork prefix from a prior session}
   */
  const mount = async (spec, mountOpts = {}) => {
    if (!probe.flags.isolatedMount) {
      throw new Error('agents.create seam unavailable — cannot mount an isolated probe agent')
    }
    const normalized = normalizeSpec(spec)
    const plan = planMount(normalized, { toolUniverse: toolUniverse() })
    const sessionId = mountOpts.sessionId ?? `ph-probe-${randomUUID()}`
    const applyNotes = [...plan.notes]

    const options = { sessionId, meta: {}, setup: undefined }
    const meta = {}
    if (mountOpts.cwd ?? opts.cwd) meta.cwd = mountOpts.cwd ?? opts.cwd
    if (mountOpts.agentPreset) meta.agentPreset = mountOpts.agentPreset
    if (mountOpts.parentAgent ?? opts.parentAgent) options.parentAgent = mountOpts.parentAgent ?? opts.parentAgent

    if (mountOpts.seed && fn(deps.buildForkSeed)) {
      const { events, boundary } = mountOpts.seed
      options.seed = deps.buildForkSeed(events, boundary)
      meta.isSeeded = true
      meta.parentSession = mountOpts.seed.parentSession
      options.inheritedEventCount = boundary + 1 // inclusive boundary → prefix length
    }

    // ── preset path: skills/agents rows mount by CLONING the base preset ──
    // meta.agentPreset selects ONE composition, so a probe preset is
    // base-rows ⊕ spec-rows — never the rows alone (that would strip the
    // agent's world). Registering a structured definition, not YAML.
    let presetDispose = null
    if (plan.presetRows.length) {
      const ap = probe.services.agentPresets
      const parse = deps.parsePresetYaml
      const baseId = mountOpts.basePreset ?? opts.basePreset ?? 'standard'
      if (!(ap && fn(ap.readDocument) && fn(ap.register))) {
        applyNotes.push('preset rows present but agentPresets.readDocument/register missing — rows unmounted')
      } else if (!fn(parse)) {
        applyNotes.push('preset rows present but deps.parsePresetYaml not injected — cannot clone the base preset')
      } else {
        try {
          const doc = await ap.readDocument(baseId)
          const baseRows = parse(doc && doc.content)
          const plugins = mergePresetRows(baseRows, plan.presetRows)
          const probeId = `ph-probe-${++presetCounter}-${randomUUID().slice(0, 8)}`
          const prior = ownedPresets.get(probeId)
          if (prior) { try { await prior() } catch { /* re-register anyway */ } ownedPresets.delete(probeId) }
          const dispose = await ap.register({ id: probeId, name: `ph probe ${probeId}`, plugins })
          ownedPresets.set(probeId, dispose)
          presetDispose = dispose
          meta.agentPreset = probeId
          applyNotes.push(`preset ${probeId}: ${plugins.length} rows (${plan.presetRows.length} overlaid on ${baseId})`)
        } catch (e) {
          applyNotes.push(`preset path failed: ${String(e?.message ?? e).slice(0, 200)} — rows unmounted`)
        }
      }
    }

    if (Object.keys(meta).length) options.meta = meta
    if (Object.keys(plan.agentOptions).length) options.agentOptions = plan.agentOptions

    options.setup = (agentCtx) => {
      // Everything registered here exists before agent/created + first
      // assembly. Prompt sections are best-effort (a collision degrades,
      // reported); tool policy is safety-relevant — a restrict failure
      // means the spec was NOT mounted as asked, so it throws.
      for (const s of plan.sections) {
        try {
          agentCtx.systemPrompt.section({ name: s.name, order: s.order, text: s.text, interpolate: s.interpolate })
        } catch (e) {
          applyNotes.push(`section ${s.name} failed: ${String(e?.message ?? e).slice(0, 160)}`)
        }
      }
      if (plan.restrict.allow || plan.restrict.deny) {
        agentCtx.tools.restrict(plan.restrict)
      }
      return undefined
    }

    const handle = await probe.services.agents.create(options)
    return {
      agent: handle.agent,
      disposer: handle,
      sessionId,
      spec: normalized,
      specHash: specHash(normalized),
      plan,
      inheritedEventCount: options.inheritedEventCount ?? 0,
      notes: applyNotes,
      presetDispose,
    }
  }

  /**
   * @param {object} handle mount() result
   * @param {object} task {id, domain, prompt}
   * @returns {Promise<object>} normalized Evidence
   */
  const run = async (handle, task) => {
    const agent = handle.agent
    if (!agent || !fn(agent.send) || !fn(agent.whenIdle)) {
      throw new Error('handle.agent lacks send/whenIdle — not a live agent handle')
    }
    const session = agent.session
    const collected = []
    const matches = (s) => s && String(s.id) === String(handle.sessionId)
    let off = null
    if (fn(ctx.on)) {
      try { off = ctx.on('session/event', (s, e) => { if (matches(s)) collected.push(e) }) } catch { /* listener is the fallback anyway */ }
    }

    let outcome = null
    try {
      agent.send(makeUserMessage(deps, task.prompt), 'next-turn', true)
      let wallTimer
      const timedOut = await Promise.race([
        agent.whenIdle().then(() => false),
        new Promise((res) => { wallTimer = setTimeout(() => res(true), wallMs) }),
      ])
      clearTimeout(wallTimer)
      if (timedOut) {
        outcome = 'timeout'
        try { agent.cancel({ kind: 'user' }) } catch { /* best-effort stop */ }
        // Drain is bounded too — a cancelled agent that never idles must not
        // hang the probe loop.
        try {
          let drainTimer
          await Promise.race([
            agent.whenIdle(),
            new Promise((res) => { drainTimer = setTimeout(res, Math.min(wallMs, 10_000)) }),
          ])
          clearTimeout(drainTimer)
        } catch { /* drain may fail — outcome stands */ }
      }
    } finally {
      try { if (fn(off)) off() } catch { /* cordis disposer variants */ }
    }

    // Committed log is authoritative; the listener is the fallback.
    let events = collected
    if (session && fn(session.snapshotEvents)) {
      try {
        const snap = session.snapshotEvents(handle.inheritedEventCount)
        if (snap.length) events = [...snap]
      } catch { /* keep collected */ }
    }

    const ev = normalizeEvidence(evidenceFromEvents(events, {
      runId: `dsh:${handle.sessionId}`,
      specHash: handle.specHash,
      task,
    }))
    if (outcome === 'timeout') ev.outcome = 'timeout'

    if (fn(deps.appendPluginRecord) && session) {
      try {
        deps.appendPluginRecord(session, 'plugin:perfect-harness', {
          kind: 'probe-run', specHash: handle.specHash, outcome: ev.outcome,
        })
      } catch { /* record is provenance garnish — never sinks the run */ }
    }
    return ev
  }

  const dispose = async (handle) => {
    // Agent first (stops the loop), then the probe preset it ran under.
    if (handle && handle.disposer && fn(handle.disposer.dispose)) await handle.disposer.dispose()
    if (handle && fn(handle.presetDispose)) {
      try { await handle.presetDispose() } catch { /* teardown must not sink the caller */ }
      for (const [id, d] of ownedPresets) if (d === handle.presetDispose) ownedPresets.delete(id)
    }
  }

  /** Safety net: unmount every preset still owned (handles never disposed). */
  const disposeAll = async () => {
    for (const [id, d] of [...ownedPresets]) {
      ownedPresets.delete(id)
      try { await d() } catch { /* best-effort */ }
    }
  }

  return {
    capabilities,
    mount,
    run,
    dispose,
    probe,
    notes: () => probe.notes,
    describeMount: (handle) => describePlan(handle.plan),
    disposeAll,
  }
}
