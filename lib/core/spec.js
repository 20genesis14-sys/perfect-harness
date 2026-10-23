// Harness spec — the serializable editable surface, vendor-agnostic.
//
// A spec is DATA, not live registrations: the substrate's mount() turns it
// into whatever the host needs (prompt sections, tool restricts, preset
// docs, config files). Patch contract is omitted-is-inherited: a proposal
// emits only the fields it changes; `applyPatch` deep-merges, `null` deletes.
//
// Sections mirror what real harnesses expose; `extensions` is the escape
// hatch for host-only dimensions (DSH lazy policy, hook files) that must not
// leak into core semantics.

const MAP_SECTIONS = Object.freeze(['skills', 'agents', 'scripts', 'extensions'])
const OBJ_SECTIONS = Object.freeze(['prompt', 'tools', 'model'])
const LIST_FIELDS = Object.freeze(['keep', 'hide'])
const KNOWN_SECTIONS = Object.freeze([...OBJ_SECTIONS, ...MAP_SECTIONS, 'memory'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string'

/**
 * Validate + fill defaults. Unknown top-level keys are rejected (typos in a
 * spec are silent harness corruption); host-specific data goes under
 * `extensions`.
 * @param {unknown} raw
 * @returns {object} normalized spec (safe to serialize/diff/hash)
 */
export function normalizeSpec(raw) {
  const spec = raw === undefined || raw === null ? {} : raw
  if (!isObj(spec)) throw new Error(`spec must be an object, got ${typeof spec}`)
  const errs = []
  for (const k of Object.keys(spec)) {
    if (!KNOWN_SECTIONS.includes(k)) errs.push(`unknown section ${JSON.stringify(k)} — use extensions for host-only fields`)
  }

  const out = {}

  if (spec.prompt !== undefined) {
    if (!isObj(spec.prompt)) errs.push('prompt must be an object')
    else {
      const p = {}
      for (const f of ['systemAppend', 'persona', 'guidance']) {
        if (spec.prompt[f] !== undefined) {
          if (!isStr(spec.prompt[f])) errs.push(`prompt.${f} must be a string`)
          else p[f] = spec.prompt[f]
        }
      }
      out.prompt = p
    }
  }

  if (spec.tools !== undefined) {
    if (!isObj(spec.tools)) errs.push('tools must be an object')
    else {
      const t = {}
      for (const f of LIST_FIELDS) {
        if (spec.tools[f] !== undefined) {
          if (!Array.isArray(spec.tools[f]) || spec.tools[f].some((x) => !isStr(x))) {
            errs.push(`tools.${f} must be an array of tool names`)
          } else t[f] = [...spec.tools[f]]
        }
      }
      if (spec.tools.guidance !== undefined) {
        if (!isStr(spec.tools.guidance)) errs.push('tools.guidance must be a string')
        else t.guidance = spec.tools.guidance
      }
      if (spec.tools.policy !== undefined) {
        if (!isObj(spec.tools.policy)) errs.push('tools.policy must be an object')
        else t.policy = spec.tools.policy
      }
      out.tools = t
    }
  }

  if (spec.model !== undefined && spec.model !== null) {
    if (!isObj(spec.model)) errs.push('model must be an object or null')
    else {
      const m = {}
      for (const f of ['provider', 'model', 'effort']) {
        if (spec.model[f] !== undefined) {
          if (!isStr(spec.model[f])) errs.push(`model.${f} must be a string`)
          else m[f] = spec.model[f]
        }
      }
      out.model = m
    }
  }

  for (const sec of MAP_SECTIONS) {
    if (sec === 'extensions') continue
    if (spec[sec] !== undefined) {
      if (!isObj(spec[sec])) { errs.push(`${sec} must be an object name→entry`); continue }
      const m = {}
      for (const [name, entry] of Object.entries(spec[sec])) {
        if (sec === 'scripts') {
          if (!isStr(entry)) { errs.push(`scripts.${name} must be source text`); continue }
          m[name] = entry
        } else {
          if (!isObj(entry)) { errs.push(`${sec}.${name} must be an object`); continue }
          m[name] = { ...entry }
        }
      }
      out[sec] = m
    }
  }

  if (spec.memory !== undefined) {
    if (!isStr(spec.memory)) errs.push('memory must be a string')
    else out.memory = spec.memory
  }

  if (spec.extensions !== undefined) {
    if (!isObj(spec.extensions)) errs.push('extensions must be an object')
    else out.extensions = { ...spec.extensions }
  }

  if (errs.length) throw new Error(`invalid spec: ${errs.join('; ')}`)
  return out
}

/** Canonical key-sorted stringify — the basis for hashing and equality. */
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (isObj(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

/** FNV-1a 32-bit over canonical JSON. Equality-tag, not a security hash. */
export function specHash(spec) {
  const s = stableStringify(normalizeSpec(spec))
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return 'h_' + (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Leaf-paths a patch touches (dot-separated; map keys are path segments).
 * @param {object} patch
 * @returns {string[]} e.g. ['prompt.persona', 'skills.deploy']
 */
export function patchPaths(patch, prefix = '') {
  const out = []
  if (!isObj(patch)) return prefix ? [prefix] : out
  for (const [k, v] of Object.entries(patch)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (isObj(v)) out.push(...patchPaths(v, p))
    else out.push(p)
  }
  return out
}

const coveredBy = (path, pins) => pins.some((pin) => path === pin || path.startsWith(pin + '.'))

/**
 * Deep-merge a patch onto a base spec. Semantics:
 *   absent field      → inherited from base
 *   present value     → replaces (objects merge per-key, arrays replace)
 *   explicit null     → deletes that key/field
 * @param {object} base normalized spec
 * @param {object} patch partial spec (or nested patch object)
 * @param {object} [opts]
 * @param {string[]} [opts.pins] dot-paths the patch may not touch — the
 *   deployer's non-negotiable rows. Violations throw listing ALL offenders
 *   (the message is retry feedback for the proposer).
 * @returns {object} new normalized spec (base is not mutated)
 */
export function applyPatch(base, patch, { pins = [] } = {}) {
  const b = normalizeSpec(base)
  if (!isObj(patch)) throw new Error('patch must be an object (partial spec)')
  const bad = patchPaths(patch).filter((p) => coveredBy(p, pins))
  if (bad.length) {
    throw new Error(`patch touches pinned paths: ${bad.join(', ')} — these harness rows are not editable`)
  }
  const merged = mergeNode(b, patch, '')
  return normalizeSpec(merged)
}

function mergeNode(base, patch, path) {
  if (!isObj(patch)) return patch === undefined ? base : patch
  const out = isObj(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k] // null deletes at any level: map key, object field, whole section
    } else if (isObj(v) && isObj(out[k])) {
      out[k] = mergeNode(out[k], v, path ? `${path}.${k}` : k)
    } else if (Array.isArray(v)) {
      out[k] = [...v] // lists replace wholesale — add/remove is diff noise
    } else if (isObj(v)) {
      out[k] = mergeNode(undefined, v, path ? `${path}.${k}` : k)
    } else {
      out[k] = v
    }
  }
  return out
}

const leafDiff = (a, b, path, out) => {
  if (a === undefined && b === undefined) return
  if (JSON.stringify(a) === JSON.stringify(b)) return
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      leafDiff(a[k], b[k], path ? `${path}.${k}` : k, out)
    }
    return
  }
  const op = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'
  out.push({ path, op, from: a, to: b })
}

/**
 * Leaf-level diff of two specs — what the composer/reflector narrate.
 * @returns {{path, op:'added'|'removed'|'changed', from, to}[]}
 */
export function diffSpecs(a, b) {
  const out = []
  leafDiff(normalizeSpec(a), normalizeSpec(b), '', out)
  return out
}

/** One-line rendering of a diff for prompts/status. */
export function formatDiff(diffs) {
  if (!diffs.length) return '(no changes)'
  return diffs.map((d) => {
    const fmt = (v) => {
      const s = stableStringify(v)
      return s.length > 80 ? s.slice(0, 77) + '…' : s
    }
    if (d.op === 'added') return `+ ${d.path} = ${fmt(d.to)}`
    if (d.op === 'removed') return `- ${d.path} (was ${fmt(d.from)})`
    return `~ ${d.path}: ${fmt(d.from)} → ${fmt(d.to)}`
  }).join('\n')
}
