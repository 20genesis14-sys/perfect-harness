// Live probe plugin — mounts PerfectHarness's DSH substrate inside a real
// host and runs one trivial task through it. Verification only, not shipped.
// Fires once, on the FIRST agent/created (the headless main agent); our own
// probe agent's creation is ignored by the flag.
import { writeFile } from 'node:fs/promises'
import { createDshSubstrate } from '../../lib/adapters/dsh/index.js'

// Host function deps — the substrate takes them by injection so lib/ keeps no
// hard @deepseek-ai imports. Resolved from MaxCompact's installed copies; the
// runtime accepts them because the host uses the same package versions.
const MC = 'file:///D:/MaxCompact/dsh-max-compact/node_modules'
const loadDeps = async () => {
  const [fork, session, llm] = await Promise.all([
    import(`${MC}/@deepseek-ai/dsh-session/lib/types/fork.js`).catch(() => ({})),
    import(`${MC}/@deepseek-ai/dsh-session/lib/index.js`).catch(() => ({})),
    import(`${MC}/@deepseek-ai/dsh-llm/lib/types/message.js`).catch(() => ({})),
  ])
  return {
    buildForkSeed: fork.buildForkSeed,
    appendPluginRecord: session.appendPluginRecord,
    createUserMessage: llm.createUserMessage,
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

        const result = { caps, notes: sub.notes(), handleNotes: handle.notes, mount: sub.describeMount(handle), evidence: ev, headerTools, restrictCheck }
        await writeFile(out, JSON.stringify(result, null, 2))
        log(`ph-probe done: outcome=${ev.outcome} steps=${ev.steps.length} tokens=${ev.stats.tokens} delivered=${ev.deliverable.delivered}`)
      } catch (e) {
        try { await writeFile(out, JSON.stringify({ error: String(e?.stack ?? e) }, null, 2)) } catch { }
        log('ph-probe failed: ' + String(e?.stack ?? e))
      }
    })()
  })
}
