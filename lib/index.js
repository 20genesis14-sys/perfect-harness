// perfect-harness — method core + adapters. Wiring only, no logic here.

export {
  normalizeEvidence,
  findVerdictLeaks,
  taskLeakTokens,
  formatTrajectory,
  formatDeliverable,
  contrastEvidences,
  formatContrast,
} from './core/evidence.js'

export {
  normalizeSpec,
  stableStringify,
  specHash,
  patchPaths,
  applyPatch,
  diffSpecs,
  formatDiff,
} from './core/spec.js'

export {
  CAPABILITY_FLAGS,
  FEATURE_REQUIRES,
  resolveCapabilities,
  supports,
} from './core/capabilities.js'

export {
  admitLesson,
  createLibrary,
  libraryFromJSON,
  formatLessons,
} from './core/lessons.js'

export { selectAdoption } from './core/selection.js'

export { runImprovementStep } from './core/loop.js'

export { createMockSubstrate, createScriptedChannels } from './adapters/mock.js'
