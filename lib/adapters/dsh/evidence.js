// Session events → canonical Evidence — PURE, no DSH imports.
//
// Consumes the host's SessionEventMap entries (shape from @deepseek-ai/
// dsh-session index.d.ts, verified against a real 1005-event session log).
// Every step keeps the event's own `seq` — lesson refs runId+seq resolve
// against the host's committed log, which is the provenance contract.
//
// Mapping:
//   tool/call                     → action   (tool=name, input=arguments)
//   tool/result                   → observation | error (isError)
//   tool/ptc-dispatch-start       → action   (in-process tool call)
//   tool/ptc-dispatch             → observation | error (status)
//   assistant/attempt             → error    (failed model request)
//   user/message kind 'user'      → correction (first one is the task — skipped)
//   assistant/message             → finalText + usage accumulation
//   tool/call with {path,content} args → deliverable.files entry
//   turn/end reason               → outcome
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

const argText = (args) => {
  if (args === undefined || args === null) return undefined
  const s = isStr(args) ? args : JSON.stringify(args)
  return s === undefined ? undefined : clip(s, ARG_CLIP)
}

/** Tool calls that carry a written artifact in their arguments. */
const fileFromCall = (name, args) => {
  if (!isObj(args)) return null
  const path = args.path ?? args.file ?? args.filename
  const content = args.content ?? args.text ?? args.source
  if (!isStr(path) || !isStr(content)) return null
  if (!/write|create|edit|save/i.test(name)) return null
  return { path, content }
}

/**
 * Build an Evidence-shaped object from this session's own events.
 * Caller feeds only ownEvents — inherited seed prefix never reaches here.
 * Output is raw input for core's normalizeEvidence (it re-validates).
 *
 * @param {object[]} events committed events, seq-ordered (session.ownEvents order)
 * @param {object} meta {runId, specHash, task:{id,domain,prompt}}
 * @returns {object} raw evidence
 */
export function evidenceFromEvents(events, meta) {
  const list = Array.isArray(events) ? events : []
  const steps = []
  const callNames = new Map()   // callId → tool name (results pair by callId)
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
    if (!Number.isInteger(seq) || seq < 1) return // events without seq can't anchor lessons
    steps.push({ seq, kind, ...fields })
  }

  for (const e of list) {
    if (!isObj(e)) continue
    if (typeof e.time === 'number') {
      if (firstTime === null) firstTime = e.time
      lastTime = e.time
    }
    const p = isObj(e.payload) ? e.payload : {}
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
        const name = callNames.get(p.callId) ?? 'tool'
        const text = clip(textOf(p.content), TEXT_CLIP)
        push(e, p.isError ? 'error' : 'observation', { tool: name, text })
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
        const st = isStr(p.status) ? p.status : ''
        const text = clip(isStr(p.output) ? p.output : isStr(p.error) ? p.error : isStr(p.reason) ? p.reason : st, TEXT_CLIP)
        push(e, st === 'error' ? 'error' : 'observation', { text, summary: 'ptc result' })
        break
      }
      case 'assistant/attempt': {
        push(e, 'error', { text: clip(`model attempt failed (${isStr(p.reason) ? p.reason : 'unknown'})${isStr(p.error) ? ': ' + p.error : ''}`, 1000) })
        break
      }
      case 'assistant/message': {
        const msg = isObj(p.message) ? p.message : p
        const text = textOf(msg.content)
        if (text.trim()) finalText = text // last assistant text is the deliverable
        const u = isObj(p.usage) ? p.usage : isObj(msg.usage) ? msg.usage : null
        if (u) {
          tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadTokens ?? 0)
        }
        break
      }
      case 'user/message': {
        const src = isObj(p.message) && isObj(p.message.source) ? p.message.source : {}
        const kind = isStr(src.kind) ? src.kind : ''
        if (kind !== 'user') break // runtime/agent-instructions injections aren't user edits
        if (!sawTaskMessage) { sawTaskMessage = true; break } // first user message IS the task
        push(e, 'correction', { text: clip(textOf(isObj(p.message) ? p.message.content : ''), TEXT_CLIP) })
        break
      }
      case 'turn/end': {
        const r = isStr(p.reason) ? p.reason : ''
        outcome = r === 'aborted' ? 'aborted' : r === 'error' ? 'error' : 'ok'
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
