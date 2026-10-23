// Live probe plugin — mounts PerfectHarness's DSH substrate inside a real
// host and runs one trivial task through it. Verification only, not shipped.
// Fires once, on the FIRST agent/created (the headless main agent); our own
// probe agent's creation is ignored by the flag.
import { writeFile } from 'node:fs/promises'
import { createDshSubstrate } from '../../lib/adapters/dsh/index.js'

// Host function deps — the substrate takes them by injection so lib/ keeps no
// hard @deepseek-ai imports. They MUST come from the host's own package copy
// (app.asar): a foreign copy's instanceof checks fail ('Receiver must be an
// instance of class Session'). Electron resolves asar paths under
// ELECTRON_RUN_AS_NODE.
const HOST_NM = 'file:///C:/Users/Ольга/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const loadDeps = async () => {
  const [fork, session, llm] = await Promise.all([
    import(`${HOST_NM}/@deepseek-ai/dsh-session/lib/types/fork.js`).catch((e) => ({ __err: String(e) })),
    import(`${HOST_NM}/@deepseek-ai/dsh-session/lib/index.js`).catch((e) => ({ __err: String(e) })),
    import(`${HOST_NM}/@deepseek-ai/dsh-llm/lib/types/message.js`).catch((e) => ({ __err: String(e) })),
  ])
  return {
    buildForkSeed: fork.buildForkSeed,
    appendPluginRecord: session.appendPluginRecord,
    createUserMessage: llm.createUserMessage,
    __errors: [fork.__err, session.__err, llm.__err].filter(Boolean),
  }
}

export const name = 'ph-live-probe'

export function apply(ctx, config = {}) {
  const out = config.out ?? 'probe-result.json'
  const log = (m) => { try { ctx.logger?.info ? ctx.logger.info(m) : console.log(m) } catch { /* last resort */ } }
  let fired = false
  ctx.on('agent/created', () => {
    if (fired) return
    fired = true
    ;(async () => {
      try {
        const deps = await loadDeps()
        const sub = createDshSubstrate({
          ctx, deps,
          opts: { wallMs: 120_000, cwd: 'D:/PerfectHarness/tests/live' },
        })
        const caps = sub.capabilities()
        log('ph-probe caps: ' + JSON.stringify(caps))
        if (deps.__errors?.length) log('ph-probe dep import errors: ' + deps.__errors.join(' | '))
        const spec = {
          prompt: { guidance: 'Reply with exactly the text PROBE-OK and nothing else.' },
          model: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' },
        }
        const handle = await sub.mount(spec)
        const ev = await sub.run(handle, { id: 'live-1', domain: 'live', prompt: 'Reply with exactly the text PROBE-OK and nothing else.' })
        // Raw snapshot for contract debugging — what the host actually commits.
        let raw = []
        try { raw = handle.agent?.session?.snapshotEvents?.(handle.inheritedEventCount) ?? [] } catch (e) { raw = [{ err: String(e) }] }
        const headerTools = raw.filter((e) => e.type === 'request/header').flatMap((e) => (e.data?.header?.tools ?? []).map((t) => t.name))
        await sub.dispose(handle)

        // liveRestrict exercised for real: a second mount with tools.keep must
        // shrink the request/header tools list on the wire.
        let restrictCheck = { skipped: true }
        try {
          const h2 = await sub.mount({
            ...spec,
            tools: { keep: ['read'] },
          })
          const ev2 = await sub.run(h2, { id: 'live-2', domain: 'live', prompt: 'Reply with exactly the text PROBE-OK and nothing else.' })
          const raw2 = h2.agent?.session?.snapshotEvents?.(h2.inheritedEventCount) ?? []
          const headerTools2 = raw2.filter((e) => e.type === 'request/header').flatMap((e) => (e.data?.header?.tools ?? []).map((t) => t.name))
          restrictCheck = { outcome: ev2.outcome, keep: 'read', headerTools: headerTools2, mount: sub.describeMount(h2) }
          await sub.dispose(h2)
        } catch (e) { restrictCheck = { error: String(e?.stack ?? e) } }

        // logRecords: run() appends 'plugin:perfect-harness' — find it in the
        // committed stream (ignorable events sit outside SessionEventMap).
        const recordEvents = raw.filter((e) => typeof e.type === 'string' && e.type.startsWith('plugin:'))
        // Direct write-test: the flag is dep-injected, so prove the seam
        // actually accepts a record (the upstream caller gate may reject).
        let recordCheck = { skipped: true }
        try {
          const seq = deps.appendPluginRecord
            ? deps.appendPluginRecord(handle.agent.session, 'plugin:perfect-harness', { kind: 'probe-write-test' })
            : undefined
          recordCheck = { wrote: typeof seq === 'number', seq }
        } catch (e) { recordCheck = { threw: true, error: String(e?.message ?? e) } }

        // seededFork: branch a new agent off run-1's committed prefix. The
        // fork inherits seq 0..18 (complete turn 1), so it must remember the
        // instruction WITHOUT being told again.
        let forkCheck = { skipped: true }
        try {
          const boundary = Math.max(...raw.map((e) => e.seq ?? 0))
          const h3 = await sub.mount(spec, {
            seed: { events: raw, boundary, parentSession: handle.sessionId },
          })
          const forkEv = await sub.run(h3, {
            id: 'live-3', domain: 'live',
            prompt: 'Without repeating my earlier instruction, what was the exact text I told you to reply with? Answer with only that text.',
          })
          const own = h3.agent?.session?.snapshotEvents?.(h3.inheritedEventCount) ?? []
          const all = h3.agent?.session?.snapshotEvents?.(0) ?? []
          forkCheck = {
            boundary, inheritedEventCount: h3.inheritedEventCount,
            totalEvents: all.length, ownEvents: own.length,
            ownTypes: own.map((e) => e.type),
            outcome: forkEv.outcome, finalText: forkEv.deliverable?.finalText,
          }
          await sub.dispose(h3)
        } catch (e) { forkCheck = { error: String(e?.stack ?? e) } }

        const result = { caps, notes: sub.notes(), handleNotes: handle.notes, mount: sub.describeMount(handle), evidence: ev, headerTools, restrictCheck, recordEvents: recordEvents.map((e) => ({ seq: e.seq, type: e.type })), recordCheck, forkCheck }
        await writeFile(out, JSON.stringify(result, null, 2))
        log(`ph-probe done: outcome=${ev.outcome} steps=${ev.steps.length} tokens=${ev.stats.tokens} delivered=${ev.deliverable.delivered}`)
      } catch (e) {
        try { await writeFile(out, JSON.stringify({ error: String(e?.stack ?? e) }, null, 2)) } catch { }
        log('ph-probe failed: ' + String(e?.stack ?? e))
      }
    })()
  })
}
