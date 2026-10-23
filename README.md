# perfect-harness

Vendor-agnostic **recursive agent harnessing** — the method from the
Harness² paper, rebuilt as a portable library: a pure method core plus
substrate adapters. No model calls, no host SDKs, no I/O in `lib/core/`.

A **harness** is everything around the model: prompts, tools, memory, skills,
orchestration. This library improves that system without touching weights:

```
base rollout → propose edits → probe candidates → compose refined spec
             → blind selection (base always in pool) → gate → reflect → lesson
```

## Three axes, not two

| Axis | Contents | Lives in |
| --- | --- | --- |
| **method core** | evidence model, spec diffs+pins, capability matrix, lessons library, selection, PPC loop | `lib/core/` (pure) |
| **substrate adapter** | `capabilities()`, `mount(spec)`, `run(handle, task)`, `dispose(handle)` | `lib/adapters/` (per host) |
| **task/verdict adapter** | where tasks come from, what counts as deliverable, who judges | your deployment |

The mock adapter (`lib/adapters/mock.js`) is the seam proof: it runs the full
loop with every capability flag off and no model — if the core works against
that, a real substrate is a mapping exercise.

## Canonical evidence model

One `Evidence` per rollout; adapters produce it, the core only reads it:

```js
{
  runId, specHash,
  task: { id, domain, prompt },          // work only — never criteria
  steps: [{ seq, kind, tool?, input?, text? }],   // kind: action|observation|error|correction
  deliverable: { delivered, finalText, files: {name: text} },
  outcome: 'ok' | 'error' | 'timeout' | 'aborted',
  stats: { steps, toolCalls, tokens, wallS, costUsd },
}
```

Hard rules enforced by `normalizeEvidence`: **no verdict fields anywhere**
(`score`, `rubric`, `passed`, `judge`…), strictly increasing unique `seq`s
(lessons cite `runId`+`seq`), prompt describes work not measurement.
`formatTrajectory` renders the shared `[ACTION]/[OBS]/[ERR]/[CORR]` grammar;
`contrastEvidences` produces the behavioral diff compose/select reason over.

## Harness spec

Serializable editable surface: `prompt`, `tools`, `skills`, `agents`,
`scripts`, `memory`, `model`, `extensions` (host escape hatch).
`applyPatch(base, patch, {pins})`: absent = inherited, `null` = delete,
pinned paths reject with all offenders listed (retry feedback for proposers).

## Capability matrix

```js
resolveCapabilities(caps) // → {flags, mode, lines}
```

| flag | unlocks | degradation when false |
| --- | --- | --- |
| `isolatedMount` | live probes | retrospective analysis only |
| `seededFork` | forked probes from shared prefix | rerun task from scratch |
| `modelRouting` | independent selector channel | same model + human-required gate |
| `liveRestrict` | live tool-policy edits | apply to new sessions only |
| `structuredLog` | `runId#seq` lesson refs | `runId`-only refs |
| `logRecords` | lessons inside the run log | file beside the runs |
| `userSignal` | auto `correction` steps | manual marking |

All-false still works: read evidence → propose patch → human decides.

## Lessons

`admitLesson` requires every `{runId, seq}` ref to **resolve against real
evidence** (in Harness² this was prompt-level; here it is code). Prefix rule:
task *i* reads only same-domain entries from tasks *< i*. `recordOutcome`
marks `confirmed`/`refuted`; refuted lessons stop being served. `decay` flags
unrevalidated lessons as `stale`.

## Selection

Blind pairwise tournament: judge sees deliverable text only (no labels, no
spec hashes); every pair judged twice with swapped seats — order-flipping
verdicts count as `split`, and any `split` flags `inconsistent` confidence,
which forces the human gate.

## Quick start (mock, no model)

```js
import { runImprovementStep, createMockSubstrate, createScriptedChannels } from 'perfect-harness'

const substrate = createMockSubstrate({ capabilities: { isolatedMount: true, modelRouting: true } })
const channels = createScriptedChannels({
  proposals: [{ kind: 'domain', description: 'enable web', patch: { tools: { keep: ['fs', 'web'] } } }],
  composed: { tools: { keep: ['fs', 'web', 'write'] } },
  judge: (a, b) => 'tie',
})
const result = await runImprovementStep({ task, baseSpec, substrate, channels, gate })
// → { ok, improved, adoptedSpec, adoptedLabel, lesson, notes, trail, mode }
```

## Status

`npm test` — 54 tests. Core + mock adapter done; real substrates (DSH next)
plug into the same seam. See `AGENTS.md` for the working contract.
