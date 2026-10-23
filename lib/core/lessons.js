// Lessons library — the persistent "improvement harness" of the method.
//
// A lesson = {cue, lesson, refs:[{runId,seq}], domain, confidence} admitted
// ONLY when every evidence ref resolves — in Harness² "evidence-supported"
// is a prompt instruction checked by non-empty fields; here it is a code
// contract: the cited run must exist and the cited seq must be a real step.
//
// Entries carry counters and a status, because memory that cannot be
// corrected is worse than no memory: a lesson that predicted an improvement
// which then materialized as a regression gets marked 'refuted' and stops
// being served to editors.

const STATUSES = Object.freeze(['active', 'stale', 'refuted'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * Validate a lesson draft AND resolve its evidence refs.
 * @param {object} draft {cue, lesson, evidence:[{runId,seq?}], domain?, confidence?}
 * @param {object} opts
 * @param {(runId:string)=>object|null} opts.lookupRun evidence by runId (or null)
 * @param {boolean} [opts.seqRefs] when false, only runId must resolve
 *   (substrates without structured logs). Default true.
 * @returns {{ok:boolean, errors:string[], entry?:object}}
 */
export function admitLesson(draft, { lookupRun, seqRefs = true } = {}) {
  const errors = []
  if (!isObj(draft)) return { ok: false, errors: ['lesson draft must be an object'] }
  if (!isStr(draft.cue)) errors.push('cue must be a non-empty string — when does this apply')
  if (!isStr(draft.lesson)) errors.push('lesson must be a non-empty string — what to do')
  const refs = draft.evidence
  if (!Array.isArray(refs) || refs.length === 0) {
    errors.push('evidence must be a non-empty array of {runId, seq} refs')
  } else {
    refs.forEach((r, i) => {
      if (!isObj(r) || !isStr(r.runId)) {
        errors.push(`evidence[${i}] needs {runId}`)
        return
      }
      const ev = typeof lookupRun === 'function' ? lookupRun(r.runId) : null
      if (!ev) {
        errors.push(`evidence[${i}]: run ${JSON.stringify(r.runId)} not found — a lesson must cite a real rollout`)
        return
      }
      if (seqRefs) {
        if (!Number.isInteger(r.seq) || r.seq < 0) {
          errors.push(`evidence[${i}].seq must be a non-negative integer`)
        } else if (!ev.steps?.some((s) => s.seq === r.seq)) {
          errors.push(`evidence[${i}]: run ${r.runId} has no step seq=${r.seq}`)
        }
      }
    })
  }
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    errors: [],
    entry: {
      id: draft.id ?? `les_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      domain: isStr(draft.domain) ? draft.domain : '_',
      cue: draft.cue.trim(),
      lesson: draft.lesson.trim(),
      refs: refs.map((r) => (seqRefs ? { runId: r.runId, seq: r.seq } : { runId: r.runId })),
      confidence: isStr(draft.confidence) ? draft.confidence : 'medium',
      status: 'active',
      counts: { confirmed: 0, refuted: 0 },
      lastValidated: 0,
    },
  }
}

/**
 * Create an in-memory library — pure data + ops, serializable to JSON.
 * Persistence (file, settings doc, plugin records) is the adapter's job.
 */
export function createLibrary(fromEntries = []) {
  const entries = [...fromEntries]

  return {
    entries,

    /**
     * Store an admitted entry bound to its position in the domain stream.
     * @param {object} entry result of admitLesson(...).entry
     * @param {object} opts {taskIndex:number} position of the producing task
     */
    add(entry, { taskIndex = 0 } = {}) {
      entries.push({ ...entry, taskIndex })
      return entry.id
    },

    get(id) { return entries.find((e) => e.id === id) ?? null },

    /**
     * Prefix rule: task i sees only lessons produced by tasks 1..i-1 in the
     * SAME domain, and only ones not refuted. Reproducibility contract —
     * a library state must be a pure function of task order.
     */
    selectFor({ domain, beforeTaskIndex = Infinity, includeStale = true } = {}) {
      return entries.filter((e) =>
        e.domain === domain &&
        e.taskIndex < beforeTaskIndex &&
        e.status !== 'refuted' &&
        (includeStale || e.status === 'active'),
      )
    },

    /**
     * Feedback on a lesson's prediction. 'refuted' flips status — the lesson
     * claimed something that hurt; it stops being served. 'confirmed'
     * increments and refreshes lastValidated (decay clock).
     */
    recordOutcome(id, outcome, { now = Date.now() } = {}) {
      const e = entries.find((x) => x.id === id)
      if (!e) return false
      if (outcome === 'refuted') {
        e.counts.refuted++
        e.status = 'refuted'
      } else if (outcome === 'confirmed') {
        e.counts.confirmed++
        e.lastValidated = now
        if (e.status === 'stale') e.status = 'active'
      } else {
        throw new Error(`outcome must be 'confirmed'|'refuted', got ${JSON.stringify(outcome)}`)
      }
      return true
    },

    /** Lessons not confirmed within ttl get marked 'stale' — still readable,
     *  flagged as unverified-by-time. Returns ids transitioned. */
    decay({ now = Date.now(), ttlMs } = {}) {
      if (!ttlMs) return []
      const stale = []
      for (const e of entries) {
        if (e.status === 'active' && e.lastValidated && now - e.lastValidated > ttlMs) {
          e.status = 'stale'
          stale.push(e.id)
        }
      }
      return stale
    },

    toJSON() { return { entries } },
  }
}

/** Rebuild a library from `toJSON()` output — statuses/counts sanitized. */
export function libraryFromJSON(data) {
  const list = isObj(data) && Array.isArray(data.entries) ? data.entries : []
  return createLibrary(list.map((e) => ({
    ...e,
    status: STATUSES.includes(e.status) ? e.status : 'active',
    counts: isObj(e.counts) ? { confirmed: e.counts.confirmed ?? 0, refuted: e.counts.refuted ?? 0 } : { confirmed: 0, refuted: 0 },
    refs: Array.isArray(e.refs) ? e.refs : [],
  })))
}

/** INDEX.md-style render: what an editor reads at propose-time. */
export function formatLessons(list) {
  if (!list.length) return '(no lessons yet)'
  return list.map((e, i) => {
    const refs = e.refs.map((r) => (r.seq !== undefined ? `${r.runId}#${r.seq}` : r.runId)).join(', ')
    const stale = e.status === 'stale' ? ' [stale — revalidate]' : ''
    return `${i + 1}. WHEN: ${e.cue}\n   DO: ${e.lesson}\n   evidence: ${refs} | conf=${e.confidence} | ✓${e.counts.confirmed} ✗${e.counts.refuted}${stale}`
  }).join('\n')
}
