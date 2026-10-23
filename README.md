# perfect-harness

Vendor-agnostic **recursive agent harnessing** — the method from the
Harness² paper, rebuilt as a portable library: a pure method core plus
substrate adapters. No model calls, no host SDKs, no I/O in `lib/core/`.

> **⚠ Research project — read before running.**
>
> This is an experimental, test-stage implementation. It is **not**
> production software, and it is **not free to run**.
>
> Every improvement step makes *real model calls* on your configured
> provider: a base rollout, one rollout per proposed candidate, a refined
> rollout, a blind judge for every pair ×2 seat orders, a reflect pass —
> a single step can burn tens of thousands of tokens. A campaign
> multiplies that by task count.
>
> If you mount this into your own DSH profile (or any live host), the
> tokens it spends are **your tokens, at your provider's rates, entirely
> at your own risk and responsibility**. There is no cost cap built in —
> `stats.costUsd` reports what already happened, it does not prevent it.
>
> Verified against DSH `0.2.1-rc.2` (a developer preview — host APIs can
> change between releases). See `docs/RECON-DSH.md` for what was actually
> verified and `docs/ARCHITECTURE.md` for internals.

## In plain words

An AI agent is more than a model. Around it sits a "harness": the system
prompt, the tools it may call, its memory, its skills, the rules of the
loop. Most agents stay exactly as they were first configured.

This library lets the harness **improve itself from experience**. After a
task it proposes small concrete edits ("add this tool", "rewrite this prompt
section"), tries candidates on the same task, compares their behavior — and
keeps only what actually helped. A human gate decides what gets adopted;
nothing mutates silently. Lessons learned are stored with links to the exact
runs that prove them.

It is deliberately host-free: the improvement logic is pure code, and each
agent framework (DeepSeek Harness, Claude Code, a mock for tests) plugs in
through a small adapter contract. If a host cannot do something — fork a
session, route a judge to a different model — the library degrades honestly
instead of pretending.

## The method

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

## DSH adapter (`lib/adapters/dsh/`)

The DeepSeek Harness substrate, verified against `0.2.1-rc.2` types and a
live profile (see `docs/RECON-DSH.md`). All seven capability flags map to
real seams:

```js
import { createDshSubstrate } from 'perfect-harness'

const substrate = createDshSubstrate({
  ctx,   // host Cordis ctx (inside a plugin/agent)
  deps: { buildForkSeed, appendPluginRecord, createUserMessage }, // optional
})
const handle = await substrate.mount(spec)   // agents.create + setup callback
const evidence = await substrate.run(handle, task)
await substrate.dispose(handle)
```

| spec field | DSH materialization |
| --- | --- |
| `prompt.persona` | `ph:persona` section, order 0 (persona prefix layer) |
| `prompt.guidance` / `systemAppend` | `ph:guidance` (700) / `ph:system-append` (10300) |
| `tools.keep` / `hide` | `tools.restrict({allow})` / `({deny})` — unknown names noted, never thrown |
| `tools.guidance` | `ph:tool-guidance` (3200) |
| `model` | `agentOptions {provider, model, reasoningEffort}` at create |
| `memory` | `ph:memory` (300) |
| `skills`/`agents`/`scripts`/`presets` | `agentPresets.register` temp preset = cloned base rows + spec rows; `scripts.*` sources materialize to `file://` `.mjs` rows |

Beyond the in-process substrate there is a **process substrate**
(`lib/adapters/dsh/proc.js`): every rollout spawns real `dsh headless
--json` — true OS-process isolation, NDJSON → Evidence, immune to the
in-process teardown race. `pricing.js` turns real token splits into
`costUsd` per route (OpenRouter rates; unpriced routes stay `0`, never
guessed). `gate.js` wires `gate.confirm` to the desktop
`userQuestions.ask` waterfall — `plugins/ph-dsh/` is the mountable plugin
exposing `/ph status | step | lessons` on a desktop profile.

`run` sends the task as a `next-turn` user message, waits `whenIdle` (wall
clock bounded), and rebuilds `Evidence` from `session.snapshotEvents()` —
the committed log is authoritative; `seq`s survive into lesson refs. A
timeout cancels the agent and reports `outcome: 'timeout'`; a bounded drain
follows so a stuck agent cannot hang the loop.

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

`npm test` — 106 tests. Core + mock adapter + DSH adapter (in-process and
external-process) done and live-verified on a real headless profile —
every capability flag exercised on the wire, real PTC dispatch events
mapped, lessons persisted across processes, a full gated improvement
step adopted a candidate live. See `AGENTS.md` for the working contract,
`docs/ARCHITECTURE.md` for internals, and `docs/RECON-DSH.md` for the
empirical seam inventory (the source of truth about the host).
