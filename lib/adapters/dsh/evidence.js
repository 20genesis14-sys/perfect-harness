// Session events → canonical Evidence — PURE, no DSH imports.
//
// Consumes SessionEvent entries exactly as the host commits them
// (@deepseek-ai/dsh-session types.d.ts, SessionEventMap — verified, not
// guessed): every event is {type, seq, time, data}, seq is a NON-NEGATIVE
// SessionSeq starting at 0. Steps keep the event's own seq verbatim —
// lesson refs runId+seq resolve against the host's committed log, which is
// the provenance contract.
//
// Mapping (payload field names are the REAL SessionEventMap members):
//   tool/call  {callId,name,arguments:string}     → action
//   tool/result {message:{toolCallId,content,isError},error?,meta?} → observation|error
//   tool/ptc-dispatch-start / tool/ptc-dispatch   → action | observation|error
//   assistant/attempt {stream}                    → error (settled w/o message)
//   user/message (payload IS the UserMessage)     → correction (source.kind
//     'user', first one = the task itself, skipped)
//   assistant/message {message,stream,usage?,interrupted?} → finalText + tokens
//   tool/call args parsing to {path,content}      → deliverable.files entry
//   turn/end {reason:{kind}}                      → outcome
// Everything else (request/header, jobs, compaction, workspace/*, seeds)
// is provenance the trajectory doesn't narrate — skipped, not lost: the
// host log still holds it.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'

const ARG_CLIP = 400
const TEXT_CLIP = 50_000 // matches core DEFAULT_OBS_TRUNC

const clip = (t, n) => (typeof t === 'string' && t.length > n ? t.slice(0, n) + `…[+${t.length - n}]` : t)

const textOf = (content) =>
  Array.isArray(content)
    ? content.filter((b) => isObj(b) && b.type === 'text' && isStr(b.text)).map((b) => b.text).join('\n')
    : isStr(content) ? content : ''

/** arguments is the raw JSON string the model emitted — clip for the step,
 * parse best-effort for artifact extraction. */
const argText = (args) => {
  if (args === undefined || args === null) return undefined
  const s = isStr(args) ? args : JSON.stringify(args)
  return s === undefined ? undefined : clip(s, ARG_CLIP)
}

const parseArgs = (args) => {
  if (isObj(args)) return args
  if (!isStr(args)) return null
  try { const v = JSON.parse(args); return isObj(v) ? v : null } catch { return null }
}

/** Tool calls that carry a written artifact in their arguments. */
const fileFromCall = (name, args) => {
  const a = parseArgs(args)
  if (!a) return null
  const path = a.path ?? a.file ?? a.filename
  const content = a.content ?? a.text ?? a.source
  if (!isStr(path) || !isStr(content)) return null
  if (!/write|create|edit|save/i.test(name)) return null
  return { path, content }
}

/** TurnEndReason is an object {kind: 'completed'|'aborted'|'error'|…}, not a string. */
const REASON_OUTCOME = Object.freeze({
  completed: 'ok',
  aborted: 'aborted',
  error: 'error',
  interrupted: 'error', // crash-orphaned closer
  blocked: 'error',
  'max-tokens': 'error', // hit the output ceiling — not a clean finish
  forked: 'ok', // seed closer — never appears in own events
})

/**
 * Build an Evidence-shaped object from this session's own events.
 * Caller feeds only ownEvents — inherited seed prefix never reaches here.
 * Output is raw input for core's normalizeEvidence (it re-validates).
 *
 * @param {object[]} events committed SessionEvents, seq-ordered
 * @param {object} meta {runId, specHash, task:{id,domain,prompt}}
 * @returns {object} raw evidence
 */
export function evidenceFromEvents(events, meta) {
  const list = Array.isArray(events) ? events : []
  const steps = []
  const callNames = new Map()   // callId → tool name (results pair by toolCallId)
  const files = {}
  let finalText = ''
  let tokens = 0
  let toolCalls = 0
  let sawTaskMessage = false
  let outcome = null
  let firstTime = null
  let lastTime = null

  const push = (event, kind, fields) => {
    const seq = Number(event && event.seq)
    if (!Number.isInteger(seq) || seq < 0) return // events without seq can't anchor lessons
    steps.push({ seq, kind, ...fields })
  }

  for (const e of list) {
    if (!isObj(e)) continue
    if (typeof e.time === 'number') {
      if (firstTime === null) firstTime = e.time
      lastTime = e.time
    }
    const p = isObj(e.data) ? e.data : {}
    switch (e.type) {
      case 'tool/call': {
        const name = isStr(p.name) ? p.name : 'tool'
        if (p.callId !== undefined) callNames.set(p.callId, name)
        toolCalls++
        push(e, 'action', { tool: name, input: argText(p.arguments) })
        const f = fileFromCall(name, p.arguments)
        if (f) files[f.path] = f.content
        break
      }
      case 'tool/result': {
        const msg = isObj(p.message) ? p.message : {}
        const name = callNames.get(msg.toolCallId) ?? 'tool'
        let text = textOf(msg.content)
        if (msg.isError && isObj(p.error) && isStr(p.error.reason)) {
          text = (text ? text + '\n' : '') + `[${p.error.code ?? 'ERR'}: ${p.error.reason}]`
        }
        push(e, msg.isError ? 'error' : 'observation', { tool: name, text: clip(text, TEXT_CLIP) })
        break
      }
      case 'tool/ptc-dispatch-start': {
        const name = isStr(p.name) ? p.name : 'tool'
        toolCalls++
        push(e, 'action', { tool: name, input: argText(p.arguments), summary: 'ptc in-process' })
        const f = fileFromCall(name, p.arguments)
        if (f) files[f.path] = f.content
        break
      }
      case 'tool/ptc-dispatch': {
        // Real payload (dsh-tools/types/ptc.js): {rootCallId, parentCallId,
        // subCallId, name, arguments, isError, error?, content, meta?} —
        // content carries the result text; error is an object with info.
        const name = isStr(p.name) ? p.name : 'tool'
        let text = clip(textOf(p.content), TEXT_CLIP)
        if (p.isError === true && isObj(p.error)) {
          const reason = isStr(p.error.reason) ? p.error.reason : isStr(p.error.message) ? p.error.message : ''
          if (reason) text = (text ? text + '\n' : '') + `[${p.error.code ?? 'ERR'}: ${reason}]`
        }
        push(e, p.isError === true ? 'error' : 'observation', { tool: name, text, summary: 'ptc result' })
        break
      }
      case 'assistant/attempt': {
        // Settled without a surface message — stream preserved by the host,
        // the trajectory needs only that the attempt failed.
        push(e, 'error', { text: `model attempt settled without a message (turn ${p.turn ?? '?'}, step ${p.step ?? '?'})` })
        break
      }
      case 'assistant/message': {
        const msg = isObj(p.message) ? p.message : {}
        const text = textOf(msg.content)
        if (text.trim()) finalText = text // last assistant text is the deliverable
        const u = isObj(p.usage) ? p.usage : null
        if (u) {
          // inputTokens/cacheReadTokens/cacheWriteTokens are DISJOINT counts.
          tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
        }
        break
      }
      case 'user/message': {
        // Payload IS the UserMessage — source.kind separates real human input
        // from agent.inject() runtime context and goal continuations.
        const kind = isObj(p.source) && isStr(p.source.kind) ? p.source.kind : ''
        if (kind !== 'user') break
        if (!sawTaskMessage) { sawTaskMessage = true; break } // first user message IS the task
        push(e, 'correction', { text: clip(textOf(p.content), TEXT_CLIP) })
        break
      }
      case 'turn/end': {
        const kind = isObj(p.reason) && isStr(p.reason.kind) ? p.reason.kind : ''
        outcome = REASON_OUTCOME[kind] ?? (kind ? 'error' : 'ok')
        break
      }
      default:
        break // provenance events don't narrate steps
    }
  }

  const wallS = firstTime !== null && lastTime !== null ? Math.max(0, (lastTime - firstTime) / 1000) : 0
  const delivered = finalText.trim().length > 0 || Object.keys(files).length > 0

  return {
    runId: meta.runId,
    specHash: meta.specHash,
    task: { id: meta.task.id, domain: meta.task.domain ?? '_', prompt: meta.task.prompt },
    steps,
    deliverable: { delivered, finalText, files },
    outcome: outcome ?? (steps.some((s) => s.kind === 'error') ? 'error' : 'ok'),
    stats: {
      steps: steps.length,
      toolCalls,
      tokens,
      wallS: +wallS.toFixed(2),
      costUsd: 0, // priced outside the adapter — usage is kept, not monetized
    },
  }
}
