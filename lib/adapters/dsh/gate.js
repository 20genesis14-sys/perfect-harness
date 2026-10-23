// Human gate over the real DSH user-questions seam (ctx.userQuestions.ask).
// Verified from dsh-user-questions/lib/index.js source: ask() routes through
// the `user-questions/request` Cordis waterfall, which a UI answerer (desktop)
// resolves with the human's actual choice. ask() WITHOUT an agent hits the
// global waterfall — passing a mounted probe agent would throw
// DELEGATED_CALLER (only the exact live runtime root may carry agent).
// No answerer → UserQuestionError NO_PROVIDER → we return false: a gate the
// human can't see keeps base (the safe side of every human-required path).

const isObj = (v) => v !== null && typeof v === 'object'

/**
 * @param {object} args
 * @param {object} args.ctx host plugin ctx (ctx.get('userQuestions'))
 * @param {string[]} [args.notes] sink for degradation notes
 * @returns {{confirm: (summary) => Promise<boolean>}}
 */
export function createDshHumanGate({ ctx, notes } = {}) {
  const say = (m) => { if (Array.isArray(notes)) notes.push(m) }
  return {
    /** summary: {label, reason, confidence, specDiff} → true iff human approves. */
    async confirm(summary) {
      const svc = ctx?.get?.('userQuestions')
      if (!isObj(svc) || typeof svc.ask !== 'function') {
        say('gate: no userQuestions service on this profile — treating as declined')
        return false
      }
      const s = isObj(summary) ? summary : {}
      const answers = await svc.ask({
        questions: [{
          id: 'ph-gate',
          header: 'Harness adoption gate',
          question: `Adopt ${s.label ?? 'candidate'}?\n\nJudge: ${s.reason ?? 'n/a'} (confidence ${s.confidence ?? 'n/a'})\n\nSpec diff vs base:\n${s.specDiff ?? '(none)'}`,
          options: [
            { label: 'Keep base', description: 'Safe default — the candidate is not adopted' },
            { label: 'Adopt', description: `Adopt ${s.label ?? 'candidate'} as the new harness spec` },
          ],
        }],
      }).catch((e) => {
        // NO_PROVIDER (no UI answerer), ASK_ABORTED, CALLER_NOT_LIVE — every
        // failure degrades to declined, never crashes the loop.
        say(`gate: ask failed (${e?.code ?? e?.name ?? 'error'}: ${String(e?.message ?? e).slice(0, 140)}) — treating as declined`)
        return null
      })
      const first = answers?.answers?.find?.((a) => a.id === 'ph-gate') ?? answers?.answers?.[0]
      const picked = first?.selected?.[0] ?? first?.custom ?? ''
      return picked === 'Adopt'
    },
  }
}
