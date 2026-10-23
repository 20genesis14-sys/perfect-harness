// Live model channels — propose/compose/select/reflect driven by real
// mounted agents instead of injected functions. The Harness² loop's
// thinking half: each call mounts a purpose-built agent, runs one prompt,
// parses the deliverable. Blindness is structural: the judge spec carries
// no labels, and select() forwards only the two deliverable texts.
//
// Each channel call is a FRESH mount — no shared context between pairs, so
// a judge cannot leak memory of earlier verdicts or spec diffs. Costs one
// mount+run each (~1-3s on a routed flash model).

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'

/** Largest JSON value parseable from model text — fence, then outermost span. */
const parseJson = (text) => {
  if (!isStr(text)) return null
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : text
  try { return JSON.parse(body) } catch { /* fall through to span scan */ }
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = body.indexOf(open)
    const end = body.lastIndexOf(close)
    if (start >= 0 && end > start) {
      try { return JSON.parse(body.slice(start, end + 1)) } catch { /* next shape */ }
    }
  }
  return null
}

/** Models love dot-notation patches ({"prompt.systemAppend": "…"}); the spec
 * schema wants nesting. Unflatten one level deep — dotted keys expand, real
 * sections win if both spellings appear. Live-verified failure mode. */
const unflatten = (patch) => {
  if (!isObj(patch)) return patch
  const out = {}
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes('.')) {
      const parts = k.split('.').filter(Boolean)
      let node = out
      for (const part of parts.slice(0, -1)) {
        node[part] = isObj(node[part]) ? node[part] : {}
        node = node[part]
      }
      const leaf = parts.at(-1)
      if (node[leaf] === undefined) node[leaf] = v
      else if (isObj(node[leaf]) && isObj(v)) node[leaf] = { ...v, ...node[leaf] }
    } else if (isObj(v) && isObj(out[k])) {
      out[k] = { ...v, ...out[k] } // real keys merge over expanded dotted ones
    } else {
      out[k] = v
    }
  }
  return out
}

/** Run one prompt on a fresh mounted agent; returns finalText or ''. */
const ask = async (substrate, spec, prompt, id) => {
  const handle = await substrate.mount(spec)
  try {
    const ev = await substrate.run(handle, { id, domain: 'ph-channel', prompt })
    return isStr(ev?.deliverable?.finalText) ? ev.deliverable.finalText : ''
  } finally {
    try { await substrate.dispose(handle) } catch { /* teardown best-effort */ }
  }
}

const PROPOSE_SCHEMA = `Reply with ONLY a JSON array (no prose, no fences) of up to 3 harness proposals. Each item:
{"description": "one sentence — what this changes and why", "patch": {<spec patch>}}
Spec patch semantics: top-level sections {prompt:{persona,guidance,systemAppend}, tools:{keep,hide,guidance}, model:{provider,model,effort}, skills:{}, agents:{}, scripts:{}, memory, extensions}. Present values replace, null deletes, arrays replace wholesale. Do not propose a different provider/model unless the evidence demands it. model.effort may be rejected by routes that do not declare reasoning efforts — prefer prompt/tools changes when they suffice.`

const REFLECT_SCHEMA = `Reply with ONLY a JSON object (no prose, no fences) or the word NONE:
{"cue": "when this lesson applies (domain-shaped)", "lesson": "the durable rule", "evidence": [{"runId": "...", "seq": 0}]}
evidence refs must point at step seqs in the trajectories shown. Reply NONE when nothing durable separates the outcomes.`

/**
 * @param {object} args
 * @param {object} args.substrate DSH substrate {mount, run, dispose}
 * @param {object} [args.spec] channel spec base — MUST set model.{provider,model}
 *   (a mount without a route dies at {{model}} assembly — live-verified)
 * @param {object} [args.specs] per-channel overrides: {propose, compose, select, reflect}
 * @param {string[]} [args.notes] sink for degradation notes
 * @returns {object} {propose, compose, select, reflect} — core channel contract
 */
export function createDshChannels({ substrate, spec = {}, specs = {}, notes } = {}) {
  if (!isObj(substrate) || typeof substrate.mount !== 'function') {
    throw new Error('createDshChannels needs a substrate {mount, run, dispose}')
  }
  const say = (m) => { if (Array.isArray(notes)) notes.push(m) }
  const pick = (k) => ({ ...spec, ...(isObj(specs[k]) ? specs[k] : {}) })

  return {
    /** → [{description, patch, kind?}] — malformed items drop, never throw. */
    async propose(ctx) {
      const lessons = (ctx.lessons ?? []).map((l) => `- ${l.cue ?? ''}: ${l.lesson ?? l}`).join('\n')
      const text = await ask(substrate, pick('propose'),
        `You are the harness improver. Task:\n${ctx.task?.prompt ?? ''}\n\n` +
        `Current harness spec:\n${JSON.stringify(ctx.spec ?? {})}\n\n` +
        `Base run trajectory:\n${ctx.baseTrajectory ?? '(none)'}\n\n` +
        (lessons ? `Lessons already known (do not repeat):\n${lessons}\n\n` : '') +
        PROPOSE_SCHEMA, 'ch-propose')
      const arr = parseJson(text)
      if (!Array.isArray(arr)) { say('propose: unparseable reply — no proposals'); return [] }
      return arr.filter((p) => isObj(p) && isObj(p.patch)).map((p) => ({
        description: String(p.description ?? ''), patch: unflatten(p.patch), kind: p.kind,
      }))
    },

    /** → {patch} | null — merges probed candidates into one refined spec. */
    async compose(ctx) {
      const entries = (ctx.entries ?? [])
        .map((e) => `## ${e.label}\ndiff vs base:\n${e.diff}\ncontrast:\n${e.contrast}\ntrajectory:\n${e.trajectory}`)
        .join('\n\n')
      const text = await ask(substrate, pick('compose'),
        `You are the harness composer. Task:\n${ctx.task?.prompt ?? ''}\n\n` +
        `Base trajectory:\n${ctx.baseTrajectory ?? '(none)'}\n\n` +
        `Probed candidates:\n${entries}\n\n` +
        `Compose ONE patch merging what worked. Reply with ONLY a JSON object {"patch": {...}} (same patch semantics), or {} if nothing composes.`, 'ch-compose')
      const out = parseJson(text)
      return isObj(out) && isObj(out.patch) ? { patch: unflatten(out.patch) } : null
    },

    /** Blind judge: only the two deliverable texts, nothing else. */
    async select(textA, textB) {
      const text = await ask(substrate, pick('select'),
        `Two deliverables for the same task. Judge only which better fulfills it — no ties unless truly equal.\n\n` +
        `--- DELIVERABLE A ---\n${textA}\n\n--- DELIVERABLE B ---\n${textB}\n\n` +
        `Reply with exactly one word: A, B, or TIE.`, 'ch-select')
      const m = text.trim().match(/^\s*(A|B|TIE)\b/i)
      return m ? m[1].toUpperCase() : 'tie'
    },

    /** → lesson draft {cue, lesson, evidence:[{runId,seq}]} | null */
    async reflect(ctx) {
      const text = await ask(substrate, pick('reflect'),
        `You are the harness reflector. Task:\n${ctx.task?.prompt ?? ''}\n\n` +
        `Base trajectory:\n${ctx.baseTrajectory ?? '(none)'}\n\n` +
        `Adopted trajectory (${ctx.adoptedLabel ?? 'base'}):\n${ctx.adoptedTrajectory ?? '(none)'}\n\n` +
        `Adopted diff: ${ctx.diffs ?? '(none)'}\nImproved: ${ctx.improved ? 'yes' : 'no'}\n\n` +
        REFLECT_SCHEMA, 'ch-reflect')
      const out = parseJson(text)
      if (!isObj(out) || !isStr(out.lesson)) return null
      return {
        cue: isStr(out.cue) ? out.cue : '',
        lesson: out.lesson,
        evidence: Array.isArray(out.evidence) ? out.evidence.filter((r) => isObj(r)) : [],
      }
    },
  }
}
