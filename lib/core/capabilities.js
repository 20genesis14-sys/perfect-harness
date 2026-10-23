// Capability matrix — feature detection, not brand detection.
//
// Each substrate reports boolean flags; `resolveCapabilities` maps them to a
// degradation mode. The method runs at EVERY capability level — zero flags
// still gives read-evidence → propose → human-gate. Each `true` flag
// automates one more step of the cycle. Honest status lines, never crashes.

export const CAPABILITY_FLAGS = Object.freeze([
  'isolatedMount',  // mount an agent under its own spec, apart from live ones
  'seededFork',     // branch a run from a shared event prefix
  'modelRouting',   // pick provider/model per mounted instance
  'liveRestrict',   // change tool policy on a live agent
  'structuredLog',  // typed events with seqs → precise step refs
  'logRecords',     // write custom records into the run log
  'userSignal',     // observe user interrupts/corrections as events
])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Normalize raw flags + derive the operating mode.
 * @param {object} [caps] raw flag map; missing key = false
 * @returns {{flags:object, mode:object, lines:string[]}}
 */
export function resolveCapabilities(caps = {}) {
  const raw = isObj(caps) ? caps : {}
  const flags = {}
  for (const f of CAPABILITY_FLAGS) flags[f] = raw[f] === true

  const mode = {
    // Live probes need an isolated mount; forked probes reuse a shared
    // prefix (cheaper + perfectly matched context); else rerun from scratch.
    probes: !flags.isolatedMount ? 'offline' : flags.seededFork ? 'fork' : 'rerun',
    // A routed selector is a different model; 'fresh' is same model, clean
    // context — weaker, and the gate tightens to compensate.
    selectorChannel: flags.modelRouting ? 'routed' : 'fresh',
    // Without an independent channel the only honest adoption gate is a human.
    adoptionGate: flags.modelRouting ? 'auto-allowed' : 'human-required',
    lessonStore: flags.logRecords ? 'log' : 'file',
    corrections: flags.userSignal ? 'auto' : 'manual',
    refs: flags.structuredLog ? 'seq' : 'runId',
    toolPolicy: flags.liveRestrict ? 'live' : 'next-session',
  }

  const lines = [
    `probes: ${mode.probes}` + (mode.probes === 'offline' ? ' (no isolated mount — retrospective analysis only)' : ''),
    `selector: ${mode.selectorChannel}` + (mode.selectorChannel === 'fresh' ? ' (same-model context — adoption needs human confirm)' : ''),
    `gate: ${mode.adoptionGate}`,
    `lessons: ${mode.lessonStore}, refs: ${mode.refs}, corrections: ${mode.corrections}, toolPolicy: ${mode.toolPolicy}`,
  ]
  if (!flags.isolatedMount && !flags.structuredLog && !flags.userSignal) {
    lines.push('minimal mode: reads supplied Evidence, proposes patches, human decides')
  }
  return { flags, mode, lines }
}

/** Required flags for a feature — adapters/tests assert support before use. */
export const FEATURE_REQUIRES = Object.freeze({
  liveProbes: ['isolatedMount'],
  forkProbes: ['isolatedMount', 'seededFork'],
  routedSelector: ['modelRouting'],
  autoCorrections: ['userSignal'],
  seqRefs: ['structuredLog'],
  logLessons: ['logRecords'],
})

/**
 * Whether every required capability for a feature is present.
 * @param {object} resolved result of resolveCapabilities (or a raw flag map)
 * @param {string} feature key of FEATURE_REQUIRES
 */
export function supports(resolved, feature) {
  const flags = resolved && resolved.flags ? resolved.flags : resolved ?? {}
  const req = FEATURE_REQUIRES[feature]
  if (!req) return false
  return req.every((f) => flags[f] === true)
}
