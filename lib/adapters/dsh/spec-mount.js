// spec → mount plan — PURE, no DSH imports.
//
// The plan is data the executor (index.js) replays inside the agent's
// `setup` callback, where every registration exists before `agent/created`
// and the first prompt assembly. Orders come from dsh-system-prompt's
// SECTION_ORDERS: persona prefix 0, persona suffix 10200 — ours sit beside
// the deployment layers without colliding.
//
// Order map (upstream constants in parens):
//   ph:memory          300   (before PLAN_POLICY 500)
//   ph:guidance        700   (TEAM_POLICY 600 → PTC_ONLY 800)
//   ph:persona         0     (DEPLOYMENT_PERSONA_PREFIX — own-scope shadow)
//   ph:tool-guidance   3200  (after MCP_SERVERS 3100, before TOOLS_SDK 5000)
//   ph:system-append   10300 (after DEPLOYMENT_PERSONA_SUFFIX 10200 — tail)

export const PH_ORDERS = Object.freeze({
  persona: 0,
  memory: 300,
  guidance: 700,
  'tool-guidance': 3200,
  'system-append': 10300,
})

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.length > 0

/**
 * Build the mount plan for one spec.
 * @param {object} spec normalized harness spec (core/spec.js output)
 * @param {object} [opts]
 * @param {string[]} [opts.toolUniverse] tool names currently visible to the
 *   mounting scope — `keep`/`hide` are validated against it because
 *   `tools.restrict` throws naming offenders. Pass [] to skip validation
 *   (the executor reports restrict failures per-tool instead).
 * @returns {{
 *   sections: {name:string,order:number,text:string,interpolate:boolean}[],
 *   restrict: {allow?:string[], deny?:string[]},
 *   agentOptions: {provider?:string,model?:string,reasoningEffort?:string},
 *   unmounted: string[],
 *   notes: string[],
 * }}
 */
export function planMount(spec, { toolUniverse = null } = {}) {
  const s = isObj(spec) ? spec : {}
  const notes = []
  const unmounted = []
  const sections = []

  const sec = (name, text) => {
    if (isStr(text) && text.trim()) {
      sections.push({ name: `ph:${name}`, order: PH_ORDERS[name], text, interpolate: false })
    }
  }

  const prompt = isObj(s.prompt) ? s.prompt : {}
  sec('persona', prompt.persona)
  sec('guidance', prompt.guidance)
  sec('system-append', prompt.systemAppend)
  sec('memory', s.memory)
  const tools = isObj(s.tools) ? s.tools : {}
  if (isStr(tools.guidance) && tools.guidance.trim()) {
    sections.push({ name: 'ph:tool-guidance', order: PH_ORDERS['tool-guidance'], text: tools.guidance, interpolate: false })
  }

  // ── tool policy ──────────────────────────────────────────────────────────
  // keep = whitelist (restrict allow); hide = blacklist (restrict deny).
  // Both present → allow = keep − hide. Names outside the universe are noted,
  // never passed to restrict (it throws naming the offender).
  const keep = Array.isArray(tools.keep) ? tools.keep : null
  const hide = Array.isArray(tools.hide) ? tools.hide : null
  const restrict = {}
  const known = new Set(Array.isArray(toolUniverse) ? toolUniverse : [])
  const validate = (names, field) => names.filter((n) => {
    if (known.size === 0 || known.has(n)) return true
    notes.push(`tools.${field}: "${n}" not in visible universe — skipped (restrict would throw)`)
    return false
  })
  if (keep && keep.length) {
    const allow = validate(keep, 'keep').filter((n) => !(hide && hide.includes(n)))
    if (allow.length) restrict.allow = allow
    else notes.push('tools.keep resolved to empty — no allow restriction applied (would fail as empty filter)')
  }
  if (hide && hide.length) {
    // Always validated (unknown names still land in notes); a whitelist
    // already excludes everything else, so deny applies only without allow.
    const deny = validate(hide, 'hide')
    if (deny.length && !restrict.allow) restrict.deny = deny
  }

  // ── model ────────────────────────────────────────────────────────────────
  const agentOptions = {}
  const model = isObj(s.model) ? s.model : {}
  if (isStr(model.provider)) agentOptions.provider = model.provider
  if (isStr(model.model)) agentOptions.model = model.model
  if (isStr(model.effort)) agentOptions.reasoningEffort = model.effort

  if (isObj(tools.policy) && Object.keys(tools.policy).length) {
    notes.push('tools.policy: opinionated guard config — no DSH seam yet (guards are host-managed), skipped')
  }

  // ── what setup cannot mount (honest) ─────────────────────────────────────
  for (const field of ['skills', 'agents', 'scripts']) {
    if (isObj(s[field]) && Object.keys(s[field]).length) {
      unmounted.push(field)
      notes.push(`${field}: ${Object.keys(s[field]).length} entries — requires the preset path (agentPresets.register + agentPreset meta), setup mount skips them`)
    }
  }
  if (isObj(s.extensions) && Object.keys(s.extensions).length) {
    notes.push(`extensions: ${Object.keys(s.extensions).length} entries — host-specific rows are left to the caller`)
  }

  return { sections, restrict, agentOptions, unmounted, notes }
}

/** One-line plan summary for status/logs. */
export function describePlan(plan) {
  const r = plan.restrict
  const pol = r.allow ? `allow=${r.allow.length}` : r.deny ? `deny=${r.deny.length}` : 'unrestricted'
  const m = plan.agentOptions
  const route = m.provider || m.model ? ` ${m.provider ?? '?'}/${m.model ?? '?'}` : ''
  return `sections=${plan.sections.length} tools:${pol}${route}` +
    (plan.unmounted.length ? ` unmounted:${plan.unmounted.join(',')}` : '')
}
