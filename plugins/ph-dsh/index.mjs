// PerfectHarness desktop plugin — mount via a profile patch row:
//   - insert: [{ id: ph-dsh, name: 'file:///D:/PerfectHarness/plugins/ph-dsh/index.mjs' }]
// (or a './'-relative name inside a patch file — patch-anchored resolution is
// the verified-working path; registered presets require file:// only).
//
// What it does on a desktop profile:
//   /ph status         — seam probe + subsystem state (no I/O in core; all
//                        host calls stay in this file + lib/adapters)
//   /ph step <task>    — one gated improvement step: base rollout → model
//                        proposals → candidate probes → compose → blind
//                        select → HUMAN gate (ctx.userQuestions.ask — the
//                        real desktop UI answerer) → reflect → lesson file
//   /ph lessons        — persisted library tail
//
// The gate is the point of this profile: headless has no answerer so
// human-required selections always keep base; here the waterfall reaches the
// desktop UI and the human's choice is real. Real mid-run user messages also
// arrive as source.kind:'user' — evidence maps them to correction steps.

import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDshSubstrate } from '../../lib/adapters/dsh/index.js'
import { createDshChannels } from '../../lib/adapters/dsh/channels.js'
import { createDshHumanGate } from '../../lib/adapters/dsh/gate.js'
import { createFileLessonStore } from '../../lib/adapters/file-lessons.js'
import { runImprovementStep } from '../../lib/core/loop.js'
import { probeSeams, formatProbe } from '../../lib/adapters/dsh/seams.js'

// Host deps MUST resolve from the host's own node_modules copy — a foreign
// package copy fails instanceof checks ('Receiver must be an instance of
// class Session'). Verified hazard. Under ELECTRON_RUN_AS_NODE, asar paths
// resolve directly.
const HOST_NM = 'file:///C:/Users/Ольга/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules'
const loadDeps = async () => {
  const [fork, session, llm] = await Promise.all([
    import(`${HOST_NM}/@deepseek-ai/dsh-session/lib/types/fork.js`).catch(() => ({})),
    import(`${HOST_NM}/@deepseek-ai/dsh-session/lib/index.js`).catch(() => ({})),
    import(`${HOST_NM}/@deepseek-ai/dsh-llm/lib/types/message.js`).catch(() => ({})),
  ])
  return {
    buildForkSeed: fork.buildForkSeed,
    appendPluginRecord: session.appendPluginRecord,
    createUserMessage: llm.createUserMessage,
  }
}

export const name = 'perfect-harness'
export const inject = [] // every service is probed at use time — optional everywhere

export function apply(ctx, config = {}) {
  const state = {
    deps: null,
    library: null,
    lessonFile: join(config.dataDir ?? '.', 'ph-lessons.json'),
    baseSpec: config.baseSpec ?? {},
    lastStep: null,
  }
  const log = (m) => { try { ctx.logger?.info?.(`[ph] ${m}`) } catch { /* logger optional */ } }

  const ensureDeps = async () => {
    if (!state.deps) state.deps = await loadDeps()
    return state.deps
  }
  const ensureLibrary = async () => {
    if (state.library) return state.library
    const store = createFileLessonStore(state.lessonFile)
    state.library = await store.load()
    state.store = store
    return state.library
  }

  const status = async () => {
    const probe = probeSeams(ctx, await ensureDeps())
    const lib = await ensureLibrary()
    const gateSvc = ctx.get('userQuestions')
    return [
      'perfect-harness — recursive harness optimization',
      formatProbe(probe).map((l) => '  ' + l).join('\n'),
      `  human gate: ${gateSvc ? 'userQuestions service present — /ph step will ASK before adopting' : 'no userQuestions — every human-required gate declines (keeps base)'}`,
      `  lessons: ${lib.entries?.length ?? 0} persisted (${state.lessonFile})`,
      `  last step: ${state.lastStep ? `${state.lastStep.improved ? 'improved' : 'base kept'} (${state.lastStep.label})` : 'none this session'}`,
    ].join('\n')
  }

  const step = async (rawInput, agent) => {
    const taskText = rawInput.replace(/^step\s*/, '').trim()
    if (!taskText) return 'usage: /ph step <task text>'
    const notes = []
    const deps = await ensureDeps()
    const substrate = createDshSubstrate({ ctx, deps, opts: {} })
    const channels = createDshChannels({
      substrate,
      spec: { model: config.model ?? state.baseSpec.model },
      notes,
      retries: 1,
    })
    const gate = createDshHumanGate({ ctx, notes })
    const library = await ensureLibrary()
    const started = Date.now()
    const r = await runImprovementStep({
      task: { id: `ph-step-${Date.now()}`, domain: 'interactive', prompt: taskText },
      baseSpec: state.baseSpec,
      substrate, channels, gate, library,
      requireHuman: true,
    })
    if (r.adoptedSpec && r.improved) state.baseSpec = r.adoptedSpec // adopted spec becomes the new harness
    if (r.lesson) {
      try { await mkdir(join(state.lessonFile, '..'), { recursive: true }); await state.store.save(library) } catch (e) { notes.push(`lesson persist failed: ${String(e?.message ?? e).slice(0, 120)}`) }
    }
    state.lastStep = { improved: r.improved, label: r.adoptedLabel, at: Date.now() }
    return [
      `step ${r.ok ? 'completed' : 'incomplete'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${r.improved ? `ADOPTED ${r.adoptedLabel}` : 'base kept'}`,
      `  gate: ${r.trail?.selection ? `${r.trail.selection.reason} → ${r.notes.find((n) => n.startsWith('gate:')) ?? ''}` : r.notes.find((n) => n.startsWith('gate:')) ?? 'no gate event'}`,
      r.lesson ? `  lesson: ${r.lesson.lesson}` : '  lesson: none',
      ...notes.slice(0, 12).map((n) => `  · ${n}`),
      ...(notes.length > 12 ? [`  … +${notes.length - 12} notes`] : []),
    ].join('\n')
  }

  // Deferred injection: fires once `commands` is provided, never earlier —
  // the verified cordis ordering seam (same pattern dsh-agent-tool-
  // presentation uses for ptcRuntime). Ready-time ctx.on('ready') is NOT a
  // documented cordis event — inject is.
  ctx.inject(['commands'], (phCtx) => {
    ensureDeps().then(() => ensureLibrary()).catch((e) => log(`init: ${e?.message ?? e}`))
    const commands = phCtx.commands
    if (commands?.register) {
      commands.register({
        name: 'ph',
        description: 'PerfectHarness — recursive harness optimization. /ph status | step <task> | lessons',
        input: { hint: 'status | step <task> | lessons' },
        handler: async ({ rawInput }) => {
          const cmd = (rawInput ?? '').trim().split(/\s+/)[0] ?? 'status'
          try {
            if (cmd === 'status') return await status()
            if (cmd === 'step') return await step(rawInput)
            if (cmd === 'lessons') {
              const lib = await ensureLibrary()
              const entries = lib.entries ?? []
              return entries.length
                ? entries.slice(-10).map((l, i) => `${i + 1}. [${l.domain}] ${l.cue} — ${l.lesson}`).join('\n')
                : '(no lessons persisted)'
            }
            return 'unknown subcommand — try: status | step <task> | lessons'
          } catch (e) {
            return `ph ${cmd} failed: ${String(e?.message ?? e).slice(0, 300)}`
          }
        },
      })
      log('registered /ph')
    } else {
      log('commands seam missing — plugin is inert on this profile')
    }
  })
}
