// Live probe plugin — mounts PerfectHarness's DSH substrate inside a real
// host and runs one trivial task through it. Verification only, not shipped.
// Fires once, on the FIRST agent/created (the headless main agent); our own
// probe agent's creation is ignored by the flag.
import { writeFile } from 'node:fs/promises'
import { createDshSubstrate } from '../../lib/adapters/dsh/index.js'
import { createDshChannels } from '../../lib/adapters/dsh/channels.js'
import { createFileLessonStore } from '../../lib/adapters/file-lessons.js'
import { runImprovementStep } from '../../lib/core/loop.js'

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
  // parsePresetYaml: MaxCompact's battle-tested row parser (plain js-yaml +
  // !!js→__jsExpr; no host coupling — safe to inject from its tree).
  const presetReg = await import('file:///D:/MaxCompact/dsh-max-compact/lib/dsh/preset-registry.js').catch(() => ({}))
  return {
    buildForkSeed: fork.buildForkSeed,
    appendPluginRecord: session.appendPluginRecord,
    createUserMessage: llm.createUserMessage,
    parsePresetYaml: presetReg.parseRowsYaml,
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
        // listener-vs-snapshot verification: count events the live
        // session/event stream delivers vs what snapshotEvents() commits.
        let listenerCount = -1
        const off = ctx.on?.('session/event', (s) => { if (s && String(s.id) === String(handle.sessionId)) listenerCount++ })
        const ev = await sub.run(handle, { id: 'live-1', domain: 'live', prompt: 'Reply with exactly the text PROBE-OK and nothing else.' })
        try { off?.() } catch { }
        // Raw snapshot for contract debugging — what the host actually commits.
        let raw = []
        try { raw = handle.agent?.session?.snapshotEvents?.(handle.inheritedEventCount) ?? [] } catch (e) { raw = [{ err: String(e) }] }
        const headerTools = raw.filter((e) => e.type === 'request/header').flatMap((e) => (e.data?.header?.tools ?? []).map((t) => t.name))
        await sub.dispose(handle)

        // M3 — first real lesson, run EARLY: the host tears down the agent
        // factory when the main task ends, so the mount-heavy improvement
        // steps must land before the cheaper already-proven checks.
        let lessonCheck = { skipped: true }
        try {
          const ch = createDshChannels({
            substrate: sub,
            spec: { model: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' } },
          })
          const store = createFileLessonStore('D:/PerfectHarness/tests/live/lessons.json')
          const library = await store.load()
          const step = await runImprovementStep({
            task: {
              id: 'lesson-1', domain: 'exact-output',
              prompt: 'Use the read tool to read the file probe-input.txt in the current directory, then reply with exactly its content and nothing else.',
            },
            baseSpec: {
              prompt: { guidance: 'Always begin your reply with a warm friendly greeting before anything else.' },
              model: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' },
            },
            substrate: sub, channels: ch, caps: sub.capabilities(),
            library,
            // Simulated operator: approves gate prompts so the adoption path
            // (and its reflect material) is exercised in headless.
            gate: { confirm: async () => true },
          })
          await store.save(library)
          lessonCheck = {
            ok: step.ok, improved: step.improved, adoptedLabel: step.adoptedLabel,
            librarySize: library.entries.length,
            notes: step.notes,
            proposals: step.trail.proposals.map((p) => p.description),
            selection: step.trail.selection && { reason: step.trail.selection.reason, confidence: step.trail.selection.confidence, adoptIndex: step.trail.selection.adoptIndex },
            lesson: step.lesson,
            evidences: step.trail.evidences.map((e) => ({ label: e.label, outcome: e.evidence.outcome, final: e.evidence.deliverable?.finalText?.slice(0, 80) })),
          }
        } catch (e) { lessonCheck = { error: String(e?.stack ?? e) } }

        // The crown jewel: one full Harness² improvement step live — propose,
        // probe, compose, blind-select, gate, reflect, all on the real host.
        let loopCheck = { skipped: true }
        try {
          const ch = createDshChannels({
            substrate: sub,
            spec: { model: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' } },
          })
          // Same library + same domain → selectFor serves the lesson written
          // by lessonCheck (prefix rule: later task in the same domain).
          const store2 = createFileLessonStore('D:/PerfectHarness/tests/live/lessons.json')
          const library2 = await store2.load()
          const step = await runImprovementStep({
            task: {
              id: 'loop-1', domain: 'exact-output', index: 1,
              prompt: 'Use the read tool to read the file probe-input.txt in the current directory, then reply with exactly its content and nothing else.',
            },
            baseSpec: spec,
            substrate: sub,
            channels: ch,
            caps: sub.capabilities(),
            library: library2,
            gate: { confirm: async () => true },
          })
          await store2.save(library2)
          loopCheck = {
            lessonsServed: library2.selectFor({ domain: 'exact-output', beforeTaskIndex: 1 }).length,
            ok: step.ok, improved: step.improved, adoptedLabel: step.adoptedLabel,
            notes: step.notes, proposals: step.trail.proposals.map((p) => p.description),
            selection: step.trail.selection, lesson: step.lesson && { cue: step.lesson.cue, lesson: step.lesson.lesson },
            evidences: step.trail.evidences.map((e) => ({ label: e.label, outcome: e.evidence.outcome, final: e.evidence.deliverable?.finalText?.slice(0, 60) })),
          }
        } catch (e) { loopCheck = { error: String(e?.stack ?? e) } }

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

        // Live channels: a real select + propose through mounted judge/editor
        // agents — the Harness² thinking half on the wire.
        let channelCheck = { skipped: true }
        try {
          const chNotes = []
          const channels = createDshChannels({
            substrate: sub,
            spec: { model: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash-1017' } },
            notes: chNotes,
          })
          const verdict = await channels.select(
            'The function returns the sum of the two arguments, verified by tests.',
            'I dunno, something about numbers maybe.')
          const proposals = await channels.propose({
            task: { prompt: 'Reply with exactly the text PROBE-OK and nothing else.' },
            spec: { prompt: { guidance: 'be helpful' } },
            specHash: ev.specHash,
            baseTrajectory: `outcome=${ev.outcome}; final=${ev.deliverable?.finalText}; steps=0`,
            lessons: [],
          })
          channelCheck = { verdict, proposalCount: proposals.length, proposals: proposals.map((p) => p.description), notes: chNotes }
        } catch (e) { channelCheck = { error: String(e?.stack ?? e) } }

        // agentPresets live: the headless registry is EMPTY (list()→[]), so
        // first register `ph-base` from a REAL preset file on disk
        // (.agent-presets/custom/agent.cordis.yml — a genuine desktop-generated
        // composition), then clone it via the normal mount path. Checks:
        //   1. register() accepts a structured definition
        //   2. readDocument() serves a registered (not file-backed) doc
        //   3. agents.create accepts meta.agentPreset pointing at our temp id
        let presetCheck = { skipped: true }
        try {
          const ap = ctx.get?.('agentPresets')
          presetCheck = { servicePresent: Boolean(ap) }
          if (ap) {
            presetCheck.available = ap.list ? await ap.list() : 'no list()'
            const { readFile } = await import('node:fs/promises')
            const { homedir } = await import('node:os')
            const presetFile = `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/.agent-presets/custom/agent.cordis.yml`
            const rows = deps.parsePresetYaml(await readFile(presetFile, 'utf8'))
            presetCheck.parsedBaseRows = rows.length
            const baseDispose = await ap.register({ id: 'ph-base', name: 'ph base clone', plugins: rows })
            presetCheck.registered = true
            try {
              const docBack = await ap.readDocument('ph-base')
              presetCheck.readDocumentServesRegistered = typeof docBack?.content === 'string' && docBack.content.length > 0
            } catch (e) { presetCheck.readDocumentServesRegistered = 'threw: ' + String(e?.message ?? e).slice(0, 120) }
            const h4 = await sub.mount(
              { ...spec, skills: { 'skill-fs': { name: '@deepseek-ai/dsh-skill-filesystem' } } },
              { basePreset: 'ph-base' })
            presetCheck.notes = h4.notes
            presetCheck.mount = sub.describeMount(h4)
            await sub.dispose(h4) // runs presetDispose — live-suspect #1
            // Hazard isolation: did disposing the mounted preset kill the
            // shared agent factory? Sanity-mount before disposing ph-base.
            try {
              const sanity = await sub.mount(spec)
              presetCheck.factoryAfterProbeDispose = 'alive'
              await sub.dispose(sanity)
            } catch (e) { presetCheck.factoryAfterProbeDispose = 'dead: ' + String(e?.message ?? e).slice(0, 120) }
            try { await baseDispose() } catch { /* cleanup best-effort */ }
            try {
              const sanity2 = await sub.mount(spec)
              presetCheck.factoryAfterBaseDispose = 'alive'
              await sub.dispose(sanity2)
            } catch (e) { presetCheck.factoryAfterBaseDispose = 'dead: ' + String(e?.message ?? e).slice(0, 120) }
          }
        } catch (e) { presetCheck.error = String(e?.stack ?? e).slice(0, 400) }

        const result = { caps, notes: sub.notes(), handleNotes: handle.notes, mount: sub.describeMount(handle), evidence: ev, eventCounts: { listener: listenerCount, snapshot: raw.length }, headerTools, restrictCheck, recordEvents: recordEvents.map((e) => ({ seq: e.seq, type: e.type })), recordCheck, forkCheck, channelCheck, presetCheck, lessonCheck, loopCheck }
        await writeFile(out, JSON.stringify(result, null, 2))
        log(`ph-probe done: outcome=${ev.outcome} steps=${ev.steps.length} tokens=${ev.stats.tokens} delivered=${ev.deliverable.delivered}`)
      } catch (e) {
        try { await writeFile(out, JSON.stringify({ error: String(e?.stack ?? e) }, null, 2)) } catch { }
        log('ph-probe failed: ' + String(e?.stack ?? e))
      }
    })()
  })
}
