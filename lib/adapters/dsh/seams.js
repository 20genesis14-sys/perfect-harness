// Seam probe — which DSH services + injectable functions exist.
// Produces the capability flag map for the substrate contract. Missing seam
// → feature off + honest note, never a crash (the MaxCompact rule).

const fn = (v) => typeof v === 'function'

/**
 * @param {object} ctx host Cordis ctx (dsh-context), may be a partial mock
 * @param {object} [deps] functions the caller resolved separately:
 *   buildForkSeed, appendPluginRecord, installModelSelection, createUserMessage —
 *   injected so the adapter needs no hard @deepseek-ai imports at test time.
 * @returns {{flags:object, notes:string[], services:object}}
 */
export function probeSeams(ctx, deps = {}) {
  const get = fn(ctx?.get) ? (n) => { try { return ctx.get(n) } catch { return undefined } } : () => undefined
  const services = {
    agents: get('agents'),
    sessions: get('sessions'),
    systemPrompt: get('systemPrompt'),
    tools: get('tools'),
    llm: get('llm'),
    jobs: get('jobs'),
    settings: get('settings'),
    subagents: get('subagents'),
  }

  const create = !!(services.agents && fn(services.agents.create))
  const notes = []
  if (!create) notes.push('agents.create unavailable — isolated mounts off (retrospective mode)')
  if (!fn(deps.buildForkSeed)) notes.push('buildForkSeed not injected — seeded forks off')
  if (!fn(deps.appendPluginRecord)) notes.push('appendPluginRecord not injected — lessons go to file store')
  if (!fn(deps.createUserMessage)) notes.push('createUserMessage not injected — raw user-message fallback in run()')

  const structuredLog = !!(services.sessions && (fn(services.sessions.get) || fn(services.sessions.events)))
  if (!structuredLog) notes.push('sessions service missing — no event log, no structured steps')

  const flags = {
    isolatedMount: create,
    seededFork: create && fn(deps.buildForkSeed),
    // agentOptions {provider,model} at create = per-mount routing; live
    // switching additionally uses installModelSelection when injected.
    modelRouting: create,
    liveRestrict: !!(services.tools && (fn(services.tools.restrict) || fn(ctx?.tools?.restrict))),
    structuredLog,
    logRecords: fn(deps.appendPluginRecord),
    // user/message source.kind + turn/end aborted{user} travel inside the
    // event stream — the signal exists wherever structuredLog does.
    userSignal: structuredLog,
  }
  return { flags, notes, services }
}

/** Human-readable probe result for status surfaces. */
export function formatProbe(probe) {
  const on = Object.entries(probe.flags).filter(([, v]) => v).map(([k]) => k)
  return `seams: ${on.length ? on.join(', ') : 'none'}` + (probe.notes.length ? ` | ${probe.notes.join(' | ')}` : '')
}
